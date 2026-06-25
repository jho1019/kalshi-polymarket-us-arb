/**
 * Kalshi REST client — read-only order book fetch.
 *
 * The orderbook endpoint is PUBLIC: NO credentials, NO auth headers. This is a
 * deliberate invariant of the logger phase (see CLAUDE.md safety rules). Do not
 * add key-loading here.
 */

import { KALSHI_API_BASE } from "../config.js";
import type { RawOrderbook } from "./types.js";

/**
 * Fetch the raw order book for a market.
 *
 * @param ticker Kalshi market ticker, e.g. "KXBTCD-26JUN2517-T72249.99".
 * @param depth  0/omitted = all levels; 1-100 = that many levels per side.
 */
export async function fetchOrderbook(
  ticker: string,
  depth?: number,
): Promise<RawOrderbook> {
  const url = new URL(
    `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`,
  );
  if (depth !== undefined) {
    url.searchParams.set("depth", String(depth));
  }

  const res = await fetch(url); // no auth headers — public endpoint
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(
      `Kalshi orderbook fetch failed for ${ticker}: ${res.status} ${res.statusText} ${body}`,
    );
  }

  const json = (await res.json()) as Partial<RawOrderbook>;
  if (!json.orderbook_fp) {
    throw new Error(
      `Kalshi orderbook response for ${ticker} missing 'orderbook_fp'`,
    );
  }
  return json as RawOrderbook;
}
