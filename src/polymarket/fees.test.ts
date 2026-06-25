/**
 * Unit tests for the Polymarket US fees (issue #9).
 * Worked examples from https://docs.polymarket.us/fees.
 *
 * Prices/fees in 1/10000-$ units; qty in 1/10000-contract units.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRICE_SCALE, QTY_SCALE } from "../money.js";
import { makerRebate, takerFee } from "./fees.js";

const contracts = (n: number) => n * QTY_SCALE;

test("taker fee @ $0.50, 1000 contracts == $12.50 (docs example)", () => {
  // 0.05 * 1000 * 0.50 * 0.50 = 12.50 -> 125000 (1/10000-$)
  assert.equal(takerFee(5000, contracts(1000)), 125000);
});

test("taker fee @ $0.10, 1000 contracts == $4.50 (docs example)", () => {
  // 0.05 * 1000 * 0.10 * 0.90 = 4.50 -> 45000
  assert.equal(takerFee(1000, contracts(1000)), 45000);
});

test("maker rebate @ $0.50, 1000 contracts == $3.125 (docs display $3.13)", () => {
  // 0.0125 * 1000 * 0.25 = 3.125 -> 31250
  assert.equal(makerRebate(5000, contracts(1000)), 31250);
});

test("maker rebate @ $0.10, 1000 contracts == $1.125 (docs display $1.13)", () => {
  assert.equal(makerRebate(1000, contracts(1000)), 11250);
});

test("maker rebate is 25% of taker fee (exact-division prices)", () => {
  // 0.0125 = 0.05 / 4. Holds exactly only when neither value hits ceil rounding;
  // at other prices the two independent ceils-to-centicent can differ by <4 units.
  for (const p of [5000, 1000]) {
    assert.equal(makerRebate(p, contracts(1000)) * 4, takerFee(p, contracts(1000)));
  }
});

test("maker rebate ~ 25% of taker fee within ceil rounding everywhere", () => {
  // ceil(y/4)*4 >= ceil(y), so makerRebate*4 is >= takerFee by 0..3 centicents.
  for (const p of [2500, 3300, 4900, 137]) {
    const diff = makerRebate(p, contracts(1000)) * 4 - takerFee(p, contracts(1000));
    assert.ok(diff >= 0 && diff < 4, `unexpected rounding gap ${diff} at p=${p}`);
  }
});

test("symmetric: fee(p) == fee(1 - p)", () => {
  for (const p of [1000, 2500, 4900, 700]) {
    assert.equal(takerFee(p, contracts(100)), takerFee(PRICE_SCALE - p, contracts(100)));
  }
});

test("boundaries: p=0 and p=$1 cost no fee", () => {
  assert.equal(takerFee(0, contracts(100)), 0);
  assert.equal(takerFee(PRICE_SCALE, contracts(100)), 0);
});

test("invalid inputs throw", () => {
  assert.throws(() => takerFee(-1, contracts(1)));
  assert.throws(() => takerFee(PRICE_SCALE + 1, contracts(1)));
  assert.throws(() => makerRebate(5000, -1));
});
