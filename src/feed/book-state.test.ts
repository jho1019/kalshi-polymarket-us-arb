import { test } from "node:test";
import assert from "node:assert/strict";
import { PriceLevels, isSeqGap } from "./book-state.js";

test("replace then toSorted descending returns best-first bids", () => {
  const lv = new PriceLevels();
  lv.replace([{ price: 8000, qty: 30 }, { price: 9000, qty: 10 }]);
  assert.deepEqual(lv.toSorted(true), [
    { price: 9000, qty: 10 },
    { price: 8000, qty: 30 },
  ]);
});

test("replace drops zero-qty levels", () => {
  const lv = new PriceLevels();
  lv.replace([{ price: 8000, qty: 0 }, { price: 9000, qty: 10 }]);
  assert.deepEqual(lv.toSorted(false), [{ price: 9000, qty: 10 }]);
});

test("applyDelta adds, accumulates, and removes a level driven to <= 0", () => {
  const lv = new PriceLevels();
  lv.replace([{ price: 9000, qty: 10 }]);
  lv.applyDelta(9000, 5);          // 10 + 5 = 15
  assert.deepEqual(lv.toSorted(false), [{ price: 9000, qty: 15 }]);
  lv.applyDelta(9000, -15);        // -> 0 -> removed
  assert.deepEqual(lv.toSorted(false), []);
  lv.applyDelta(8500, 7);          // new level from nothing
  assert.deepEqual(lv.toSorted(false), [{ price: 8500, qty: 7 }]);
});

test("isSeqGap: null baseline never a gap; consecutive ok; skip is a gap", () => {
  assert.equal(isSeqGap(null, 5), false);
  assert.equal(isSeqGap(4, 5), false);
  assert.equal(isSeqGap(4, 6), true);
  assert.equal(isSeqGap(4, 4), true);
});
