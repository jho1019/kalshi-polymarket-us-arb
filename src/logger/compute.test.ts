import { test } from "node:test";
import assert from "node:assert/strict";
import { captureToLegs, computeOpportunity } from "./compute.js";
import { DEFAULT_FEE_CONFIG } from "./model.js";
import type { CaptureRecord } from "./model.js";
import type { BookSnapshot } from "../snapshot.js";

function snap(askPrice: number, askQty = 1_000_000): BookSnapshot {
  return {
    venue: "kalshi",
    marketId: "m",
    side: "yes",
    tsLocalMs: 1000,
    bids: [],
    asks: [{ price: askPrice, qty: askQty }],
  };
}

function record(): CaptureRecord {
  return {
    captureId: "c1",
    captureMs: 2000,
    pairId: "P",
    legA: { venue: "kalshi", name: "kalshi", stale: false, yesSnapshot: snap(4000), noSnapshot: snap(5500) },
    legB: { venue: "polymarket-us", name: "polymarket-us", stale: false, yesSnapshot: snap(4500), noSnapshot: snap(5200) },
  };
}

test("captureToLegs maps snapshot asks and builds a fee fn from the config", () => {
  const { legA, legB } = captureToLegs(record(), DEFAULT_FEE_CONFIG);
  assert.equal(legA.name, "kalshi");
  assert.deepEqual(legA.yesAsks, [{ price: 4000, qty: 1_000_000 }]);
  assert.deepEqual(legA.noAsks, [{ price: 5500, qty: 1_000_000 }]);
  assert.deepEqual(legB.yesAsks, [{ price: 4500, qty: 1_000_000 }]);
  // fee fn applies the configured bps (700 for kalshi) via feeUnits at price 5000, 1 contract.
  assert.ok(legA.fee(5000, 10_000) > 0);
});

test("computeOpportunity tags captureId + feeConfig and yields a fillable positive edge", () => {
  const opp = computeOpportunity(record(), DEFAULT_FEE_CONFIG);
  assert.equal(opp.captureId, "c1");
  assert.deepEqual(opp.feeConfig, DEFAULT_FEE_CONFIG);
  assert.equal(opp.pairId, "P");
  assert.equal(opp.bookSkewMs, 0); // both legs' snapshots share tsLocalMs 1000
  // YES@kalshi(0.40) + NO@pm(0.52) = 0.92 cost -> ~0.08 gross/contract, profitable at size 1.
  assert.equal(opp.edge.maxProfitableSize !== null, true);
});

test("a null side becomes empty asks (that strategy unfillable, the other still computes)", () => {
  const r = record();
  r.legB.noSnapshot = null; // PM NO unreadable
  const { legB } = captureToLegs(r, DEFAULT_FEE_CONFIG);
  assert.deepEqual(legB.noAsks, []);
  const opp = computeOpportunity(r, DEFAULT_FEE_CONFIG);
  // size-1 row: strategy buying NO@pm is unfillable; the report still computes.
  const row = opp.edge.perSize.find((x) => x.sizeContracts === 1);
  assert.ok(row);
  assert.equal(row.s1.fillable === false || row.s2.fillable === false, true);
});
