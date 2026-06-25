/**
 * Hand-curated cross-venue pair registry schema + resolution-equivalence checks.
 *
 * Pairs are added ONLY after a human confirms identical resolution (Kalshi market
 * rules + Polymarket US `markets.settlement`). There is no fuzzy auto-matching.
 * The checklist is enforced at runtime: a pair cannot be marked verified unless
 * every equivalence dimension (source, timestamp, strike) is explicitly true.
 */

import type { Side } from "../book.js";

export interface MarketPair {
  pairId: string;
  description: string;
  /** Kalshi leg; `yesSide` is which Kalshi side maps to the pair's YES outcome. */
  kalshi: { ticker: string; yesSide: Side };
  /** Polymarket US leg: the two complementary outcome slugs (see #5). */
  polymarketUs: { yesSlug: string; noSlug: string };
  /** Both legs settle from the same source. */
  settlementSourceMatch: boolean;
  /** Both legs settle at the same time/observation. */
  settlementTimeMatch: boolean;
  /** Strikes match, OR the market has no strike (set true). */
  strikeMatch: boolean;
  /** Overall human sign-off; true requires all three match flags true. */
  resolutionVerified: boolean;
  /** ISO date "YYYY-MM-DD" the human verified the pair. */
  verifiedDate: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MarketPair.${field} must be a non-empty string`);
  }
}

function assertBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`MarketPair.${field} must be a boolean`);
  }
}

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Throw unless `x` is a structurally valid MarketPair with a consistent checklist. */
export function assertValidPair(x: unknown): asserts x is MarketPair {
  const p = x as MarketPair;
  if (!p || typeof p !== "object") throw new Error("MarketPair must be an object");

  assertNonEmptyString(p.pairId, "pairId");
  assertNonEmptyString(p.description, "description");

  if (!p.kalshi || typeof p.kalshi !== "object") {
    throw new Error("MarketPair.kalshi must be an object");
  }
  assertNonEmptyString(p.kalshi.ticker, "kalshi.ticker");
  if (p.kalshi.yesSide !== "yes" && p.kalshi.yesSide !== "no") {
    throw new Error(`MarketPair.kalshi.yesSide must be "yes" or "no"`);
  }

  if (!p.polymarketUs || typeof p.polymarketUs !== "object") {
    throw new Error("MarketPair.polymarketUs must be an object");
  }
  assertNonEmptyString(p.polymarketUs.yesSlug, "polymarketUs.yesSlug");
  assertNonEmptyString(p.polymarketUs.noSlug, "polymarketUs.noSlug");

  assertBoolean(p.settlementSourceMatch, "settlementSourceMatch");
  assertBoolean(p.settlementTimeMatch, "settlementTimeMatch");
  assertBoolean(p.strikeMatch, "strikeMatch");
  assertBoolean(p.resolutionVerified, "resolutionVerified");

  if (!isRealIsoDate(p.verifiedDate)) {
    throw new Error(`MarketPair.verifiedDate must be an ISO date "YYYY-MM-DD", got ${JSON.stringify(p.verifiedDate)}`);
  }

  // The checklist forces explicit confirmation: cannot be verified with any gap.
  if (
    p.resolutionVerified &&
    !(p.settlementSourceMatch && p.settlementTimeMatch && p.strikeMatch)
  ) {
    throw new Error(
      `MarketPair ${p.pairId}: resolutionVerified requires settlementSourceMatch, ` +
        `settlementTimeMatch, and strikeMatch to all be true`,
    );
  }
}

/** A pair is usable for arbitrage comparison only when human-verified. */
export function isVerified(pair: MarketPair): boolean {
  return pair.resolutionVerified;
}

/** Filter to the verified, tradeable-comparison pairs. */
export function getVerifiedPairs(pairs: readonly MarketPair[]): MarketPair[] {
  return pairs.filter(isVerified);
}
