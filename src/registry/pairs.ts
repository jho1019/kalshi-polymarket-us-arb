/**
 * The hand-curated cross-venue pair registry.
 *
 * EMPTY BY DESIGN. A pair is added ONLY after a human verifies identical
 * resolution between the venues — there is no fuzzy auto-matching, and shipping
 * an unverified ("fake-verified") pair would risk capital on a non-arb.
 *
 * To add a pair:
 *   1. Read the Kalshi market rules and the Polymarket US `markets.settlement`
 *      for both legs.
 *   2. Confirm the SAME settlement source, the SAME settlement time/observation,
 *      and (for bracketed markets) the SAME strike.
 *   3. Add a MarketPair with each checklist boolean reflecting reality and
 *      `resolutionVerified: true` only if all three match; set `verifiedDate`.
 *      `assertValidPair` rejects an inconsistent entry.
 */

import type { MarketPair } from "./schema.js";

export const PAIRS: MarketPair[] = [];
