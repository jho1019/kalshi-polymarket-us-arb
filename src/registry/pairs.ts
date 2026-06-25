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

export const PAIRS: MarketPair[] = [
  {
    pairId: "mlb-ws-2026-lad",
    description:
      "2026 MLB World Series — Los Angeles Dodgers to win. Both legs settle on " +
      "the official World Series result (no strike). REVIEWED, not certified: " +
      "cancellation/postponement fine print differs (PM US settles at last fair " +
      "price; Kalshi per its rulebook), a tail divergence -> resolutionVerified false.",
    kalshi: { ticker: "KXMLB-26-LAD", yesSide: "yes" },
    polymarketUs: { kind: "singleMarket", slug: "tec-mlb-champ-2026-09-27-lad", yesIsLong: true },
    settlementSourceMatch: true,
    settlementTimeMatch: true,
    strikeMatch: true,
    resolutionVerified: false,
    verifiedDate: "2026-06-24",
  },
  {
    pairId: "atp-eastbourne-2026-draper",
    description:
      "2026 ATP Eastbourne QF — Jack Draper to beat Gabriel Diallo. Both legs " +
      "settle on the official ATP match result (no strike; tennis has no draw, so " +
      "PM US's $0.50-draw clause never triggers). REVIEWED, not certified: " +
      "walkover/retirement-before-play edge case, and PM US is a single-market so " +
      "only one arb direction is measurable -> resolutionVerified false.",
    kalshi: { ticker: "KXATPMATCH-26JUN25DRADIA-DRA", yesSide: "yes" },
    polymarketUs: { kind: "singleMarket", slug: "aec-atp-jacdra-gabdia-2026-06-25", yesIsLong: true },
    settlementSourceMatch: true,
    settlementTimeMatch: true,
    strikeMatch: true,
    resolutionVerified: false,
    verifiedDate: "2026-06-24",
  },
];
