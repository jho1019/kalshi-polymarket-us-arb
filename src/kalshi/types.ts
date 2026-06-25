/**
 * Kalshi order book types — raw API shape and the normalized integer form.
 *
 * The orderbook endpoint returns ONLY `orderbook_fp` (no integer-cents
 * variant). Each level is `[priceDollarsString, quantityFixedPointString]`,
 * and only BIDS are returned: `yes_dollars` are YES bids, `no_dollars` are NO
 * bids. A YES bid at X is equivalent to a NO ask at (1 − X).
 */

/** One raw price level: [price dollar-string, quantity fixed-point string]. */
export type RawLevel = [string, string];

export interface RawOrderbook {
  orderbook_fp: {
    yes_dollars: RawLevel[];
    no_dollars: RawLevel[];
  };
}

export type Side = "yes" | "no";

/** A normalized level: integer 1/10000-dollar price and 1/10000-contract qty. */
export interface Level {
  price: number;
  qty: number;
}

/** A normalized book: bids only, as returned by Kalshi. */
export interface Book {
  ticker: string;
  yesBids: Level[];
  noBids: Level[];
}

/** Result of walking the book to buy a requested size on one side. */
export interface Fill {
  /** True iff the full requested size was filled. */
  fillable: boolean;
  /** Qty units actually filled (= requested if fillable, else max available). */
  filledSize: number;
  /** Exact integer cost; price*qty summed, units of 1e-8 dollar. */
  totalCost: number;
  /** Rounded integer 1/10000-$/contract; null iff filledSize === 0. */
  avgCost: number | null;
  /** Number of price levels consumed (fully or partially). */
  levelsConsumed: number;
}
