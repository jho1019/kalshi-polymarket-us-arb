import { test } from "node:test";
import assert from "node:assert/strict";
import { recompute } from "./recompute.js";
import { DEFAULT_FEE_CONFIG } from "./model.js";
import type { CaptureRecord } from "./model.js";
import type { BookSnapshot } from "../snapshot.js";

function snap(askPrice: number): BookSnapshot {
  return { venue: "kalshi", marketId: "m", side: "yes", tsLocalMs: 1000, bids: [], asks: [{ price: askPrice, qty: 1_000_000 }] };
}

function records(): CaptureRecord[] {
  return [
    {
      captureId: "c1",
      captureMs: 2000,
      pairId: "P",
      legA: { venue: "kalshi", name: "kalshi", stale: false, yesSnapshot: snap(4000), noSnapshot: snap(5500) },
      legB: { venue: "polymarket-us", name: "polymarket-us", stale: false, yesSnapshot: snap(4500), noSnapshot: snap(5200) },
    },
  ];
}

function size1Net(opp: { edge: { perSize: { sizeContracts: number; best: { netPerContract: number } | null }[] } }): number | null {
  return opp.edge.perSize.find((r) => r.sizeContracts === 1)?.best?.netPerContract ?? null;
}

test("recompute with a CHANGED fee assumption yields a different (lower) net edge", () => {
  const recs = records();
  const base = recompute(recs, DEFAULT_FEE_CONFIG);
  const higherFee = recompute(recs, { kalshiRateBps: 5000, polymarketUsTakerBps: 5000 });

  assert.equal(base.length, 1);
  assert.equal(higherFee.length, 1);
  const baseNet = size1Net(base[0]!);
  const highNet = size1Net(higherFee[0]!);
  assert.ok(baseNet !== null && highNet !== null);
  assert.ok(highNet < baseNet, `higher fee net ${highNet} should be < base net ${baseNet}`);
  // provenance recorded:
  assert.deepEqual(higherFee[0]!.feeConfig, { kalshiRateBps: 5000, polymarketUsTakerBps: 5000 });
});
