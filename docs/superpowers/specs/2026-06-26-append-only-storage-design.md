# Append-only storage: raw snapshots + computed opportunities

Design for GitHub issue #15 (`phase:logger`). The runnable logger: subscribe to
the reviewed registry pairs via the #13 feeds, compute opportunities (#14 +
`netEdge`), and persist RAW books and computed opportunities separately as
append-only JSONL — so both survive restarts and opportunities can be recomputed
from raw with a changed fee assumption.

## Scope (approved)

A **runnable logger** plus pure, unit-tested cores: append-only JSONL storage,
the capture→record mapping, the shared compute core, and recompute. The live
orchestration is a thin script (like the feed demo). Heartbeat/staleness
alerting is #16; analysis is #17.

## Decisions (approved)

- **JSONL files**, date-partitioned (`data/raw/<YYYY-MM-DD>.jsonl`,
  `data/opps/<YYYY-MM-DD>.jsonl`). Zero new dependencies; reuses the lossless
  integer-JSON snapshot model. (`data/` is already gitignored.)
- **Gate on "reviewed", not "certified".** The logger logs pairs whose three
  equivalence dimensions match (`settlementSourceMatch && settlementTimeMatch &&
  strikeMatch`), regardless of `resolutionVerified`. Logging is read-only and its
  purpose is to gather the data that informs certification, so requiring
  certification first is circular. This reconciles a contradiction in CLAUDE.md
  (see below).
- **Interval sampling** (default 1000 ms), not compute-on-every-update: bounded,
  regular samples are simpler for the #17 analysis, and a push-updated cache
  still carries the WS feeds' freshness / `stale` signal.

## CLAUDE.md reconciliation

CLAUDE.md currently contradicts itself: the safety rule says *"Never compare/log
a pair that is not `isVerified`"* while the registry bullet says
*"`resolutionVerified=false` with the flags true means reviewed … logging is
read-only and doesn't need it."* Both current `PAIRS` are
`resolutionVerified:false` (reviewed, all flags true), so gating the logger on
`isVerified` would log nothing. Resolve it: the **logger gates on reviewed**;
`resolutionVerified` gates treating a pair as a tradeable arb (a future
execution-phase concern). Update the safety rule to say exactly that.

## Data model (`src/logger/model.ts`)

```ts
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { Opportunity } from "../opportunity.js";

/** A fee assumption: per-venue rate in basis points (feeUnits' coefficient). */
export interface FeeConfig {
  kalshiRateBps: number;
  polymarketUsTakerBps: number;
}
export const DEFAULT_FEE_CONFIG: FeeConfig = { kalshiRateBps: 700, polymarketUsTakerBps: 500 };

/** One venue's books at capture time, aligned to the PAIR's YES/NO outcomes. */
export interface CaptureLeg {
  venue: Venue;
  name: string;                      // VenueLeg name, e.g. "kalshi"
  stale: boolean;                    // OR of the constituent books' stale flags
  yesSnapshot: BookSnapshot | null;  // asks = asks to buy the pair's YES on this venue
  noSnapshot: BookSnapshot | null;   // asks = asks to buy the pair's NO (null = side unreadable)
}

/** The RAW store record: everything needed to recompute the opportunity. */
export interface CaptureRecord {
  captureId: string;
  captureMs: number;
  pairId: string;
  legA: CaptureLeg;  // kalshi
  legB: CaptureLeg;  // polymarket-us
}

/** The COMPUTED store record: an Opportunity tagged with provenance. */
export interface StoredOpportunity extends Opportunity {
  captureId: string;
  feeConfig: FeeConfig;
}
```

`CaptureLeg` snapshots are stored **already aligned to pair-YES / pair-NO** (the
`kalshi.yesSide` inversion and the dual-slug / single-market mapping are applied
at capture time), so recompute reads `yesSnapshot.asks` / `noSnapshot.asks`
directly. Every field is JSON-native integers → lossless serialize/parse.

## Shared compute core (`src/logger/compute.ts`) — pure

```ts
import { feeUnits } from "../fees.js";
import { netEdge } from "../edge.js";
import { buildOpportunity } from "../opportunity.js";
import type { VenueLeg } from "../edge.js";
import type { CaptureRecord, FeeConfig, StoredOpportunity } from "./model.js";

export function captureToLegs(
  record: CaptureRecord,
  feeConfig: FeeConfig,
): { legA: VenueLeg; legB: VenueLeg };

export function computeOpportunity(
  record: CaptureRecord,
  feeConfig: FeeConfig,
): StoredOpportunity;
```

- `captureToLegs` builds each `VenueLeg`: `yesAsks = leg.yesSnapshot?.asks ?? []`,
  `noAsks = leg.noSnapshot?.asks ?? []`, `fee = (p, q) => feeUnits(p, q, bps)`
  where `bps` is the leg's configured rate. (`netEdge`'s `avgFillPrice` returns
  `null` on an empty/unfillable side, so a missing book is handled without
  special-casing — this is how single-market PM legs measure only one direction.)
- `computeOpportunity` = `captureToLegs` → `netEdge(legA, legB)` →
  `buildOpportunity({ pairId, captureMs, legA: { venue, snapshots:
  [yesSnapshot, noSnapshot].filter(Boolean), stale }, legB: …, edge })`, tagged
  with `record.captureId` and `feeConfig`.

This is the DRY heart: the live logger calls it with the current fees; recompute
calls it with a different `FeeConfig`. Same code path.

## Recompute (`src/logger/recompute.ts`)

```ts
export function recompute(records: CaptureRecord[], feeConfig: FeeConfig): StoredOpportunity[];
// = records.map((r) => computeOpportunity(r, feeConfig))
```

