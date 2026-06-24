/**
 * Project configuration constants.
 *
 * Kalshi REST base URL. Pinned from the official OpenAPI spec at
 * https://docs.kalshi.com/api-reference, where `external-api.kalshi.com` is the
 * designated primary "Production Trade API server". (`api.elections.kalshi.com`
 * is listed only as an alternative; older base URLs that circulate on blogs are
 * NOT authoritative — see CLAUDE.md.)
 *
 * Includes the `/trade-api/v2` prefix so endpoint paths read cleanly, e.g.
 * `${KALSHI_API_BASE}/markets` and `${KALSHI_API_BASE}/markets/{ticker}`.
 */
export const KALSHI_API_BASE = "https://external-api.kalshi.com/trade-api/v2";
