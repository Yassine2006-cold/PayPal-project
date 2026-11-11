'use strict';
// Shared split logic (runs in Node and in the browser). All amounts are integer cents.

// Distribute `total` cents across `weights` using the largest-remainder method,
// so the parts always add up exactly to the total.
function allocate(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const s = sum > 0 ? sum : n;
  const raw = w.map((x) => (total * x) / s);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rem > 0; k++, rem--) out[order[k % n][1]]++;
  return out;
}

// items: [{ qty, unitCents, assignees: [personIndex, ...] }]
// An item with no assignees (nobody selected) is not charged to anyone.
// Tax and tip are split in proportion to each person's subtotal.
function computeShares({ items, taxCents, tipCents, peopleCount }) {
  const sub = new Array(peopleCount).fill(0);
  for (const it of items) {
    const total = Math.round((it.qty || 1) * it.unitCents);
    const who = Array.from(new Set((it.assignees || []).filter((p) => p >= 0 && p < peopleCount)));
    if (who.length === 0) continue; // nobody selected: this item is not charged
    const parts = allocate(total, who.map(() => 1));
    who.forEach((p, k) => (sub[p] += parts[k]));
  }
  const anything = sub.some((x) => x > 0);
  const tax = anything ? allocate(taxCents || 0, sub) : sub.map(() => 0);
  const tip = anything ? allocate(tipCents || 0, sub) : sub.map(() => 0);
  return sub.map((s, i) => ({ subtotal: s, tax: tax[i], tip: tip[i], total: s + tax[i] + tip[i] }));
}

const api = { allocate, computeShares };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.Split = api;
