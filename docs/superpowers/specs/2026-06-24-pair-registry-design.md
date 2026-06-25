# Pair registry schema + resolution-equivalence checklist

Design for GitHub issue #11 (`phase:registry`). Hand-curated cross-venue pairs
only — NO fuzzy auto-matching. Resolution equivalence is confirmed by a human
(Kalshi market rules + Polymarket US `markets.settlement`) and recorded as an
explicit checklist the runtime enforces.

## Reconciliation with verified models (approved)

- **Polymarket US side uses `{ yesSlug, noSlug }`**, not the issue's
  `{ marketSlug, yesToken, noToken }`. #5 verified PM US has no "tokens" — each
  outcome is its own slug (the `PmPair` model), which is what `fetchBook(slug)`
  and the edge calc consume. "yesToken/noToken" is international-Polymarket
  terminology and does not apply here.
- **Timestamp gets its own `settlementTimeMatch` field.** The verify item
  requires confirming identical resolution source, timestamp, AND strike, but the
  issue's field list omitted timestamp. A differing settlement *time* (e.g. Kalshi
  on a 4pm print vs PM US on another snapshot) is an independent failure mode, so
  it is an explicit boolean.

## Schema — `src/registry/schema.ts`

```ts
export interface MarketPair {
  pairId: string;
  description: string;
  kalshi: { ticker: string; yesSide: "yes" | "no" }; // which Kalshi side is the pair's YES
  polymarketUs: { yesSlug: string; noSlug: string };
  // resolution-equivalence checklist:
  settlementSourceMatch: boolean;
  settlementTimeMatch: boolean;
  strikeMatch: boolean;        // true if strikes match OR the market has no strike
  resolutionVerified: boolean; // overall human sign-off
  verifiedDate: string;        // ISO date "YYYY-MM-DD"
}
```

`kalshi.yesSide` lets a Kalshi market whose native YES is the opposite outcome
still be paired (usually "yes"). `strikeMatch` is a boolean; for non-bracketed
markets (no strike) the curator sets it `true` ("no strike mismatch").

## Runtime validation + verification gate — same file

- `assertValidPair(x): asserts x is MarketPair` — structural checks: non-empty
  `pairId`/`description`/`ticker`/`yesSlug`/`noSlug`; `yesSide ∈ {yes,no}`; all
  four booleans are real booleans; `verifiedDate` matches `^\d{4}-\d{2}-\d{2}$`
  and is a real calendar date.
- **Consistency rule (forces explicit confirmation):** if
  `resolutionVerified === true`, then `settlementSourceMatch &&
  settlementTimeMatch && strikeMatch` must all be true — otherwise throw. A pair
  cannot be marked verified while any checklist item is false.
- `isVerified(pair): boolean` → `pair.resolutionVerified` (the gate consumers
  check before any comparison/logging).
- `getVerifiedPairs(pairs): MarketPair[]` — filters to verified entries.

## Registry data — `src/registry/pairs.ts`

```ts
export const PAIRS: MarketPair[] = []; // empty until a human verifies real pairs
```

Ships **empty by design**: no market has been manually verified yet (that needs
hand research of Kalshi rules + PM `markets.settlement`), and shipping a fake
"verified" pair would be the exact capital-risk mistake the safety rules forbid.
A header comment documents the procedure: verify resolution equivalence by hand,
then add an entry with the checklist booleans and `verifiedDate` set. The sample
entry lives in the tests, not the live registry.

## Tests — `src/registry/schema.test.ts` (node:test)

- A sample valid entry passes `assertValidPair` (TS type + runtime check).
- `resolutionVerified: true` with any sub-check false → throws (forces explicit
  confirmation of source, timestamp, strike).
- Malformed fields (empty ticker, bad `yesSide`, malformed `verifiedDate`,
  non-boolean check) → throw.
- An unverified but structurally valid entry passes `assertValidPair`, but
  `isVerified` is false and `getVerifiedPairs` excludes it.
- The live `PAIRS` array passes `assertValidPair` for every entry (currently
  none) — guards against a future bad hand edit.

## Out of scope

Live fetching, wiring a pair into `VenueLeg`/net-edge, and actually curating real
pairs (a human research task). This issue is the schema + checklist + runtime
validation only.
