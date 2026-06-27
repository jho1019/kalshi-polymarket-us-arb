/**
 * Kalshi taker fee estimator.
 *
 * fee = 0.07 × price × (1 − price) × contracts, rounded UP to the nearest
 * centicent ($0.0001). Per the official docs
 * (docs.kalshi.com/getting_started/fee_rounding) Kalshi rounds up to a centicent,
 * which is exactly one unit in this project's 1/10000-dollar money model.
 *
 * The 0.07 coefficient is Kalshi's general rate (700 bps); some markets differ,
 * so the rate is an optional basis-points parameter. The shared `feeUnits` core
 * handles the exact BigInt math.
 */

import { feeUnits } from "../fees.js";

/** Kalshi general taker rate: 700 bps = 0.07. */
export const KALSHI_TAKER_BPS = 700;

/**
 * Taker fee in 1/10000-dollar units.
 *
 * @param priceUnits Price in 1/10000-$ units, in [0, PRICE_SCALE].
 * @param qtyUnits   Quantity in 1/10000-contract units (e.g. Fill.filledSize).
 * @param opts.rateBps Fee rate in basis points; defaults to 700 (0.07).
 */
export function takerFee(
  priceUnits: number,
  qtyUnits: number,
  opts: { rateBps?: number } = {},
): number {
  return feeUnits(priceUnits, qtyUnits, opts.rateBps ?? KALSHI_TAKER_BPS);
}
