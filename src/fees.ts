/**
 * Venue-neutral fee math.
 *
 * Both Kalshi and Polymarket US charge `Θ × C × price × (1 − price)` (Θ = a fee
 * coefficient, C = contracts), so the exact integer core lives here once. The
 * fee is returned in 1/10000-dollar units (centicents), ceil'd up — a centicent
 * is one unit in the project's money model.
 *
 * The product overflows JS safe integers past ~5k contracts, so it is computed
 * in BigInt with a ceil-division; only the (small) result becomes a number. No
 * floats.
 */

import { PRICE_SCALE, QTY_SCALE } from "./money.js";

/** Coefficient scale: coefficient = coefficientBps / BPS_SCALE (700 bps = 0.07). */
export const BPS_SCALE = 10_000;

// feeUnits = ceil( coefficientBps · P · (S−P) · Q / (BPS_SCALE · S · QTY_SCALE) )
const FEE_DENOM = BigInt(BPS_SCALE) * BigInt(PRICE_SCALE) * BigInt(QTY_SCALE);

/**
 * Fee in 1/10000-dollar units for `Θ × C × p × (1 − p)`, ceil'd to a centicent.
 *
 * @param priceUnits     Price in 1/10000-$ units, in [0, PRICE_SCALE].
 * @param qtyUnits       Quantity in 1/10000-contract units (e.g. Fill.filledSize).
 * @param coefficientBps Fee coefficient Θ in basis points (e.g. 700 = 0.07).
 */
export function feeUnits(
  priceUnits: number,
  qtyUnits: number,
  coefficientBps: number,
): number {
  if (!Number.isInteger(priceUnits) || priceUnits < 0 || priceUnits > PRICE_SCALE) {
    throw new Error(`feeUnits: priceUnits must be an integer in [0, ${PRICE_SCALE}], got ${priceUnits}`);
  }
  if (!Number.isInteger(qtyUnits) || qtyUnits < 0) {
    throw new Error(`feeUnits: qtyUnits must be a non-negative integer, got ${qtyUnits}`);
  }
  if (!Number.isInteger(coefficientBps) || coefficientBps < 0) {
    throw new Error(`feeUnits: coefficientBps must be a non-negative integer, got ${coefficientBps}`);
  }

  const numerator =
    BigInt(coefficientBps) *
    BigInt(priceUnits) *
    BigInt(PRICE_SCALE - priceUnits) *
    BigInt(qtyUnits);
  // Ceil-division (numerator is non-negative).
  return Number((numerator + FEE_DENOM - 1n) / FEE_DENOM);
}
