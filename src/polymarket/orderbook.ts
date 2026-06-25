/**
 * Pure Polymarket US order book logic: normalize raw books into best-first ask
 * `Level[]` and compute executable cost via the shared engine. No network.
 *
 * Unlike Kalshi (bids-only, needs a 1−X conversion), PM US returns `offers`
 * (asks) directly, so buying a side just lifts that side's offers. A binary
 * question is a PAIR of complementary outcome slugs — buy-NO reads the REAL
 * no-slug offers, never `1 − YES bid` (which diverges past top of book).
 */

import { executableCost } from "../book.js";
import type { Fill, Level, Side } from "../book.js";
import { parsePrice, parseQty } from "../money.js";
import type { BookSnapshot } from "../snapshot.js";
import type { MarketData, RawPmLevel } from "./client.js";

export { executableCost };

/** The two complementary outcome slugs of a binary Polymarket question. */
export interface PmPair {
  yesSlug: string;
  noSlug: string;
}

/** Normalized buy-side books: offers (asks) for each outcome, best-first. */
export interface PmBook {
  pair: PmPair;
  yesOffers: Level[];
  noOffers: Level[];
}

/** Convert raw PM levels to integer-unit levels (unsorted). */
function toLevels(raw: RawPmLevel[]): Level[] {
  return raw.map((l) => ({ price: parsePrice(l.px.value), qty: parseQty(l.qty) }));
}

/** Convert raw offers to best-first (lowest price) integer-unit ask levels. */
export function levelsToAsks(offers: RawPmLevel[]): Level[] {
  return toLevels(offers).sort((a, b) => a.price - b.price);
}

/** Convert raw bids to best-first (highest price) integer-unit bid levels. */
export function levelsToBids(bids: RawPmLevel[]): Level[] {
  return toLevels(bids).sort((a, b) => b.price - a.price);
}

/** Normalize the YES and NO raw offer arrays into a PmBook. */
export function normalize(
  pair: PmPair,
  yesOffers: RawPmLevel[],
  noOffers: RawPmLevel[],
): PmBook {
  return {
    pair,
    yesOffers: levelsToAsks(yesOffers),
    noOffers: levelsToAsks(noOffers),
  };
}

/** The asks you would lift to BUY `side` — that side's own offers, best-first. */
export function asksForBuying(book: PmBook, side: Side): Level[] {
  return side === "yes" ? book.yesOffers : book.noOffers;
}

/** Best (cheapest) price to buy `side`, or null if that side has no liquidity. */
export function bestAsk(book: PmBook, side: Side): number | null {
  const asks = asksForBuying(book, side);
  return asks.length > 0 ? asks[0]!.price : null;
}

/** Convenience: executable cost to buy `sizeQtyUnits` of `side` from a book. */
export function costToBuy(book: PmBook, side: Side, sizeQtyUnits: number): Fill {
  return executableCost(asksForBuying(book, side), sizeQtyUnits);
}

/**
 * Map a single Polymarket US market book (one outcome/slug) to a normalized
 * one-sided `BookSnapshot`. `side` labels which outcome this slug represents.
 */
export function toBookSnapshot(
  marketData: MarketData,
  side: Side,
  meta: { tsLocalMs: number; seq?: number },
): BookSnapshot {
  return {
    venue: "polymarket-us",
    marketId: marketData.marketSlug,
    side,
    tsLocalMs: meta.tsLocalMs,
    ...(marketData.transactTime !== undefined ? { tsVenue: marketData.transactTime } : {}),
    ...(meta.seq !== undefined ? { seq: meta.seq } : {}),
    bids: levelsToBids(marketData.bids),
    asks: levelsToAsks(marketData.offers),
  };
}