Verify checkbox 2 = load raw `CaptureRecord`s, `recompute` with a changed
`FeeConfig`, assert the resulting edges differ from the originals.

## Capture mapping (`src/logger/capture.ts`) — pure

```ts
export interface InstrumentSnapshot { snapshot: BookSnapshot; stale: boolean }
/** Looks up the cached {snapshot, stale} for an instrument, or null if none yet. */
export type SnapshotLookup = (venue: Venue, marketId: string, side: Side) => InstrumentSnapshot | null;

export function buildCaptureRecord(
  pair: MarketPair,
  captureMs: number,
  captureId: string,
  lookup: SnapshotLookup,
): CaptureRecord | null;
```

`buildCaptureRecord` assembles a `CaptureRecord` from cached snapshots, applying:

- **Kalshi `yesSide` mapping:** `yesSnapshot = lookup("kalshi", ticker,
  pair.kalshi.yesSide)`; `noSnapshot = lookup("kalshi", ticker, otherSide)`.
- **PM `dualSlug`:** `yesSnapshot = lookup("polymarket-us", yesSlug, "yes")`;
  `noSnapshot = lookup("polymarket-us", noSlug, "no")`.
- **PM `singleMarket`:** the long side maps to `yesIsLong ? "yes" : "no"`; that
  side's snapshot is set, the other is `null` (unreadable → only one arb
  direction).
- Per-leg `stale` = OR of the present instruments' stale flags.

Returns `null` (logger skips this tick for this pair) if **either leg has no
snapshot at all** (data not yet received). A leg with one side present and the
other `null` is kept (partial book → some strategies unfillable, still a valid
record).

## Registry gate (`src/registry/schema.ts`)

Add:

```ts
export function isReviewed(pair: MarketPair): boolean {
  return pair.settlementSourceMatch && pair.settlementTimeMatch && pair.strikeMatch;
}
export function getLoggablePairs(pairs: readonly MarketPair[]): MarketPair[] {
  return pairs.filter(isReviewed);
}
```

## Storage (`src/storage/jsonl.ts`) — append-only

```ts
export function appendRecord(filePath: string, record: unknown): void; // mkdir -p; JSON.stringify + "\n"; appendFileSync
export function readRecords(filePath: string): unknown[];              // read; split non-empty lines; JSON.parse
export function rawPath(dataDir: string, date: string): string;        // `${dataDir}/raw/${date}.jsonl`
export function oppsPath(dataDir: string, date: string): string;       // `${dataDir}/opps/${date}.jsonl`
```

Append-only and file-based, so persistence across restarts is inherent (verify
checkbox 1): write, "reopen" (re-read the file), records are present; subsequent
runs append to the same day's file.

## Live logger (`src/logger/run.ts` + `src/scripts/logger.ts`)

`runLogger({ kalshiFeed, pmFeed, pairs, dataDir, intervalMs, now })`:

1. Compute `getLoggablePairs(pairs)`; derive the instrument set (Kalshi
   ticker yes+no; PM slug(s) per leg) and `subscribe` both feeds.
2. On every feed `update`, cache `{ snapshot, stale }` keyed by
   `${venue}:${marketId}:${side}` (the `SnapshotLookup` reads this cache).
3. Every `intervalMs`, for each loggable pair: `buildCaptureRecord` → if non-null,
   `computeOpportunity(record, DEFAULT_FEE_CONFIG)` → `appendRecord(rawPath, record)`
   and `appendRecord(oppsPath, storedOpp)`.

`src/scripts/logger.ts` (`npm run log`) constructs the real feeds + `PAIRS` and
runs it; read-only, no order placement. A second script
`src/scripts/recompute.ts` (`npm run recompute -- <date> <kalshiBps> <pmBps>`)
reads the day's raw file and prints recomputed edges under the new fee.

## Files & testing

- `src/logger/model.ts` — types + `DEFAULT_FEE_CONFIG`.
- `src/logger/compute.ts` (+ `.test.ts`) — `captureToLegs`, `computeOpportunity`;
  test legs/fee built from config, empty-asks handling, captureId/feeConfig tags.
- `src/logger/capture.ts` (+ `.test.ts`) — `buildCaptureRecord`; test `yesSide`
  inversion, dual vs single, `stale` OR, skip-on-missing-leg.
- `src/logger/recompute.ts` (+ `.test.ts`) — `recompute`; test a **changed
  `FeeConfig` yields a different edge** (verify checkbox 2).
- `src/storage/jsonl.ts` (+ `.test.ts`) — append/read round-trip into a temp dir;
  re-read after "reopen" proves restart persistence (verify checkbox 1).
- `src/registry/schema.ts` (+ extend `schema.test.ts`) — `isReviewed`,
  `getLoggablePairs`.
- `src/logger/run.ts` — live orchestration (I/O; verified by `npm run log`).
- `src/scripts/logger.ts`, `src/scripts/recompute.ts` — entry points;
  `package.json` `log` + `recompute` scripts.
- `CLAUDE.md` — reconcile the safety rule + document the storage/logger.

## Constraints

- **Money/time are integers** (1/10000-$ units; ms). No JS floats. Fees go
  through the shared `feeUnits` BigInt core.
- **Pure cores have no I/O / no `Date.now()`** (`compute`, `capture`,
  `recompute`, `model`): times and ids are passed in. Only `storage` and `run`
  touch the filesystem / clock.
- **READ-ONLY phase:** no order placement, no `orders.*`; feeds use read-only
  credentials (per #13).
- **Reuse** `BookSnapshot`/`Venue`, `Opportunity`/`buildOpportunity`,
  `netEdge`/`VenueLeg`, `feeUnits`, and the registry types — do not duplicate.
- **Gate on `isReviewed`** before logging any pair; never log a non-reviewed pair.
