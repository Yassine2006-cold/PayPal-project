'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { computeShares } = require('./split');

// Minimal .env loader (no dependencies). Tolerates a UTF-8 BOM, UTF-16 files
// (what some Windows editors and `echo > .env` produce), "export KEY=..." and quotes.
const ENV_PATH = path.join(__dirname, '.env');
let envFound = false;
try {
  const buf = fs.readFileSync(ENV_PATH);
  envFound = true;
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  text = text.replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PP_BASE = 'https://api-m.sandbox.paypal.com'; // sandbox only
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

const bills = new Map(); // id -> bill (in memory; fine for a demo)

// ---------- helpers ----------
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const cents = (x) => Math.max(0, Math.round(Number(x) * 100) || 0);
const fmt = (c, cur) => `${(c / 100).toFixed(2)} ${cur}`;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

// ---------- PayPal (sandbox) ----------
let tokenCache = { value: null, exp: 0 };
async function ppToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw Object.assign(new Error('PayPal credentials missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'), { status: 500 });
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error('PayPal auth failed: ' + (j.error_description || r.status)), { status: 502 });
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function ppCall(method, p, body, extraHeaders = {}) {
  const r = await fetch(PP_BASE + p, {
    method,
    headers: { Authorization: `Bearer ${await ppToken()}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

async function createOrder(bill, personIdx) {
  const person = bill.people[personIdx];
  const { ok, json } = await ppCall(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `${bill.id}-${personIdx}`,
          custom_id: bill.id,
          description: clean(`${bill.title} - ${person.name}'s share`, 120),
          amount: { currency_code: bill.currency, value: (person.totalCents / 100).toFixed(2) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'SplitSnap',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${BASE_URL}/return?bill=${bill.id}`,
            cancel_url: `${BASE_URL}/?bill=${bill.id}`,
          },
        },
      },
    },
    { 'PayPal-Request-Id': `${bill.id}-${personIdx}` }
  );
  if (!ok) throw Object.assign(new Error('PayPal order failed: ' + (json.message || JSON.stringify(json.details || json))), { status: 502 });
  const link = (json.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { orderId: json.id, payUrl: link && link.href };
}

// ---------- AI receipt parsing (Google Gemini vision, free tier) ----------
const SAMPLE = {
  demo: true,
  merchant: 'Demo Trattoria',
  currency: 'EUR',
  items: [
    { name: 'Margherita pizza', qty: 1, price: 11.5 },
    { name: 'Diavola pizza', qty: 1, price: 13 },
    { name: 'Tiramisu', qty: 2, price: 6.5 },
    { name: 'House red (bottle)', qty: 1, price: 22 },
  ],
  tax: 0,
  tip: 6,
};

async function parseReceipt(dataUrl, sample) {
  if (sample) return SAMPLE;
  if (!process.env.GEMINI_API_KEY)
    throw Object.assign(new Error('Receipt scanning needs a free Gemini key. Add GEMINI_API_KEY to the .env file next to server.js, then stop and restart the app (npm start).'), { status: 400 });
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('Please upload a JPEG, PNG, WebP or GIF image.'), { status: 400 });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: m[1], data: m[2] } },
            {
              text:
                'Extract this restaurant/shop receipt. Reply with ONLY a JSON object: ' +
                '{"merchant": string, "currency": ISO 4217 code (best guess from symbols), ' +
                '"items": [{"name": string, "qty": integer, "price": number (price of ONE unit)}], ' +
                '"tax": number, "tip": number}. Use 0 for tax or tip when not shown. ' +
                'Do not include subtotal or total as items. No commentary.',
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error('AI parsing failed: ' + (j.error && j.error.message || r.status)), { status: 502 });
  const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
    .map((x) => x.text || '').join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw Object.assign(new Error('Could not read the receipt. Try a clearer photo.'), { status: 422 });
  const raw = JSON.parse(text.slice(a, b + 1));
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 60).map((it) => ({
    name: clean(it.name, 80) || 'Item',
    qty: Math.max(1, Math.round(Number(it.qty) || 1)),
    price: Math.max(0, Number(it.price) || 0),
  }));
  return {
    demo: false,
    merchant: clean(raw.merchant, 60),
    currency: CURRENCIES.includes(raw.currency) ? raw.currency : 'USD',
    items,
    tax: Math.max(0, Number(raw.tax) || 0),
    tip: Math.max(0, Number(raw.tip) || 0),
  };
}

// ---------- routes ----------
async function createBill(body) {
  const currency = CURRENCIES.includes(body.currency) ? body.currency : 'USD';
  const names = (Array.isArray(body.people) ? body.people : []).slice(0, 12).map((n) => clean(n, 40));
  if (names.length < 2 || names.some((n) => !n)) throw Object.assign(new Error('Add at least two people with names.'), { status: 400 });
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 60).map((it) => ({
    name: clean(it.name, 80) || 'Item',
    qty: Math.max(1, Math.round(Number(it.qty) || 1)),
    unitCents: cents(it.price),
    assignees: (Array.isArray(it.assignees) ? it.assignees : []).map(Number).filter((n) => Number.isInteger(n)),
  }));
  if (!items.length) throw Object.assign(new Error('Add at least one item.'), { status: 400 });

  const payer = Number.isInteger(Number(body.payer)) && Number(body.payer) >= 0 && Number(body.payer) < names.length ? Number(body.payer) : 0;
  const shares = computeShares({ items, taxCents: cents(body.tax), tipCents: cents(body.tip), peopleCount: names.length });
  const bill = {
    id: crypto.randomBytes(6).toString('hex'),
    title: clean(body.title, 60) || 'Group bill',
    currency,
    createdAt: Date.now(),
    people: names.map((name, i) => ({
      name,
      isOwner: i === payer, // the person who paid the bill is owed the money
      ...shares[i],
      totalCents: shares[i].total,
      status: i === payer || shares[i].total === 0 ? 'owner' : 'pending',
    })),
  };
  // Create one PayPal order per person who owes money.
  for (let i = 0; i < bill.people.length; i++) {
    const p = bill.people[i];
    if (p.status === 'owner') continue;
    const o = await createOrder(bill, i);
    p.orderId = o.orderId;
    p.payUrl = o.payUrl;
  }
  bills.set(bill.id, bill);
  return bill;
}

function publicBill(b) {
  return {
    id: b.id, title: b.title, currency: b.currency,
    people: b.people.map((p) => ({
      name: p.name, isOwner: p.isOwner, totalCents: p.totalCents, subtotal: p.subtotal,
      tax: p.tax, tip: p.tip, status: p.status, payUrl: p.status === 'pending' ? p.payUrl : undefined,
    })),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html'))
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/split.js')
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'split.js')), 'application/javascript; charset=utf-8');

    if (req.method === 'GET' && p === '/api/config')
      return send(res, 200, {
        ai: !!process.env.GEMINI_API_KEY,
        paypal: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
        currencies: CURRENCIES,
        envFound,
      });

    if (req.method === 'POST' && p === '/api/parse') {
      const body = await readBody(req);
      return send(res, 200, await parseReceipt(body.image, body.sample === true));
    }

    if (req.method === 'POST' && p === '/api/bills') {
      const bill = await createBill(await readBody(req));
      return send(res, 200, publicBill(bill));
    }

    const mBill = /^\/api\/bills\/([a-f0-9]+)$/.exec(p);
    if (req.method === 'GET' && mBill) {
      const b = bills.get(mBill[1]);
      return b ? send(res, 200, publicBill(b)) : send(res, 404, { error: 'Bill not found' });
    }

    // PayPal redirects here after the payer approves; we capture the payment.
    if (req.method === 'GET' && p === '/return') {
      const b = bills.get(url.searchParams.get('bill'));
      const token = url.searchParams.get('token');
      const person = b && b.people.find((x) => x.orderId === token);
      if (person && person.status === 'pending') {
        const { ok, json } = await ppCall('POST', `/v2/checkout/orders/${encodeURIComponent(token)}/capture`, null, {
          'PayPal-Request-Id': `cap-${token}`,
        });
        const already = (json.details || []).some((d) => d.issue === 'ORDER_ALREADY_CAPTURED');
        if ((ok && json.status === 'COMPLETED') || already) person.status = 'paid';
        else person.status = 'failed';
      }
      res.writeHead(302, { Location: `/?bill=${b ? b.id : ''}` });
      return res.end();
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e.message);
    send(res, e.status || 500, { error: e.message });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`SplitSnap running at ${BASE_URL}`);
    console.log(`.env file: ${envFound ? 'found' : 'NOT FOUND (expected at ' + ENV_PATH + ')'}`);
    console.log(`PayPal credentials: ${process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? 'OK' : 'MISSING'}`);
    console.log(`Gemini key: ${process.env.GEMINI_API_KEY ? 'OK' : 'MISSING'}`);
  });
}
module.exports = { handle };
