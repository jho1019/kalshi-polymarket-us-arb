/**
 * Pure order book logic: normalize the raw book, convert bids → asks, and walk
 * depth to compute executable cost. No network, no side effects — every
 * function takes plain data so it is testable in isolation.
 */

import { executableCost } from "../book.js";
import type { Fill, Level, Side } from "../book.js";
import { PRICE_SCALE, parsePrice, parseQty } from "../money.js";
import type { Book, RawLevel, RawOrderbook } from "./types.js";

export { executableCost };

/** Convert raw `[price, qty]` string levels to integer-unit levels. */
function normalizeLevels(raw: RawLevel[]): Level[] {
  return raw.map(([price, qty]) => ({
    price: parsePrice(price),
    qty: parseQty(qty),
  }));
}

/** Normalize a raw API response into integer-unit bids. */
export function normalize(ticker: string, raw: RawOrderbook): Book {
  return {
    ticker,
    yesBids: normalizeLevels(raw.orderbook_fp.yes_dollars),
    noBids: normalizeLevels(raw.orderbook_fp.no_dollars),
  };
}

/**
 * The asks you would lift to BUY `side`, best (cheapest) first.
 *
 * Kalshi returns bids only. To buy YES you lift NO bids; a NO bid at X is a YES
 * ask at (1 − X). The highest opposite-side bid is the cheapest ask, so we sort
 * the converted asks ascending by price.
 */
export function asksForBuying(book: Book, side: Side): Level[] {
  const oppositeBids = side === "yes" ? book.noBids : book.yesBids;
  return oppositeBids
    .map((bid) => ({ price: PRICE_SCALE - bid.price, qty: bid.qty }))
    .sort((a, b) => a.price - b.price);
}

/** Best (cheapest) price to buy `side`, or null if that side has no liquidity. */
export function bestAsk(book: Book, side: Side): number | null {
  const asks = asksForBuying(book, side);
  return asks.length > 0 ? asks[0]!.price : null;
}

/** Convenience: executable cost to buy `sizeQtyUnits` of `side` from a book. */
export function costToBuy(book: Book, side: Side, sizeQtyUnits: number): Fill {
  return executableCost(asksForBuying(book, side), sizeQtyUnits);
}
