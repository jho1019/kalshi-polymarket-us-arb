/**
 * Venue-neutral order book primitives shared by Kalshi and Polymarket US.
 *
 * A `Level` is a single price/quantity rung in integer units (see money.ts:
 * price = 1/10000 dollar, qty = 1/10000 contract). Each venue normalizes its
 * own raw book into best-first ask `Level[]`, then feeds the SAME
 * `executableCost` engine — the depth-walk and `Fill` math live here exactly
 * once because they are money-critical.
 */

export type Side = "yes" | "no";

/** A normalized level: integer 1/10000-dollar price and 1/10000-contract qty. */
export interface Level {
  price: number;
  qty: number;
}

/** Result of walking a book's asks to buy a requested size on one side. */
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

/**
 * Walk `asks` (best-first) to buy `sizeQtyUnits` (1/10000-contract units),
 * returning executable cost. Partial last level is allowed. If depth is
 * insufficient, returns `fillable: false` with the partial fill — never throws
 * ("unfillable, not a crash").
 */
export function executableCost(asks: Level[], sizeQtyUnits: number): Fill {
  let remaining = sizeQtyUnits;
  let filledSize = 0;
  let totalCost = 0;
  let levelsConsumed = 0;

  for (const level of asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.qty);
    totalCost += level.price * take;
    filledSize += take;
    remaining -= take;
    levelsConsumed += 1;
  }

  return {
    fillable: remaining <= 0 && sizeQtyUnits > 0,
    filledSize,
    totalCost,
    avgCost: filledSize > 0 ? Math.round(totalCost / filledSize) : null,
    levelsConsumed,
  };
}
