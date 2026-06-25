/**
 * Unit tests for the Kalshi taker fee (issue #8).
 *
 * Prices and fees are in 1/10000-$ units; qty in 1/10000-contract units, so a
 * whole contract is QTY_SCALE units.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRICE_SCALE, QTY_SCALE } from "../money.js";
import { takerFee } from "./fees.js";

const contracts = (n: number) => n * QTY_SCALE;

test("fee(0.50, 100) == $1.75", () => {
  // 0.07 * 0.50 * 0.50 * 100 = 1.75 -> 17500 (1/10000-$)
  assert.equal(takerFee(5000, contracts(100)), 17500);
});

test("fee(0.10, 100) == $0.63 (rounding)", () => {
  // 0.07 * 0.10 * 0.90 * 100 = 0.63 -> 6300
  assert.equal(takerFee(1000, contracts(100)), 6300);
});

test("symmetric: fee(p) == fee(1 - p)", () => {
  for (const p of [1000, 2500, 3300, 4900, 700]) {
    assert.equal(
      takerFee(p, contracts(100)),
      takerFee(PRICE_SCALE - p, contracts(100)),
      `symmetry failed at p=${p}`,
    );
  }
});

test("boundaries: p=0 and p=$1 cost no fee", () => {
  assert.equal(takerFee(0, contracts(100)), 0);
  assert.equal(takerFee(PRICE_SCALE, contracts(100)), 0);
});

test("sub-centicent raw fee ceils up to 1 unit", () => {
  // 1 contract at 0.50: 0.07 * 0.25 * 1 = 0.0175 -> 175 units (exact, no ceil)
  assert.equal(takerFee(5000, contracts(1)), 175);
  // tiny qty so raw fee is a fraction of a centicent -> must ceil to 1
  assert.equal(takerFee(5000, 1), 1);
  assert.equal(takerFee(5000, 0), 0);
});

test("custom rate (350 bps = 0.035) halves the 0.07 fee", () => {
  assert.equal(takerFee(5000, contracts(100), { rateBps: 350 }), 8750);
});

test("large size stays exact (overflow regime, BigInt)", () => {
  // 1,000,000 contracts at 0.50: 0.07 * 0.25 * 1e6 = 17500 dollars -> 175,000,000 units
  assert.equal(takerFee(5000, contracts(1_000_000)), 175_000_000);
});

test("invalid inputs throw", () => {
  assert.throws(() => takerFee(-1, contracts(1)));
  assert.throws(() => takerFee(PRICE_SCALE + 1, contracts(1)));
  assert.throws(() => takerFee(5000, -1));
  assert.throws(() => takerFee(5000, contracts(1), { rateBps: -1 }));
  assert.throws(() => takerFee(5000.5, contracts(1)));
});
