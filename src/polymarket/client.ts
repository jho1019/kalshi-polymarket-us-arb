/**
 * Polymarket US client — read-only public market data.
 *
 * Market data is PUBLIC: `new PolymarketUS()` is constructed with NO
 * credentials. Credentials are only for the authenticated surface
 * (orders/portfolio/account), which this phase never touches. Do not add
 * key-loading here.
 *
 * NOTE: the SDK's TypeScript types for `markets.book`/`markets.bbo` are wrong —
 * they declare a flat object, but the runtime wraps the payload in
 * `marketData`. We unwrap it here and describe the real shape with local types.
 */

import { PolymarketUS } from "polymarket-us";

/** A raw Polymarket price level as returned at runtime. */
export interface RawPmLevel {
  px: { value: string; currency: string };
  qty: string;
}

/** The real (unwrapped) runtime shape of a market book. */
export interface MarketData {
  marketSlug: string;
  bids: RawPmLevel[];
  offers: RawPmLevel[];
  state?: string;
  transactTime?: string;
}

/** The real (unwrapped) runtime shape of top-of-book. */
export interface BboData {
  marketSlug: string;
  bestBid?: { value: string; currency: string };
  bestAsk?: { value: string; currency: string };
  bidDepth?: number;
  askDepth?: number;
}

// Single public client — no keyId/secretKey, so only the public surface works.
const pm = new PolymarketUS();

/** Unwrap the SDK's `{ marketData: ... }` runtime envelope (types lie). */
function unwrap<T>(resp: unknown): T {
  const r = resp as { marketData?: T };
  return (r.marketData ?? resp) as T;
}

/** Fetch the raw order book for a single market slug (one outcome/token). */
export async function fetchBook(slug: string): Promise<MarketData> {
  const data = unwrap<MarketData>(await pm.markets.book(slug));
  if (!Array.isArray(data.bids) || !Array.isArray(data.offers)) {
    throw new Error(`Polymarket book for ${slug} missing bids/offers`);
  }
  return data;
}

/** Fetch top-of-book for a single market slug. */
export async function fetchBbo(slug: string): Promise<BboData> {
  return unwrap<BboData>(await pm.markets.bbo(slug));
}

/** Exposed for the demo: whether this client carries credentials (should be false). */
export const hasCredentials = pm.keyId !== undefined || pm.secretKey !== undefined;

/**
 * Demo helper: find a live binary (two-outcome) event whose BOTH outcome books
 * are open with resting offers, returning the slug pair. Market state is
 * time-of-day dependent, so the demo discovers a tradeable pair rather than
 * hardcoding one. Returns null if none is found.
 */
export async function findOpenBinaryPair(): Promise<{
  yesSlug: string;
  noSlug: string;
} | null> {
  const { events } = await pm.events.list({ active: true, closed: false, limit: 60 });
  for (const ev of events) {
    const markets = ev.markets ?? [];
    if (markets.length !== 2) continue;
    try {
      const [a, b] = [await fetchBook(markets[0]!.slug), await fetchBook(markets[1]!.slug)];
      const open = (d: MarketData) =>
        d.state === "MARKET_STATE_OPEN" && d.offers.length > 0;
      if (open(a) && open(b)) return { yesSlug: a.marketSlug, noSlug: b.marketSlug };
    } catch {
      continue;
    }
  }
  return null;
}
