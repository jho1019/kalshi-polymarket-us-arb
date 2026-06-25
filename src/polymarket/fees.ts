/**
 * Polymarket US fee estimator. Source: https://docs.polymarket.us/fees
 *
 * Fee = Θ × C × price × (1 − price). Taker Θ = 0.05; maker rebate Θ = 0.0125
 * (= 25% of taker, paid as a credit at execution). Fees return in 1/10000-$
 * units (ceil to centicent via the shared `feeUnits` core).
 *
 * The page lists NO settlement and NO withdrawal fees. A time-limited volume
 * promo (30% taker rebate for >$250k taker volume 2026-05-15..2026-06-30) is NOT
 * modeled here — it is date-bound and volume-conditional, not a per-trade fee.
 */

import { feeUnits } from "../fees.js";

/** Taker fee coefficient: 500 bps = 0.05. */
export const PM_TAKER_BPS = 500;
/** Maker rebate coefficient: 125 bps = 0.0125 (25% of taker). */
export const PM_MAKER_REBATE_BPS = 125;

/**
 * Taker fee in 1/10000-dollar units (a cost).
 *
 * @param priceUnits Price in 1/10000-$ units, in [0, PRICE_SCALE].
 * @param qtyUnits   Quantity in 1/10000-contract units (e.g. Fill.filledSize).
 */
export function takerFee(priceUnits: number, qtyUnits: number): number {
  return feeUnits(priceUnits, qtyUnits, PM_TAKER_BPS);
}

/**
 * Maker rebate in 1/10000-dollar units, returned as a positive credit (the
 * amount received for providing liquidity).
 */
export function makerRebate(priceUnits: number, qtyUnits: number): number {
  return feeUnits(priceUnits, qtyUnits, PM_MAKER_REBATE_BPS);
}
