# SplitSnap

**Snap a receipt. AI reads it. Everyone gets a PayPal link for their share.**

Built for the *Build What's Next with PayPal and AI* hackathon (category: Money Movement Experiences).

Splitting a group dinner usually means a calculator, an argument about who had the wine, and weeks of "did you pay me yet?". SplitSnap turns that into one flow:

1. Upload a photo of the receipt.
2. Google Gemini (vision, free tier) extracts the items, quantities, prices, tax and tip.
3. You tap who shared each item. Unassigned items are split equally; tax and tip are split in proportion to what each person ordered. Amounts are computed in integer cents with the largest-remainder method, so the shares always add up exactly to the bill.
4. SplitSnap creates one **PayPal order per person** (Orders v2 API) and gives you a payment link for each.
5. When a friend approves the payment, PayPal redirects back, the server **captures** the payment, and the live status flips to *paid*.

## How PayPal and AI are used

| | What it does |
|---|---|
| **PayPal Orders v2 (sandbox)** | `POST /v2/checkout/orders` creates a payment request for each person's exact share; `POST /v2/checkout/orders/{id}/capture` settles it after approval. Idempotency keys (`PayPal-Request-Id`) prevent duplicate orders and captures. |
| **Google Gemini vision (free tier)** | Reads the receipt photo and returns structured JSON (merchant, currency, items, tax, tip) through the Gemini API `generateContent` endpoint. Default model: `gemini-3.5-flash-lite`, configurable with `GEMINI_MODEL`. |

No third-party libraries: the server uses only Node's standard library and the built-in `fetch`.

## Run it

Requires Node.js 18 or newer.

```bash
git clone <this repo>
cd splitsnap
cp .env.example .env      # then fill in the values below
npm start                 # http://localhost:3000
```

Values for `.env`:

- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: create a free developer account at developer.paypal.com, open *Apps & Credentials* in the **Sandbox** tab and create (or use the default) REST app.
- `GEMINI_API_KEY`: a free key from aistudio.google.com/apikey, no credit card needed. If left empty, the app runs in **demo mode** with a sample receipt, so everything else still works.
- `BASE_URL`: where PayPal sends payers back. `http://localhost:3000` works when you pay from the same machine. To share links with other devices, host the app (for example on Render) and set `BASE_URL` to its public URL.

### Try the full payment flow

1. Open the app, upload a receipt (or tap **Enter items manually**).
2. Add people, assign items, then press **Create PayPal payment requests**.
3. Press **Pay** on a friend's row and log in with a **sandbox personal account** (create one in the PayPal developer dashboard under *Testing Tools > Sandbox Accounts*).
4. After approval you land back on the app and that row shows **paid**.

### Tests

```bash
npm test
```

Covers the split maths (rounding, shared items, proportional tax and tip).

## Project layout

- `server.js`: HTTP server, PayPal integration, receipt parsing
- `split.js`: split maths, shared by server and browser
- `public/index.html`: the whole front end (vanilla JS, no build step)
- `test/`: unit tests

## Notes and limits

- Sandbox only. Bills are kept in memory and disappear when the server restarts.
- Supported currencies: USD, EUR, GBP, CAD, AUD (two-decimal currencies).
- You add the people yourself. Everyone gets their own PayPal payment link (you can optionally mark someone as already paid to skip theirs). The money lands in the PayPal sandbox business account tied to your REST app.

## License

MIT, see [LICENSE](LICENSE).
