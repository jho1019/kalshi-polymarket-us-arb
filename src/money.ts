/**
 * Project-wide money/price representation.
 *
 * Prices and quantities are stored as INTEGERS in fixed scales — never JS
 * floats (see CLAUDE.md). Kalshi returns 4-decimal dollar strings (e.g.
 * "0.9900") and fixed-point quantities (e.g. "45.00"); we parse those to exact
 * integers and only format back to strings for display.
 *
 *   price unit = 1/10000 dollar  (PRICE_SCALE = 10000, so $1 === 10000)
 *   qty unit   = 1/10000 contract (QTY_SCALE   = 10000)
 *
 * Integer cents was rejected: it would discard the sub-cent precision the
 * fractional API returns, which is exactly the dimension this project measures.
 */

export const PRICE_SCALE = 10000;
export const QTY_SCALE = 10000;

/**
 * Parse a non-negative fixed-point decimal STRING to an integer at `scale`,
 * using string math only (no float intermediate). Throws on malformed input or
 * on more decimal digits than `scale` can represent — we fail loud rather than
 * silently rounding away precision.
 */
export function parseFixed(value: string, scale: number): number {
  const decimals = Math.log10(scale);
  if (!Number.isInteger(decimals)) {
    throw new Error(`scale must be a power of 10, got ${scale}`);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`malformed fixed-point number: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `too much precision in ${JSON.stringify(value)}: ${frac.length} decimals ` +
        `exceeds scale ${scale} (${decimals} decimals)`,
    );
  }
  const fracPadded = frac.padEnd(decimals, "0");
  return Number(whole) * scale + Number(fracPadded);
}

/** Parse a Kalshi price dollar-string ("0.9900") to 1/10000-dollar units. */
export function parsePrice(value: string): number {
  return parseFixed(value, PRICE_SCALE);
}

/** Parse a Kalshi quantity string ("45.00") to 1/10000-contract units. */
export function parseQty(value: string): number {
  return parseFixed(value, QTY_SCALE);
}

/** Format integer units at `scale` back to a fixed-point string (display only). */
export function formatFixed(units: number, scale: number): string {
  const decimals = Math.log10(scale);
  const sign = units < 0 ? "-" : "";
  const abs = Math.abs(units);
  const whole = Math.floor(abs / scale);
  const frac = (abs % scale).toString().padStart(decimals, "0");
  return `${sign}${whole}.${frac}`;
}

/** Format 1/10000-dollar price units as a dollar string ("0.9900"). */
export function formatPrice(units: number): string {
  return formatFixed(units, PRICE_SCALE);
}

/** Format 1/10000-contract qty units as a contract string ("45.0000"). */
export function formatQty(units: number): string {
  return formatFixed(units, QTY_SCALE);
}
