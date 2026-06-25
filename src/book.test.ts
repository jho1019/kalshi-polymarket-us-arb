/**
 * Unit tests for the depth-walk executable cost (issue #7).
 *
 * Prices are 1/10000-$ integer units; sizes are whole contracts scaled by
 * QTY_SCALE so the cases read naturally.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { avgFillPrice, executableCost } from "./book.js";
import type { Level } from "./book.js";
import { QTY_SCALE } from "./money.js";

/** Build a level from a 1/10000-$ price and a whole-contract quantity. */
function level(price: number, contracts: number): Level {
  return { price, qty: contracts * QTY_SCALE };
}

function size(contracts: number): number {
  return contracts * QTY_SCALE;
}

test("single level: avg equals the level price", () => {
  const asks = [level(5000, 10)];
  assert.equal(avgFillPrice(asks, size(10)), 5000);
});

test("partial fill of one level: avg still the level price", () => {
  const asks = [level(5000, 10)];
  assert.equal(avgFillPrice(asks, size(3)), 5000);
});

test("multi-level: correct integer weighted average", () => {
  const asks = [level(100, 10), level(200, 10)];
  // 10@100 + 5@200 = 2000 over 15 contracts -> round(133.33) = 133
  assert.equal(avgFillPrice(asks, size(15)), 133);

  const fill = executableCost(asks, size(15));
  assert.equal(fill.fillable, true);
  assert.equal(fill.filledSize, size(15));
  assert.equal(fill.totalCost, 100 * size(10) + 200 * size(5));
  assert.equal(fill.levelsConsumed, 2);
});

test("exact full-depth fill is fillable", () => {
  const asks = [level(100, 10), level(200, 10)];
  assert.equal(avgFillPrice(asks, size(20)), 150); // (1000+2000)/20
});

test("size beyond total depth: null and unfillable", () => {
  const asks = [level(100, 10), level(200, 10)];
  assert.equal(avgFillPrice(asks, size(21)), null);

  const fill = executableCost(asks, size(21));
  assert.equal(fill.fillable, false);
  assert.equal(fill.filledSize, size(20)); // all available depth
  assert.equal(fill.levelsConsumed, 2);
});

test("empty book: null", () => {
  assert.equal(avgFillPrice([], size(1)), null);
});

test("zero size: null (nothing to fill)", () => {
  const asks = [level(100, 10)];
  assert.equal(avgFillPrice(asks, 0), null);
});
