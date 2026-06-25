# Add first hand-verified market pair(s)

Design for GitHub issue #12 (`phase:registry`). Research + curate the first cross-
venue pairs, extending the #11 schema to fit Polymarket US's real market shapes.

## Research findings (live, 2026-06-24)

- **PM US has no crypto markets** (categories: sports 733, politics 30, culture 6,
  macro 3, finance 3, climate 5). The issue's BTC suggestion is moot here.
- **Two PM US market shapes** for binary questions:
  - **Multi-candidate / winner events** (elections, championships): one slug *per
    outcome*. A specific outcome ("Dodgers win the WS") is a single team-token;
    there is NO single "Dodgers don't win" slug (that's the other 29 teams).
  - **Head-to-heads** (tennis, UFC): one `aec-…` market with a long/short book;
    no separate NO slug.
  In both, only ONE side's real book is fetchable via `markets.book(slug)`. Only a
  true 2-outcome event (e.g. midterms dem/rep) exposes two complementary slugs.
- **Kalshi** exposes a clean YES/NO binary per ticker for the matching question
  (`KXMLB-26-LAD` "win the championship", `KXATPMATCH-…-DRA` "win the match").

## Schema extension — `src/registry/schema.ts`

The #11 `polymarketUs: { yesSlug, noSlug }` only fits 2-outcome dual-slug events.
Replace it with a discriminated union covering both real shapes:

```ts
export type PolymarketUsLeg =
  | { kind: "dualSlug"; yesSlug: string; noSlug: string }       // true 2-outcome: both real books readable
  | { kind: "singleMarket"; slug: string; yesIsLong: boolean }; // one market; long side = YES iff yesIsLong
```

`singleMarket` means only the long side's real book is available, so only ONE arb
direction is measurable (the other strategy shows unfillable in `netEdge`) —
documented, not a defect. `assertValidPair` validates by `kind`. Everything else
from #11 is unchanged.

## The first pairs — `src/registry/pairs.ts`

Both are committed with `resolutionVerified: false` — they have been *reviewed*
(dimensions below all match), but final arb certification is a human sign-off and
both carry tail caveats. Logging is read-only and does not require verification;
`getVerifiedPairs` still excludes them until a human flips the flag. `verifiedDate`
records the review date.

### 1. `mlb-ws-2026-lad` (far-dated, ~Nov 2026)
- Kalshi `KXMLB-26-LAD` (yesSide "yes", "win the 2026 Pro Baseball Championship").
- PM US `singleMarket` `tec-mlb-champ-2026-09-27-lad` (`yesIsLong: true`).
- source ✓ (MLB World Series result), time ✓ (series end), strike ✓ (none).
- Caveat: cancellation/postponement fine print differs (PM "last fair price" vs
  Kalshi's rulebook) → tail divergence; not certified arb.

### 2. `atp-eastbourne-2026-draper` (near-dated, today)
- Kalshi `KXATPMATCH-26JUN25DRADIA-DRA` (yesSide "yes", "Draper win the QF").
- PM US `singleMarket` `aec-atp-jacdra-gabdia-2026-06-25` (`yesIsLong: true` —
  long side is the first-named player, Draper).
- source ✓ (ATP Eastbourne result), time ✓ (match end), strike ✓ (none); tennis
  has NO draw so PM's "$0.50 draw" clause never triggers.
- Caveat: walkover/retirement-before-play edge ("after a ball has been played");
  PM single-market means only one arb direction is measurable.

## Tests — `src/registry/schema.test.ts`

- Valid `singleMarket` and `dualSlug` entries pass `assertValidPair`.
- `resolutionVerified: true` with any sub-check false → throws.
- Malformed PM legs throw: unknown `kind`, empty slug, non-boolean `yesIsLong`,
  missing `noSlug` on dualSlug.
- The live `PAIRS` array (2 entries) all validate; both are unverified, so
  `getVerifiedPairs(PAIRS)` is empty.

## Out of scope

Wiring a `singleMarket` pair into `VenueLeg`/`netEdge` for live logging (logger
phase), and certifying any pair `resolutionVerified: true` (human sign-off after
full rulebook review). This issue delivers the schema extension + the first
reviewed entries.
