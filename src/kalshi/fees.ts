/**
 * Kalshi taker fee estimator.
 *
 * fee = 0.07 × price × (1 − price) × contracts, rounded UP to the nearest
 * centicent ($0.0001). Per the official docs
 * (docs.kalshi.com/getting_started/fee_rounding) Kalshi rounds up to a centicent,
 * which is exactly one unit in this project's 1/10000-dollar money model — so the
 * fee is returned in the same units as prices/costs, with no separate "cents".
 *
 * The 0.07 coefficient is Kalshi's general rate (700 bps); some markets differ,
 * so the rate is an optional basis-points parameter.
 *
 * All math is exact: the product overflows JS safe integers past ~5k contracts,
 * so it runs in BigInt with a ceil-division and only the (small) result is
 * returned as a number. No floats.
 */

import { PRICE_SCALE, QTY_SCALE } from "../money.js";

/** Fee rate denominator: rate = rateBps / BPS_SCALE (700 bps = 0.07). */
const BPS_SCALE = 10_000;
const DEFAULT_RATE_BPS = 700;

// feeUnits = ceil( rateBps · P · (S−P) · Q / (BPS_SCALE · S · QTY_SCALE) )
const FEE_DENOM = BigInt(BPS_SCALE) * BigInt(PRICE_SCALE) * BigInt(QTY_SCALE);

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
  const rateBps = opts.rateBps ?? DEFAULT_RATE_BPS;

  if (!Number.isInteger(priceUnits) || priceUnits < 0 || priceUnits > PRICE_SCALE) {
    throw new Error(`takerFee: priceUnits must be an integer in [0, ${PRICE_SCALE}], got ${priceUnits}`);
  }
  if (!Number.isInteger(qtyUnits) || qtyUnits < 0) {
    throw new Error(`takerFee: qtyUnits must be a non-negative integer, got ${qtyUnits}`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new Error(`takerFee: rateBps must be a non-negative integer, got ${rateBps}`);
  }

  const numerator =
    BigInt(rateBps) *
    BigInt(priceUnits) *
    BigInt(PRICE_SCALE - priceUnits) *
    BigInt(qtyUnits);
  // Ceil-division (numerator is non-negative).
  const fee = (numerator + FEE_DENOM - 1n) / FEE_DENOM;
  return Number(fee);
}
