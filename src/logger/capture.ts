/**
 * Map a registry pair + cached per-instrument snapshots into a RAW CaptureRecord,
 * aligning each leg's books to the pair's YES/NO outcomes. Pure: it reads from a
 * caller-supplied lookup (the live logger backs this with a push-updated cache).
 *
 * Alignment rules:
 *  - Kalshi: the pair's YES side is `pair.kalshi.yesSide`; the NO side is its
 *    opposite (so a Kalshi market whose native YES is the other outcome inverts).
 *  - PM dualSlug: yesSlug→YES, noSlug→NO.
 *  - PM singleMarket: only the long side's book is readable; it maps to YES if
 *    `yesIsLong`, else NO; the other side stays null (one arb direction).
 */
import type { Side } from "../book.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { MarketPair } from "../registry/schema.js";
import type { CaptureLeg, CaptureRecord } from "./model.js";

const KALSHI: Venue = "kalshi";
const PM: Venue = "polymarket-us";

export interface InstrumentSnapshot {
  snapshot: BookSnapshot;
  stale: boolean;
}

export type SnapshotLookup = (
  venue: Venue,
  marketId: string,
  side: Side,
) => InstrumentSnapshot | null;

function otherSide(side: Side): Side {
  return side === "yes" ? "no" : "yes";
}

function kalshiLeg(pair: MarketPair, lookup: SnapshotLookup): CaptureLeg {
  const { ticker, yesSide } = pair.kalshi;
  const yes = lookup(KALSHI, ticker, yesSide);
  const no = lookup(KALSHI, ticker, otherSide(yesSide));
  return {
    venue: KALSHI,
    name: "kalshi",
    stale: (yes?.stale ?? false) || (no?.stale ?? false),
    yesSnapshot: yes?.snapshot ?? null,
    noSnapshot: no?.snapshot ?? null,
  };
}

function pmLeg(pair: MarketPair, lookup: SnapshotLookup): CaptureLeg {
  const pm = pair.polymarketUs;
  if (pm.kind === "dualSlug") {
    const yes = lookup(PM, pm.yesSlug, "yes");
    const no = lookup(PM, pm.noSlug, "no");
    return {
      venue: PM,
      name: "polymarket-us",
      stale: (yes?.stale ?? false) || (no?.stale ?? false),
      yesSnapshot: yes?.snapshot ?? null,
      noSnapshot: no?.snapshot ?? null,
    };
  }
  const longSide: Side = pm.yesIsLong ? "yes" : "no";
  const long = lookup(PM, pm.slug, longSide);
  return {
    venue: PM,
    name: "polymarket-us",
    stale: long?.stale ?? false,
    yesSnapshot: pm.yesIsLong ? (long?.snapshot ?? null) : null,
    noSnapshot: pm.yesIsLong ? null : (long?.snapshot ?? null),
  };
}

function hasData(leg: CaptureLeg): boolean {
  return leg.yesSnapshot !== null || leg.noSnapshot !== null;
}

/**
 * Build a CaptureRecord, or null if either leg has no snapshot yet (the logger
 * skips this tick for the pair). A leg with one side present and the other null
 * is kept (partial book → some strategies unfillable, still a valid record).
 */
export function buildCaptureRecord(
  pair: MarketPair,
  captureMs: number,
  captureId: string,
  lookup: SnapshotLookup,
): CaptureRecord | null {
  const legA = kalshiLeg(pair, lookup);
  const legB = pmLeg(pair, lookup);
  if (!hasData(legA) || !hasData(legB)) return null;
  return { captureId, captureMs, pairId: pair.pairId, legA, legB };
}
