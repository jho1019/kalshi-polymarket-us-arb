import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpportunity, withinSkew, bothFresh } from "./opportunity.js";
import type { BuildOpportunityInput } from "./opportunity.js";
import type { BookSnapshot, Venue } from "./snapshot.js";
import type { NetEdgeReport } from "./edge.js";

const EDGE: NetEdgeReport = { perSize: [], maxProfitableSize: null };

function snap(venue: Venue, tsLocalMs: number): BookSnapshot {
  return { venue, marketId: "m", side: "yes", tsLocalMs, bids: [], asks: [] };
}

function input(over: Partial<BuildOpportunityInput> = {}): BuildOpportunityInput {
  return {
    pairId: "PAIR-1",
    captureMs: 10_000,
    legA: { venue: "kalshi", snapshots: [snap("kalshi", 9_800)], stale: false },
    legB: { venue: "polymarket-us", snapshots: [snap("polymarket-us", 9_500)], stale: false },
    edge: EDGE,
    ...over,
  };
}

test("bookSkewMs is the absolute difference between the two legs' tsLocalMs", () => {
  assert.equal(buildOpportunity(input()).bookSkewMs, 300); // |9800 - 9500|
});

test("per-leg ageMs is captureMs minus the leg's tsLocalMs", () => {
  const opp = buildOpportunity(input());
  assert.equal(opp.legA.ageMs, 200); // 10000 - 9800
  assert.equal(opp.legB.ageMs, 500); // 10000 - 9500
  assert.equal(opp.captureMs, 10_000); // captureMs carried through
  assert.equal(opp.edge, EDGE); // edge passed through unchanged
});

test("a multi-book leg takes the OLDEST (min) snapshot time", () => {
  const opp = buildOpportunity(
    input({
      legB: {
        venue: "polymarket-us",
        snapshots: [snap("polymarket-us", 9_900), snap("polymarket-us", 9_400)],
        stale: false,
      },
    }),
  );
  assert.equal(opp.legB.tsLocalMs, 9_400); // oldest of the two PM books
  assert.equal(opp.legB.ageMs, 600); // 10000 - 9400
  assert.equal(opp.bookSkewMs, 400); // |9800 - 9400|
});

test("stale flag is carried through per leg", () => {
  const opp = buildOpportunity(
    input({ legA: { venue: "kalshi", snapshots: [snap("kalshi", 9_800)], stale: true } }),
  );
  assert.equal(opp.legA.stale, true);
  assert.equal(opp.legB.stale, false);
});

test("withinSkew includes at the boundary and excludes just past it", () => {
  const opp = buildOpportunity(input()); // skew 300
  assert.equal(withinSkew(opp, 300), true);
  assert.equal(withinSkew(opp, 299), false);
  assert.equal(withinSkew(opp, 1000), true);
});

test("bothFresh requires BOTH legs within maxAgeMs (boundary inclusive)", () => {
  const opp = buildOpportunity(input()); // ages: A=200, B=500
  assert.equal(bothFresh(opp, 500), true); // both <= 500
  assert.equal(bothFresh(opp, 499), false); // legB 500 > 499
  assert.equal(bothFresh(opp, 200), false); // legB 500 > 200
});

test("a leg with no snapshots throws", () => {
  assert.throws(
    () => buildOpportunity(input({ legA: { venue: "kalshi", snapshots: [], stale: false } })),
    /at least one snapshot/,
  );
});
