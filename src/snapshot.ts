/**
 * Venue-neutral normalized order book snapshot — the one interface both Kalshi
 * and Polymarket US map into so downstream code never branches on venue.
 *
 * A snapshot models ONE tradeable instrument (a single side of a binary
 * market). Its `asks` are what you lift to BUY that side, `bids` what you lift
 * to SELL it. Levels reuse `Level` (integer 1/10000 units; see money.ts), so
 * every numeric field is a safe integer and JSON (de)serialization is lossless.
 */

import type { Level, Side } from "./book.js";

export type Venue = "kalshi" | "polymarket-us";

export interface BookSnapshot {
  venue: Venue;
  /** Venue-native id: Kalshi ticker, Polymarket US slug. */
  marketId: string;
  /** Which instrument this snapshot is (yes | no). */
  side: Side;
  /** Local capture time, ms since epoch. */
  tsLocalMs: number;
  /** Venue-reported timestamp when available (ISO string). */
  tsVenue?: string;
  /** Best-first: highest price first. */
  bids: Level[];
  /** Best-first: lowest price first. */
  asks: Level[];
  /** Intra-tick ordering / WebSocket sequence number. */
  seq?: number;
}

const VENUES: readonly Venue[] = ["kalshi", "polymarket-us"];
const SIDES: readonly Side[] = ["yes", "no"];

function isNonNegInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

function assertLevels(levels: unknown, label: string, descending: boolean): void {
  if (!Array.isArray(levels)) {
    throw new Error(`BookSnapshot.${label} must be an array`);
  }
  let prev: number | null = null;
  for (const lvl of levels as Level[]) {
    if (!lvl || !isNonNegInt(lvl.price) || !isNonNegInt(lvl.qty)) {
      throw new Error(`BookSnapshot.${label} has a non-integer price/qty level`);
    }
    if (prev !== null) {
      const ordered = descending ? lvl.price <= prev : lvl.price >= prev;
      if (!ordered) {
        throw new Error(
          `BookSnapshot.${label} is not ${descending ? "descending" : "ascending"} by price`,
        );
      }
    }
    prev = lvl.price;
  }
}

/** Throw unless `x` is a structurally valid, integer-exact, ordered BookSnapshot. */
export function assertValidSnapshot(x: unknown): asserts x is BookSnapshot {
  const s = x as BookSnapshot;
  if (!s || typeof s !== "object") throw new Error("BookSnapshot must be an object");
  if (!VENUES.includes(s.venue)) throw new Error(`unknown venue: ${String(s.venue)}`);
  if (!SIDES.includes(s.side)) throw new Error(`unknown side: ${String(s.side)}`);
  if (typeof s.marketId !== "string" || s.marketId.length === 0) {
    throw new Error("BookSnapshot.marketId must be a non-empty string");
  }
  if (!isNonNegInt(s.tsLocalMs)) {
    throw new Error("BookSnapshot.tsLocalMs must be a non-negative integer");
  }
  if (s.tsVenue !== undefined && typeof s.tsVenue !== "string") {
    throw new Error("BookSnapshot.tsVenue must be a string when present");
  }
  if (s.seq !== undefined && !isNonNegInt(s.seq)) {
    throw new Error("BookSnapshot.seq must be a non-negative integer when present");
  }
  assertLevels(s.bids, "bids", true);
  assertLevels(s.asks, "asks", false);
}

/** Lossless serialization (every field is JSON-native and integer-exact). */
export function serializeSnapshot(s: BookSnapshot): string {
  return JSON.stringify(s);
}

/** Parse and validate a serialized snapshot. */
export function deserializeSnapshot(json: string): BookSnapshot {
  const parsed = JSON.parse(json) as unknown;
  assertValidSnapshot(parsed);
  return parsed;
}
