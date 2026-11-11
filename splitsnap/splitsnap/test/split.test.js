'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { allocate, computeShares } = require('../split');

test('allocate always sums to the total', () => {
  for (const total of [0, 1, 100, 1001, 99999]) {
    for (const w of [[1], [1, 1, 1], [3, 5, 7], [0, 0], [0, 2, 0]]) {
      const out = allocate(total, w);
      assert.strictEqual(out.reduce((a, b) => a + b, 0), total);
    }
  }
});

test('three people split 10.00 as 3.34 / 3.33 / 3.33', () => {
  assert.deepStrictEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
});

test('shared item, tax and tip add up to the bill total', () => {
  const items = [
    { qty: 1, unitCents: 1150, assignees: [0] },
    { qty: 1, unitCents: 1300, assignees: [1] },
    { qty: 2, unitCents: 650, assignees: [] },
    { qty: 1, unitCents: 2200, assignees: [0, 1, 2] },
  ];
  const s = computeShares({ items, taxCents: 333, tipCents: 601, peopleCount: 3 });
  const billTotal = 1150 + 1300 + 1300 + 2200 + 333 + 601;
  assert.strictEqual(s.reduce((a, x) => a + x.total, 0), billTotal);
});

test('tax and tip follow each person subtotal', () => {
  const s = computeShares({
    items: [{ qty: 1, unitCents: 3000, assignees: [0] }, { qty: 1, unitCents: 1000, assignees: [1] }],
    taxCents: 400, tipCents: 0, peopleCount: 2,
  });
  assert.deepStrictEqual(s.map((x) => x.tax), [300, 100]);
});
