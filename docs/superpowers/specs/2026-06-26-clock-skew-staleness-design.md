# Capture clock skew and book staleness per opportunity

Design for GitHub issue #14 (`phase:logger`). An apparent spread where the two
legs' books were captured seconds apart is staleness, not edge. This adds the
per-opportunity timing metadata — `bookSkewMs` between the legs and per-leg
staleness — plus freshness filters, so the analysis phase can separate real
simultaneous spreads from artifacts.

## Scope (approved)

#14 delivers a **pure `Opportunity` data model + skew/staleness computation +
freshness filters**, plus the small `tsLocalMs`-semantics fix the timing rests
on. It does NOT add the live sampling loop or persistence — that is #15
(append-only storage: raw snapshots + computed opportunities), which calls this
builder and stores its output. Everything here is deterministic and
unit-testable: feed snapshots with known timestamps, assert the numbers.

## Decision: skew is measured from `tsLocalMs`, not `tsVenue` (approved)

Each `BookSnapshot` carries `tsLocalMs` (when *we* updated the book locally) and
optional `tsVenue` (the venue's own server clock). `bookSkewMs` and staleness are
computed from **`tsLocalMs`** — the same local clock for both legs — so the skew
is a true measure of how far apart *our two captures* were. `tsVenue` is recorded
upstream but NOT used for skew math: comparing Kalshi's server clock to
Polymarket's folds in two independent, unsynchronized exchange clocks plus return
network delay, which is not a trustworthy quantity. The honest measurement is
"how far apart did we see these two books," which is also what a latency-bound
logger can act on.

## Foundation fix: `tsLocalMs` must mean "last book-update time"

Staleness is meaningless unless `tsLocalMs` reflects when the book last *changed*.
The shipped feeds disagree on pulled snapshots:

- **Polymarket** stores each book at message-receipt time and `getSnapshot`
  returns that stored snapshot → `tsLocalMs` = last-update time. Correct.
- **Kalshi** `getSnapshot` rebuilds the snapshot with `Date.now()` at *pull* time
  (`src/kalshi/feed.ts:67`) → a Kalshi book always looks fresh (age ≈ 0) even if
  it has not ticked in an hour. This silently defeats staleness.

Fix (make `KalshiLiveBook` own its update time, so it is unit-testable):

- `applySnapshot(msg, seq, tsLocalMs)` and `applyDelta(msg, seq, tsLocalMs)`
  record a private `lastUpdateMs`.
- `toSnapshot(side)` stamps `BookSnapshot.tsLocalMs` from `lastUpdateMs` (drops
  the passed-in `meta.tsLocalMs`).
- `KalshiFeed` captures `Date.now()` at message receipt and passes it into the
  apply calls; `getSnapshot` and the push/emit path then both report the true
  last-update time.
- PM already behaves this way — no change.
- `src/kalshi/live-book.test.ts` updates to the new signatures and adds an
  assertion that `toSnapshot` reflects the last applied update's time. The seq
  baseline / gap behavior is unchanged.

## The `Opportunity` model (`src/opportunity.ts`)

```ts
import type { Venue } from "./snapshot.js";
import type { NetEdgeReport } from "./edge.js";

export interface OpportunityLeg {
  venue: Venue;          // "kalshi" | "polymarket-us"
  tsLocalMs: number;     // representative last-update time for this leg
  ageMs: number;         // captureMs − tsLocalMs (staleness at compute time)
  stale: boolean;        // feed stale flag (awaiting a fresh snapshot after a drop)
}

export interface Opportunity {
  pairId: string;        // registry MarketPair.pairId
  captureMs: number;     // when computed (local clock)
  bookSkewMs: number;    // |legA.tsLocalMs − legB.tsLocalMs|
  legA: OpportunityLeg;
  legB: OpportunityLeg;
  edge: NetEdgeReport;   // existing net-edge result
}
```

The record carries timing facts + the edge, NOT the raw books. #15 persists raw
snapshots separately and joins by `pairId` / `tsLocalMs`, keeping opportunities
compact.

## The builder (pure computation)

```ts
export interface OpportunityLegInput {
  venue: Venue;
  snapshots: BookSnapshot[]; // the book(s) this leg used (1 for Kalshi / PM single,
                             // 2 for PM dual-slug yes+no)
  stale: boolean;
}

export interface BuildOpportunityInput {
  pairId: string;
  captureMs: number;
  legA: OpportunityLegInput;
  legB: OpportunityLegInput;
  edge: NetEdgeReport;
}

export function buildOpportunity(input: BuildOpportunityInput): Opportunity;
```

Per leg, the **representative `tsLocalMs` = `min` over that leg's contributing
snapshots** — a leg is only as fresh as its *stalest* book, which matters for PM
dual-slug where YES and NO are two books that can tick at different times. Then
`ageMs = captureMs − tsLocalMs` and `bookSkewMs = |legA.tsLocalMs −
legB.tsLocalMs|`. A leg input with an empty `snapshots` array is a programming
error (no book to time) and throws.

## Freshness filters

```ts
export function withinSkew(opp: Opportunity, maxSkewMs: number): boolean;
export function bothFresh(opp: Opportunity, maxAgeMs: number): boolean;
```

- `withinSkew` → `opp.bookSkewMs <= maxSkewMs`. The **headline** filter ("the two
  books are seconds apart = staleness"); the verify checkbox's "fresh within X ms"
  is skew-based.
- `bothFresh` → both legs' `ageMs <= maxAgeMs`. Catches an individually stale /
  illiquid book even when the two legs are equally old.

Both are inclusive at the boundary (`<=`).

## Files & testing

- `src/opportunity.ts` — `OpportunityLeg`, `Opportunity`, `OpportunityLegInput`,
  `BuildOpportunityInput`, `buildOpportunity`, `withinSkew`, `bothFresh`.
- `src/opportunity.test.ts` — known-timestamp snapshots assert: `bookSkewMs` for a
  2-book pair; per-leg `ageMs`; the dual-slug min-time rule (leg takes the older
  of its two books); `withinSkew` and `bothFresh` include/exclude exactly at the
  boundary (directly satisfies both verify checkboxes); empty-snapshots input
  throws.
- `src/kalshi/live-book.ts` + `src/kalshi/feed.ts` + updated
  `src/kalshi/live-book.test.ts` — the `tsLocalMs` = last-update-time fix.

## Constraints

- All timestamps are integer ms since epoch (`number`), consistent with
  `BookSnapshot.tsLocalMs`. No floats; durations are integer ms subtraction.
- Pure module: `src/opportunity.ts` has no I/O and no `Date.now()` — `captureMs`
  is always passed in (the #15 loop supplies `Date.now()`), keeping it
  deterministic and testable.
- READ-ONLY phase: no order placement; this only reads snapshots and the edge
  result.
- Reuse existing types (`BookSnapshot`, `Venue`, `NetEdgeReport`); do not
  duplicate the edge calc or snapshot model.
