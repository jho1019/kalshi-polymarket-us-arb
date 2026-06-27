import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureRecord } from "./capture.js";
import type { InstrumentSnapshot, SnapshotLookup } from "./capture.js";
import type { MarketPair } from "../registry/schema.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { Side } from "../book.js";

function snap(marketId: string, side: Side, tsLocalMs = 1000): BookSnapshot {
  return { venue: "kalshi", marketId, side, tsLocalMs, bids: [], asks: [] };
}

/** A lookup backed by a Map keyed `venue:marketId:side`. */
function lookupFrom(entries: Record<string, InstrumentSnapshot>): SnapshotLookup {
  return (venue: Venue, marketId: string, side: Side) => entries[`${venue}:${marketId}:${side}`] ?? null;
}

function singlePair(over: Partial<MarketPair> = {}): MarketPair {
  return {
    pairId: "P",
    description: "d",
    kalshi: { ticker: "KTKR", yesSide: "yes" },
    polymarketUs: { kind: "singleMarket", slug: "pslug", yesIsLong: true },
    settlementSourceMatch: true,
    settlementTimeMatch: true,
    strikeMatch: true,
    resolutionVerified: false,
    verifiedDate: "2026-06-24",
    ...over,
  };
}

test("kalshi yesSide=yes maps yes/no snapshots straight through", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.legA.yesSnapshot?.side, "yes");
  assert.equal(rec.legA.noSnapshot?.side, "no");
});

test("kalshi yesSide=no INVERTS: pair-YES asks come from the kalshi NO side", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair({ kalshi: { ticker: "KTKR", yesSide: "no" } }), 5000, "cid", lookup)!;
  assert.equal(rec.legA.yesSnapshot?.side, "no"); // inverted
  assert.equal(rec.legA.noSnapshot?.side, "yes");
});

test("PM singleMarket yesIsLong=true sets yesSnapshot, leaves noSnapshot null", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.legB.yesSnapshot?.marketId, "pslug");
  assert.equal(rec.legB.noSnapshot, null);
});

test("PM singleMarket yesIsLong=false sets noSnapshot, leaves yesSnapshot null", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:no": { snapshot: snap("pslug", "no"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair({ polymarketUs: { kind: "singleMarket", slug: "pslug", yesIsLong: false } }), 5000, "cid", lookup)!;
  assert.equal(rec.legB.noSnapshot?.marketId, "pslug");
  assert.equal(rec.legB.yesSnapshot, null);
});

test("PM dualSlug maps yesSlug/noSlug to the two sides", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:ys:yes": { snapshot: snap("ys", "yes"), stale: false },
    "polymarket-us:ns:no": { snapshot: snap("ns", "no"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair({ polymarketUs: { kind: "dualSlug", yesSlug: "ys", noSlug: "ns" } }), 5000, "cid", lookup)!;
  assert.equal(rec.legB.yesSnapshot?.marketId, "ys");
  assert.equal(rec.legB.noSnapshot?.marketId, "ns");
});

test("leg stale is the OR of its constituent books' stale flags", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: true },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.legA.stale, true);
});

test("returns null when a leg has no snapshot yet", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    // PM leg has nothing cached yet
  });
  assert.equal(buildCaptureRecord(singlePair(), 5000, "cid", lookup), null);
});

test("sets captureId, captureMs, pairId on the record", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.captureId, "cid");
  assert.equal(rec.captureMs, 5000);
  assert.equal(rec.pairId, "P");
});
