/**
 * Unit tests for the pair registry schema + resolution-equivalence checklist
 * (issue #11).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PAIRS } from "./pairs.js";
import {
  assertValidPair,
  getVerifiedPairs,
  isVerified,
  type MarketPair,
} from "./schema.js";

function sample(overrides: Partial<MarketPair> = {}): MarketPair {
  return {
    pairId: "us-house-midterms-2026",
    description: "US House midterm winner — Democratic party",
    kalshi: { ticker: "KXHOUSE-26-DEM", yesSide: "yes" },
    polymarketUs: {
      yesSlug: "paccc-usho-midterms-2026-11-03-dem",
      noSlug: "paccc-usho-midterms-2026-11-03-rep",
    },
    settlementSourceMatch: true,
    settlementTimeMatch: true,
    strikeMatch: true,
    resolutionVerified: true,
    verifiedDate: "2026-06-24",
    ...overrides,
  };
}

test("a valid verified entry passes assertValidPair", () => {
  assert.doesNotThrow(() => assertValidPair(sample()));
});

test("resolutionVerified with a failed sub-check throws", () => {
  for (const gap of [
    { settlementSourceMatch: false },
    { settlementTimeMatch: false },
    { strikeMatch: false },
  ] as Partial<MarketPair>[]) {
    assert.throws(
      () => assertValidPair(sample({ ...gap, resolutionVerified: true })),
      /resolutionVerified requires/,
    );
  }
});

test("unverified-but-consistent entry is valid but not tradeable", () => {
  const pending = sample({ resolutionVerified: false, strikeMatch: false });
  assert.doesNotThrow(() => assertValidPair(pending));
  assert.equal(isVerified(pending), false);
  assert.deepEqual(getVerifiedPairs([pending, sample()]), [sample()]);
});

test("malformed fields throw", () => {
  assert.throws(() => assertValidPair(sample({ pairId: "" })));
  assert.throws(() => assertValidPair(sample({ kalshi: { ticker: "", yesSide: "yes" } })));
  // @ts-expect-error invalid yesSide
  assert.throws(() => assertValidPair(sample({ kalshi: { ticker: "X", yesSide: "maybe" } })));
  assert.throws(() =>
    assertValidPair(sample({ polymarketUs: { yesSlug: "a", noSlug: "" } })),
  );
  // @ts-expect-error non-boolean check
  assert.throws(() => assertValidPair(sample({ strikeMatch: "true" })));
  assert.throws(() => assertValidPair(sample({ verifiedDate: "06/24/2026" })));
  assert.throws(() => assertValidPair(sample({ verifiedDate: "2026-13-40" })));
});

test("non-object input throws", () => {
  assert.throws(() => assertValidPair(null));
  assert.throws(() => assertValidPair(undefined));
});

test("live PAIRS registry is valid (every entry)", () => {
  for (const pair of PAIRS) assert.doesNotThrow(() => assertValidPair(pair));
});
