/**
 * Per-opportunity timing metadata: clock skew between the two legs' books and
 * per-leg staleness, plus freshness filters. An apparent spread whose two books
 * were captured seconds apart is staleness, not edge.
 *
 * All times are LOCAL capture times (`BookSnapshot.tsLocalMs`) on one clock, so
 * `bookSkewMs` is a true measure of how far apart we saw the two books — NOT a
 * cross-venue server-clock comparison (`tsVenue`), which is not trustworthy.
 * Pure module: no I/O, no `Date.now()`; `captureMs` is always supplied.
 */
import type { BookSnapshot, Venue } from "./snapshot.js";
import type { NetEdgeReport } from "./edge.js";

export interface OpportunityLeg {
  venue: Venue;
  /** Representative last-update time for this leg (oldest of its books). */
  tsLocalMs: number;
  /** captureMs − tsLocalMs: how stale this leg was when computed. */
  ageMs: number;
  /** Feed stale flag (book awaiting a fresh snapshot after a drop). */
  stale: boolean;
}

export interface Opportunity {
  pairId: string;
  captureMs: number;
  /** |legA.tsLocalMs − legB.tsLocalMs|: skew between the two legs' captures. */
  bookSkewMs: number;
  legA: OpportunityLeg;
  legB: OpportunityLeg;
  edge: NetEdgeReport;
}

export interface OpportunityLegInput {
  venue: Venue;
  /** The book(s) this leg used: 1 (Kalshi / PM single) or 2 (PM dual-slug). */
  snapshots: BookSnapshot[];
  stale: boolean;
}

export interface BuildOpportunityInput {
  pairId: string;
  captureMs: number;
  legA: OpportunityLegInput;
  legB: OpportunityLegInput;
  edge: NetEdgeReport;
}

/** A leg is only as fresh as its STALEST book → the oldest (min) tsLocalMs. */
function representativeTsLocalMs(snapshots: BookSnapshot[]): number {
  if (snapshots.length === 0) {
    throw new Error("buildOpportunity: a leg must have at least one snapshot");
  }
  return snapshots.reduce((min, s) => Math.min(min, s.tsLocalMs), Infinity);
}

function buildLeg(input: OpportunityLegInput, captureMs: number): OpportunityLeg {
  const tsLocalMs = representativeTsLocalMs(input.snapshots);
  return { venue: input.venue, tsLocalMs, ageMs: captureMs - tsLocalMs, stale: input.stale };
}

/** Build an Opportunity, computing per-leg staleness and inter-leg book skew. */
export function buildOpportunity(input: BuildOpportunityInput): Opportunity {
  const legA = buildLeg(input.legA, input.captureMs);
  const legB = buildLeg(input.legB, input.captureMs);
  return {
    pairId: input.pairId,
    captureMs: input.captureMs,
    bookSkewMs: Math.abs(legA.tsLocalMs - legB.tsLocalMs),
    legA,
    legB,
    edge: input.edge,
  };
}

/** True if the two legs were captured within `maxSkewMs` of each other (headline filter). */
export function withinSkew(opp: Opportunity, maxSkewMs: number): boolean {
  return opp.bookSkewMs <= maxSkewMs;
}

/** True if BOTH legs' books are no older than `maxAgeMs` at compute time. */
export function bothFresh(opp: Opportunity, maxAgeMs: number): boolean {
  return opp.legA.ageMs <= maxAgeMs && opp.legB.ageMs <= maxAgeMs;
}
