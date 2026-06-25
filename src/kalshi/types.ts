/**
 * Kalshi order book types — raw API shape and the normalized integer form.
 *
 * The orderbook endpoint returns ONLY `orderbook_fp` (no integer-cents
 * variant). Each level is `[priceDollarsString, quantityFixedPointString]`,
 * and only BIDS are returned: `yes_dollars` are YES bids, `no_dollars` are NO
 * bids. A YES bid at X is equivalent to a NO ask at (1 − X).
 */

import type { Level } from "../book.js";

/** One raw price level: [price dollar-string, quantity fixed-point string]. */
export type RawLevel = [string, string];

export interface RawOrderbook {
  orderbook_fp: {
    yes_dollars: RawLevel[];
    no_dollars: RawLevel[];
  };
}

/** A normalized book: bids only, as returned by Kalshi. */
export interface Book {
  ticker: string;
  yesBids: Level[];
  noBids: Level[];
}
