# Normalized BookSnapshot model (TS types)

Design for GitHub issue #6 (`phase:connectivity`). One interface both venues map
into, so downstream code (logger, edge math, analysis) never branches on venue.

## Deviations from the issue's literal interface (approved)

The issue sketches `interface BookSnapshot { venue; marketId; tsLocalNs; tsVenue?;
bids; asks; seq? }` with levels `{ priceCents; size }`. Three changes were agreed
during brainstorming:

1. **Levels reuse `Level { price, qty }`** from `src/book.ts` (integer 1/10000
   dollar / contract), not `{ priceCents, size }`. Cents is too coarse for the
   venues' 4-decimal prices — the money decision made in issue #4. One level type
   across the codebase (DRY).
2. **`tsLocalNs` → `tsLocalMs` (number).** Nanosecond epoch values exceed JS's
   safe-integer range and Node has no true epoch-ns wall clock; millisecond
   resolution is sufficient for internet-sourced market data, with `seq` for
   intra-ms ordering. A plain `number` is JSON-native and round-trips exactly.
3. **Add an explicit `side: Side` field.** A snapshot models ONE tradeable
   instrument (one side); a binary market yields up to two snapshots. `side`
   labels which, rather than mangling it into `marketId`.

## The type — `src/snapshot.ts` (venue-neutral)

```ts
import type { Level, Side } from "./book.js";

export type Venue = "kalshi" | "polymarket-us";

export interface BookSnapshot {
  venue: Venue;
  marketId: string;   // venue-native id: Kalshi ticker, Polymarket US slug
  side: Side;         // which instrument this snapshot is (yes | no)
  tsLocalMs: number;  // local capture time, ms since epoch
  tsVenue?: string;   // venue-reported timestamp when available (ISO string)
  bids: Level[];      // best-first: highest price first
  asks: Level[];      // best-first: lowest price first
  seq?: number;       // intra-tick ordering / WS sequence number
}
```

`bids`/`asks` are this instrument's two-sided book: `asks` is what you lift to
BUY this side, `bids` is what you lift to SELL it.

## Serialization & validation (same file)

- `serializeSnapshot(s: BookSnapshot): string` — `JSON.stringify`. Every numeric
  field is a safe integer, so this is lossless.
- `deserializeSnapshot(json: string): BookSnapshot` — `JSON.parse` then
  `assertValidSnapshot`.
- `assertValidSnapshot(x: unknown): asserts x is BookSnapshot` — throws on:
  unknown `venue`/`side`; empty `marketId`; non-integer/negative `tsLocalMs`,
  `seq`, or level `price`/`qty`; non-array `bids`/`asks`; out-of-order levels
  (bids must be descending, asks ascending). Used by `deserializeSnapshot` and
  the demo.

Round-trip requirement (`deepEqual(s, deserializeSnapshot(serializeSnapshot(s)))`)
holds because all values are JSON-native and integer-exact.

## Venue mappers (live with each venue)

- `src/kalshi/orderbook.ts`:
  `toBookSnapshot(ticker, raw, side, { tsLocalMs, seq? }): BookSnapshot`.
  `asks = asksForBuying(book, side)` (already best-first); `bids` = that side's
  real bids sorted descending (yes→`yesBids`, no→`noBids`). Kalshi's
  `orderbook_fp` carries no per-book timestamp, so `tsVenue` is omitted.
- `src/polymarket/orderbook.ts`:
  `toBookSnapshot(marketData, side, { tsLocalMs, seq? }): BookSnapshot`.
  `asks = levelsToAsks(marketData.offers)`; `bids = levelsToBids(marketData.bids)`
  (descending); `marketId = marketData.marketSlug`;
  `tsVenue = marketData.transactTime`.

Both import `BookSnapshot` from `../snapshot.js` and `Level` from `../book.js`. A
new `levelsToBids` mirrors the existing `levelsToAsks` (descending sort).

## Demo & verification — `src/scripts/snapshot-demo.ts` + `npm run snapshot`

Read-only. Pulls one live Kalshi book and one live Polymarket US side, builds a
`BookSnapshot` for each, runs `assertValidSnapshot`, and asserts
`deepEqual(s, deserializeSnapshot(serializeSnapshot(s)))`. Prints PASS/FAIL for
both issue verify items. No unit-test runner (consistent with prior issues).

DRY refactor: the Kalshi live-market finder currently inlined in
`src/scripts/kalshi-book.ts` moves to `src/kalshi/client.ts` as an exported
`findLiveMarket()`, reused by both the book demo and the snapshot demo.

## Error handling

| Condition | Behavior |
| --- | --- |
| Malformed snapshot (bad enum, non-integer, mis-ordered) | `assertValidSnapshot` throws |
| Live fetch error | propagates from existing venue clients |
| Credentials | none used in any path |

## Out of scope

The logger loop, persistence/storage format, WebSocket delta application,
fee/net-edge math, and the pair registry (later phases). This issue is the
shared type + venue mappers + lossless (de)serialization only.
```
