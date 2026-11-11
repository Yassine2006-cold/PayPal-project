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

test('an item with nobody selected is not charged to anyone', () => {
  const s = computeShares({
    items: [
      { qty: 1, unitCents: 4000, assignees: [0] },
      { qty: 1, unitCents: 6000, assignees: [] },
    ],
    taxCents: 0, tipCents: 0, peopleCount: 2,
  });
  assert.deepStrictEqual(s.map((x) => x.total), [4000, 0]);
});

test('nothing selected anywhere means nothing owed, even with tax and tip', () => {
  const s = computeShares({ items: [{ qty: 1, unitCents: 5000, assignees: [] }], taxCents: 500, tipCents: 700, peopleCount: 2 });
  assert.deepStrictEqual(s.map((x) => x.total), [0, 0]);
});

test('everyone on an item (explicit list) splits it equally', () => {
  const s = computeShares({ items: [{ qty: 1, unitCents: 6000, assignees: [0, 1, 2] }], taxCents: 0, tipCents: 0, peopleCount: 3 });
  assert.deepStrictEqual(s.map((x) => x.total), [2000, 2000, 2000]);
});

test('charged items, tax and tip add up; uncharged items are ignored', () => {
  const items = [
    { qty: 1, unitCents: 1150, assignees: [0] },
    { qty: 1, unitCents: 1300, assignees: [1] },
    { qty: 2, unitCents: 650, assignees: [0, 1, 2] },
    { qty: 1, unitCents: 2200, assignees: [] }, // not charged
  ];
  const s = computeShares({ items, taxCents: 333, tipCents: 601, peopleCount: 3 });
  assert.strictEqual(s.reduce((a, x) => a + x.total, 0), 1150 + 1300 + 1300 + 333 + 601);
});

test('tax and tip follow each person subtotal', () => {
  const s = computeShares({
    items: [{ qty: 1, unitCents: 3000, assignees: [0] }, { qty: 1, unitCents: 1000, assignees: [1] }],
    taxCents: 400, tipCents: 0, peopleCount: 2,
  });
  assert.deepStrictEqual(s.map((x) => x.tax), [300, 100]);
});
