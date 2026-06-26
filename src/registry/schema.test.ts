/**
 * Unit tests for the pair registry schema + resolution-equivalence checklist
 * (issues #11, #12).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PAIRS } from "./pairs.js";
import {
  assertValidPair,
  getLoggablePairs,
  getVerifiedPairs,
  isReviewed,
  isVerified,
  type MarketPair,
} from "./schema.js";

function sample(overrides: Partial<MarketPair> = {}): MarketPair {
  return {
    pairId: "atp-eastbourne-2026-draper",
    description: "Draper to beat Diallo, ATP Eastbourne QF",
    kalshi: { ticker: "KXATPMATCH-26JUN25DRADIA-DRA", yesSide: "yes" },
    polymarketUs: { kind: "singleMarket", slug: "aec-atp-jacdra-gabdia-2026-06-25", yesIsLong: true },
    settlementSourceMatch: true,
    settlementTimeMatch: true,
    strikeMatch: true,
    resolutionVerified: true,
    verifiedDate: "2026-06-24",
    ...overrides,
  };
}

test("valid singleMarket and dualSlug entries pass assertValidPair", () => {
  assert.doesNotThrow(() => assertValidPair(sample()));
  assert.doesNotThrow(() =>
    assertValidPair(
      sample({
        polymarketUs: { kind: "dualSlug", yesSlug: "paccc-...-dem", noSlug: "paccc-...-rep" },
      }),
    ),
  );
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

test("malformed PM US legs throw", () => {
  // @ts-expect-error unknown kind
  assert.throws(() => assertValidPair(sample({ polymarketUs: { kind: "weird", slug: "x" } })));
  assert.throws(() =>
    assertValidPair(sample({ polymarketUs: { kind: "singleMarket", slug: "", yesIsLong: true } })),
  );
  // @ts-expect-error non-boolean yesIsLong
  assert.throws(() => assertValidPair(sample({ polymarketUs: { kind: "singleMarket", slug: "x", yesIsLong: "yes" } })));
  // @ts-expect-error dualSlug missing noSlug
  assert.throws(() => assertValidPair(sample({ polymarketUs: { kind: "dualSlug", yesSlug: "a" } })));
});

test("other malformed fields throw", () => {
  assert.throws(() => assertValidPair(sample({ pairId: "" })));
  // @ts-expect-error invalid yesSide
  assert.throws(() => assertValidPair(sample({ kalshi: { ticker: "X", yesSide: "maybe" } })));
  assert.throws(() => assertValidPair(sample({ verifiedDate: "06/24/2026" })));
  assert.throws(() => assertValidPair(sample({ verifiedDate: "2026-13-40" })));
  assert.throws(() => assertValidPair(null));
});

test("live PAIRS registry: every entry valid; first reviewed pairs present", () => {
  for (const pair of PAIRS) assert.doesNotThrow(() => assertValidPair(pair));
  assert.ok(PAIRS.some((p) => p.pairId === "mlb-ws-2026-lad"));
  assert.ok(PAIRS.some((p) => p.pairId === "atp-eastbourne-2026-draper"));
  // Both are reviewed-not-certified, so none are tradeable-verified yet.
  assert.deepEqual(getVerifiedPairs(PAIRS), []);
});

test("isReviewed is true when all three dimension flags are true, even if not certified", () => {
  assert.equal(isReviewed(sample({ resolutionVerified: false })), true);
});

test("isReviewed is false if any dimension flag is false", () => {
  assert.equal(isReviewed(sample({ settlementSourceMatch: false })), false);
  assert.equal(isReviewed(sample({ settlementTimeMatch: false })), false);
  assert.equal(isReviewed(sample({ strikeMatch: false })), false);
});

test("getLoggablePairs keeps reviewed pairs and drops unreviewed", () => {
  const reviewed = sample({ pairId: "a" });
  const unreviewed = sample({ pairId: "b", strikeMatch: false });
  assert.deepEqual(getLoggablePairs([reviewed, unreviewed]), [reviewed]);
});

test("live PAIRS: both current pairs are loggable (reviewed) though none are verified", () => {
  assert.equal(getLoggablePairs(PAIRS).length, PAIRS.length);
});
