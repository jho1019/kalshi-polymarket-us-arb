# Append-Only Storage: Raw Snapshots + Computed Opportunities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable read-only logger that subscribes to the reviewed registry pairs via the #13 feeds, computes opportunities, and persists RAW books and computed opportunities as separate append-only JSONL — surviving restarts and recomputable from raw under a changed fee.

**Architecture:** Pure, unit-tested cores — append-only JSONL storage, a capture→record mapping, a shared compute core, and recompute — plus a thin live orchestration (`runLogger`) and two scripts. RAW `CaptureRecord`s store each leg's books aligned to the pair's YES/NO so `recompute(records, feeConfig)` regenerates opportunities under a different fee via the same code path the live logger uses.

**Tech Stack:** TypeScript / Node 18+, ESM/NodeNext (`.js` import specifiers), `node:test` via `tsx`, `node:fs` (JSONL). No new dependencies.

## Global Constraints

- **Integer money/time.** Prices/fees in 1/10000-$ units; quantities in 1/10000-contract units; timestamps in integer ms. No JS floats. Fees go through the shared `feeUnits(priceUnits, qtyUnits, coefficientBps)` BigInt core (`src/fees.ts`).
- **Pure cores have no I/O and no `Date.now()`** — `src/logger/model.ts`, `compute.ts`, `capture.ts`, `recompute.ts`. Times and ids are passed in. Only `src/storage/jsonl.ts` and `src/logger/run.ts` touch the filesystem/clock.
- **READ-ONLY phase:** no order placement, no `orders.*`. Feeds use read-only credentials (per #13).
- **Gate on `isReviewed`** (all three dimension flags true), NOT `resolutionVerified`, before logging any pair.
- **Reuse** existing types/functions — `BookSnapshot`/`Venue` (`src/snapshot.ts`), `Opportunity`/`buildOpportunity` (`src/opportunity.ts`), `netEdge`/`VenueLeg` (`src/edge.ts`), `feeUnits` (`src/fees.ts`), `MarketPair` + registry helpers (`src/registry/schema.ts`), `FeedClient`/`FeedUpdate`/`InstrumentRef` (`src/feed/types.ts`). Do not duplicate.
- **JSONL append-only**, date-partitioned: `data/raw/<YYYY-MM-DD>.jsonl`, `data/opps/<YYYY-MM-DD>.jsonl` (`data/` is gitignored).
- Tests are `src/**/*.test.ts` via `npm test`; `npm run typecheck` and `npm run build` must pass.

---

### Task 1: Append-only JSONL storage

**Files:**
- Create: `src/storage/jsonl.ts`
- Test: `src/storage/jsonl.test.ts`

**Interfaces:**
- Produces: `appendRecord(filePath: string, record: unknown): void`, `readRecords(filePath: string): unknown[]`, `rawPath(dataDir: string, date: string): string`, `oppsPath(dataDir: string, date: string): string`

- [ ] **Step 1: Write the failing test** — create `src/storage/jsonl.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords, rawPath, oppsPath } from "./jsonl.js";

test("appendRecord then readRecords round-trips multiple records (and creates the dir)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
  try {
    const p = join(dir, "sub", "x.jsonl"); // nested dir must be auto-created
    appendRecord(p, { a: 1 });
    appendRecord(p, { a: 2, b: [3, 4] });
    assert.deepEqual(readRecords(p), [{ a: 1 }, { a: 2, b: [3, 4] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecords on a missing file returns []", () => {
  assert.deepEqual(readRecords(join(tmpdir(), "definitely-missing-12345.jsonl")), []);
});

test("records persist across a re-read (simulated restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
  try {
    const p = join(dir, "data.jsonl");
    appendRecord(p, { n: 1 });
    const rereadAfterFirstRun = readRecords(p); // a fresh process reading the same file
    appendRecord(p, { n: 2 });
    assert.deepEqual(rereadAfterFirstRun, [{ n: 1 }]);
    assert.deepEqual(readRecords(p), [{ n: 1 }, { n: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path helpers partition by date", () => {
  assert.equal(rawPath("data", "2026-06-26"), "data/raw/2026-06-26.jsonl");
  assert.equal(oppsPath("data", "2026-06-26"), "data/opps/2026-06-26.jsonl");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./jsonl.js` not found.

- [ ] **Step 3: Implement** — create `src/storage/jsonl.ts`:

```ts
/**
 * Append-only JSONL storage: one JSON record per line. Append is crash-safe-ish
 * (a torn final line is skippable) and survives restarts because it is just a
 * file. Records must be JSON-native (the project's money/time are integers, so
 * (de)serialization is lossless).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append one record as a JSON line, creating parent directories as needed. */
export function appendRecord(filePath: string, record: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(record) + "\n");
}

/** Read all records from a JSONL file (missing file → []). */
export function readRecords(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** Date-partitioned path for RAW capture records. */
export function rawPath(dataDir: string, date: string): string {
  return `${dataDir}/raw/${date}.jsonl`;
}

/** Date-partitioned path for computed opportunity records. */
export function oppsPath(dataDir: string, date: string): string {
  return `${dataDir}/opps/${date}.jsonl`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/jsonl.ts src/storage/jsonl.test.ts
git commit -m "Add append-only JSONL storage (date-partitioned)"
```

---

### Task 2: Registry "reviewed" gate

The logger logs **reviewed** pairs (all dimension flags true), not only `resolutionVerified` ones.

**Files:**
- Modify: `src/registry/schema.ts` (add two exports after `getVerifiedPairs`)
- Test: `src/registry/schema.test.ts` (add cases + imports)

**Interfaces:**
- Consumes: `MarketPair`, `PAIRS`.
- Produces: `isReviewed(pair: MarketPair): boolean`, `getLoggablePairs(pairs: readonly MarketPair[]): MarketPair[]`

- [ ] **Step 1: Add the failing tests** to `src/registry/schema.test.ts`. Extend the import from `./schema.js` to include `isReviewed` and `getLoggablePairs`, and add the existing `getLoggablePairs`/`isReviewed` to the import list:

```ts
import {
  assertValidPair,
  getLoggablePairs,
  getVerifiedPairs,
  isReviewed,
  isVerified,
  type MarketPair,
} from "./schema.js";
```

Then append these tests:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `isReviewed`/`getLoggablePairs` not exported.

- [ ] **Step 3: Implement** — add to `src/registry/schema.ts`, immediately after `getVerifiedPairs`:

```ts
/**
 * A pair is loggable when all resolution dimensions match ("reviewed"), even if
 * `resolutionVerified` (the stricter trade gate) is still pending. The read-only
 * logger gathers the data that informs certification, so it must not require
 * certification first.
 */
export function isReviewed(pair: MarketPair): boolean {
  return pair.settlementSourceMatch && pair.settlementTimeMatch && pair.strikeMatch;
}

/** Filter to the pairs the read-only logger may record. */
export function getLoggablePairs(pairs: readonly MarketPair[]): MarketPair[] {
  return pairs.filter(isReviewed);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry/schema.ts src/registry/schema.test.ts
git commit -m "Add isReviewed / getLoggablePairs registry gate for the logger"
```

---

### Task 3: Logger model + shared compute core + recompute

**Files:**
- Create: `src/logger/model.ts`
- Create: `src/logger/compute.ts`
- Create: `src/logger/recompute.ts`
- Test: `src/logger/compute.test.ts`
- Test: `src/logger/recompute.test.ts`

**Interfaces:**
- Consumes: `feeUnits` (`src/fees.js`), `netEdge`/`VenueLeg` (`src/edge.js`), `buildOpportunity`/`Opportunity` (`src/opportunity.js`), `BookSnapshot`/`Venue` (`src/snapshot.js`).
- Produces:
  - `model.ts`: `FeeConfig`, `DEFAULT_FEE_CONFIG`, `CaptureLeg`, `CaptureRecord`, `StoredOpportunity`.
  - `compute.ts`: `captureToLegs(record: CaptureRecord, feeConfig: FeeConfig): { legA: VenueLeg; legB: VenueLeg }`, `computeOpportunity(record: CaptureRecord, feeConfig: FeeConfig): StoredOpportunity`.
  - `recompute.ts`: `recompute(records: CaptureRecord[], feeConfig: FeeConfig): StoredOpportunity[]`.

- [ ] **Step 1: Create `src/logger/model.ts`:**

```ts
/**
 * Storage record types for the append-only logger. A CaptureRecord is the RAW
 * store (everything needed to recompute); a StoredOpportunity is the computed
 * store. All fields are JSON-native integers → lossless JSONL (de)serialization.
 */
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { Opportunity } from "../opportunity.js";

/** A fee assumption: per-venue coefficient in basis points (feeUnits' coefficient). */
export interface FeeConfig {
  kalshiRateBps: number;
  polymarketUsTakerBps: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  kalshiRateBps: 700,
  polymarketUsTakerBps: 500,
};

/** One venue's books at capture time, aligned to the PAIR's YES/NO outcomes. */
export interface CaptureLeg {
  venue: Venue;
  /** VenueLeg name, e.g. "kalshi". */
  name: string;
  /** OR of the constituent books' stale flags. */
  stale: boolean;
  /** asks = asks to buy the pair's YES on this venue (null = side unreadable/missing). */
  yesSnapshot: BookSnapshot | null;
  /** asks = asks to buy the pair's NO on this venue (null = side unreadable/missing). */
  noSnapshot: BookSnapshot | null;
}

/** RAW store record: a single capture tick for one pair. */
export interface CaptureRecord {
  captureId: string;
  captureMs: number;
  pairId: string;
  legA: CaptureLeg; // kalshi
  legB: CaptureLeg; // polymarket-us
}

/** Computed store record: an Opportunity tagged with provenance. */
export interface StoredOpportunity extends Opportunity {
  captureId: string;
  feeConfig: FeeConfig;
}
```

- [ ] **Step 2: Write the failing tests** — create `src/logger/compute.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureToLegs, computeOpportunity } from "./compute.js";
import { DEFAULT_FEE_CONFIG } from "./model.js";
import type { CaptureRecord } from "./model.js";
import type { BookSnapshot } from "../snapshot.js";

function snap(askPrice: number, askQty = 1_000_000): BookSnapshot {
  return {
    venue: "kalshi",
    marketId: "m",
    side: "yes",
    tsLocalMs: 1000,
    bids: [],
    asks: [{ price: askPrice, qty: askQty }],
  };
}

function record(): CaptureRecord {
  return {
    captureId: "c1",
    captureMs: 2000,
    pairId: "P",
    legA: { venue: "kalshi", name: "kalshi", stale: false, yesSnapshot: snap(4000), noSnapshot: snap(5500) },
    legB: { venue: "polymarket-us", name: "polymarket-us", stale: false, yesSnapshot: snap(4500), noSnapshot: snap(5200) },
  };
}

test("captureToLegs maps snapshot asks and builds a fee fn from the config", () => {
  const { legA, legB } = captureToLegs(record(), DEFAULT_FEE_CONFIG);
  assert.equal(legA.name, "kalshi");
  assert.deepEqual(legA.yesAsks, [{ price: 4000, qty: 1_000_000 }]);
  assert.deepEqual(legA.noAsks, [{ price: 5500, qty: 1_000_000 }]);
  assert.deepEqual(legB.yesAsks, [{ price: 4500, qty: 1_000_000 }]);
  // fee fn applies the configured bps (700 for kalshi) via feeUnits at price 5000, 1 contract.
  assert.ok(legA.fee(5000, 10_000) > 0);
});

test("computeOpportunity tags captureId + feeConfig and yields a fillable positive edge", () => {
  const opp = computeOpportunity(record(), DEFAULT_FEE_CONFIG);
  assert.equal(opp.captureId, "c1");
  assert.deepEqual(opp.feeConfig, DEFAULT_FEE_CONFIG);
  assert.equal(opp.pairId, "P");
  assert.equal(opp.bookSkewMs, 0); // both legs' snapshots share tsLocalMs 1000
  // YES@kalshi(0.40) + NO@pm(0.52) = 0.92 cost -> ~0.08 gross/contract, profitable at size 1.
  assert.equal(opp.edge.maxProfitableSize !== null, true);
});

test("a null side becomes empty asks (that strategy unfillable, the other still computes)", () => {
  const r = record();
  r.legB.noSnapshot = null; // PM NO unreadable
  const { legB } = captureToLegs(r, DEFAULT_FEE_CONFIG);
  assert.deepEqual(legB.noAsks, []);
  const opp = computeOpportunity(r, DEFAULT_FEE_CONFIG);
  // size-1 row: strategy buying NO@pm is unfillable; the report still computes.
  const row = opp.edge.perSize.find((x) => x.sizeContracts === 1);
  assert.ok(row);
  assert.equal(row.s1.fillable === false || row.s2.fillable === false, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `./compute.js` not found.

- [ ] **Step 4: Implement** — create `src/logger/compute.ts`:

```ts
/**
 * Shared compute core: turn a RAW CaptureRecord into VenueLegs and a computed
 * StoredOpportunity under a given FeeConfig. Pure (no I/O). The live logger calls
 * this with the current fees; `recompute` calls it with a different FeeConfig —
 * one code path, so opportunities are always recomputable from raw.
 */
import { feeUnits } from "../fees.js";
import { netEdge } from "../edge.js";
import type { VenueLeg } from "../edge.js";
import { buildOpportunity } from "../opportunity.js";
import type { BookSnapshot } from "../snapshot.js";
import type { CaptureLeg, CaptureRecord, FeeConfig, StoredOpportunity } from "./model.js";

function legToVenueLeg(leg: CaptureLeg, rateBps: number): VenueLeg {
  return {
    name: leg.name,
    yesAsks: leg.yesSnapshot?.asks ?? [],
    noAsks: leg.noSnapshot?.asks ?? [],
    fee: (priceUnits, qtyUnits) => feeUnits(priceUnits, qtyUnits, rateBps),
  };
}

/** Build both VenueLegs from a capture record under the given fee config. */
export function captureToLegs(
  record: CaptureRecord,
  feeConfig: FeeConfig,
): { legA: VenueLeg; legB: VenueLeg } {
  return {
    legA: legToVenueLeg(record.legA, feeConfig.kalshiRateBps),
    legB: legToVenueLeg(record.legB, feeConfig.polymarketUsTakerBps),
  };
}

function legSnapshots(leg: CaptureLeg): BookSnapshot[] {
  return [leg.yesSnapshot, leg.noSnapshot].filter((s): s is BookSnapshot => s !== null);
}

/** Compute a StoredOpportunity from a capture record under the given fee config. */
export function computeOpportunity(
  record: CaptureRecord,
  feeConfig: FeeConfig,
): StoredOpportunity {
  const { legA, legB } = captureToLegs(record, feeConfig);
  const edge = netEdge(legA, legB);
  const opp = buildOpportunity({
    pairId: record.pairId,
    captureMs: record.captureMs,
    legA: { venue: record.legA.venue, snapshots: legSnapshots(record.legA), stale: record.legA.stale },
    legB: { venue: record.legB.venue, snapshots: legSnapshots(record.legB), stale: record.legB.stale },
    edge,
  });
  return { ...opp, captureId: record.captureId, feeConfig };
}
```

- [ ] **Step 5: Write the failing recompute test** — create `src/logger/recompute.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { recompute } from "./recompute.js";
import { DEFAULT_FEE_CONFIG } from "./model.js";
import type { CaptureRecord } from "./model.js";
import type { BookSnapshot } from "../snapshot.js";

function snap(askPrice: number): BookSnapshot {
  return { venue: "kalshi", marketId: "m", side: "yes", tsLocalMs: 1000, bids: [], asks: [{ price: askPrice, qty: 1_000_000 }] };
}

function records(): CaptureRecord[] {
  return [
    {
      captureId: "c1",
      captureMs: 2000,
      pairId: "P",
      legA: { venue: "kalshi", name: "kalshi", stale: false, yesSnapshot: snap(4000), noSnapshot: snap(5500) },
      legB: { venue: "polymarket-us", name: "polymarket-us", stale: false, yesSnapshot: snap(4500), noSnapshot: snap(5200) },
    },
  ];
}

function size1Net(opp: { edge: { perSize: { sizeContracts: number; best: { netPerContract: number } | null }[] } }): number | null {
  return opp.edge.perSize.find((r) => r.sizeContracts === 1)?.best?.netPerContract ?? null;
}

test("recompute with a CHANGED fee assumption yields a different (lower) net edge", () => {
  const recs = records();
  const base = recompute(recs, DEFAULT_FEE_CONFIG);
  const higherFee = recompute(recs, { kalshiRateBps: 5000, polymarketUsTakerBps: 5000 });

  assert.equal(base.length, 1);
  assert.equal(higherFee.length, 1);
  const baseNet = size1Net(base[0]!);
  const highNet = size1Net(higherFee[0]!);
  assert.ok(baseNet !== null && highNet !== null);
  assert.ok(highNet < baseNet, `higher fee net ${highNet} should be < base net ${baseNet}`);
  // provenance recorded:
  assert.deepEqual(higherFee[0]!.feeConfig, { kalshiRateBps: 5000, polymarketUsTakerBps: 5000 });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test`
Expected: FAIL — module `./recompute.js` not found.

- [ ] **Step 7: Implement** — create `src/logger/recompute.ts`:

```ts
/**
 * Recompute computed opportunities from RAW capture records under a (possibly
 * changed) fee assumption. The whole point of storing raw books separately.
 */
import { computeOpportunity } from "./compute.js";
import type { CaptureRecord, FeeConfig, StoredOpportunity } from "./model.js";

export function recompute(records: CaptureRecord[], feeConfig: FeeConfig): StoredOpportunity[] {
  return records.map((record) => computeOpportunity(record, feeConfig));
}
```

- [ ] **Step 8: Run all tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/logger/model.ts src/logger/compute.ts src/logger/recompute.ts src/logger/compute.test.ts src/logger/recompute.test.ts
git commit -m "Add logger model + shared compute core + recompute (changed-fee)"
```

---

### Task 4: Capture mapping (pair + snapshots → CaptureRecord)

**Files:**
- Create: `src/logger/capture.ts`
- Test: `src/logger/capture.test.ts`

**Interfaces:**
- Consumes: `Side` (`src/book.js`), `BookSnapshot`/`Venue` (`src/snapshot.js`), `MarketPair` (`src/registry/schema.js`), `CaptureLeg`/`CaptureRecord` (`./model.js`).
- Produces: `InstrumentSnapshot { snapshot: BookSnapshot; stale: boolean }`, `SnapshotLookup = (venue, marketId, side) => InstrumentSnapshot | null`, `buildCaptureRecord(pair, captureMs, captureId, lookup): CaptureRecord | null`.

- [ ] **Step 1: Write the failing test** — create `src/logger/capture.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureRecord } from "./capture.js";
import type { InstrumentSnapshot, SnapshotLookup } from "./capture.js";
import type { MarketPair } from "../registry/schema.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { Side } from "../book.js";

function snap(marketId: string, side: Side, tsLocalMs = 1000): BookSnapshot {
  return { venue: "kalshi", marketId, side, tsLocalMs, bids: [], asks: [] };
}

/** A lookup backed by a Map keyed `venue:marketId:side`. */
function lookupFrom(entries: Record<string, InstrumentSnapshot>): SnapshotLookup {
  return (venue: Venue, marketId: string, side: Side) => entries[`${venue}:${marketId}:${side}`] ?? null;
}

function singlePair(over: Partial<MarketPair> = {}): MarketPair {
  return {
    pairId: "P",
    description: "d",
    kalshi: { ticker: "KTKR", yesSide: "yes" },
    polymarketUs: { kind: "singleMarket", slug: "pslug", yesIsLong: true },
    settlementSourceMatch: true,
    settlementTimeMatch: true,
    strikeMatch: true,
    resolutionVerified: false,
    verifiedDate: "2026-06-24",
    ...over,
  };
}

test("kalshi yesSide=yes maps yes/no snapshots straight through", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.legA.yesSnapshot?.side, "yes");
  assert.equal(rec.legA.noSnapshot?.side, "no");
});

test("kalshi yesSide=no INVERTS: pair-YES asks come from the kalshi NO side", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair({ kalshi: { ticker: "KTKR", yesSide: "no" } }), 5000, "cid", lookup)!;
  assert.equal(rec.legA.yesSnapshot?.side, "no"); // inverted
  assert.equal(rec.legA.noSnapshot?.side, "yes");
});

test("PM singleMarket yesIsLong=true sets yesSnapshot, leaves noSnapshot null", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.legB.yesSnapshot?.marketId, "pslug");
  assert.equal(rec.legB.noSnapshot, null);
});

test("PM singleMarket yesIsLong=false sets noSnapshot, leaves yesSnapshot null", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:no": { snapshot: snap("pslug", "no"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair({ polymarketUs: { kind: "singleMarket", slug: "pslug", yesIsLong: false } }), 5000, "cid", lookup)!;
  assert.equal(rec.legB.noSnapshot?.marketId, "pslug");
  assert.equal(rec.legB.yesSnapshot, null);
});

test("PM dualSlug maps yesSlug/noSlug to the two sides", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:ys:yes": { snapshot: snap("ys", "yes"), stale: false },
    "polymarket-us:ns:no": { snapshot: snap("ns", "no"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair({ polymarketUs: { kind: "dualSlug", yesSlug: "ys", noSlug: "ns" } }), 5000, "cid", lookup)!;
  assert.equal(rec.legB.yesSnapshot?.marketId, "ys");
  assert.equal(rec.legB.noSnapshot?.marketId, "ns");
});

test("leg stale is the OR of its constituent books' stale flags", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: true },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.legA.stale, true);
});

test("returns null when a leg has no snapshot yet", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    // PM leg has nothing cached yet
  });
  assert.equal(buildCaptureRecord(singlePair(), 5000, "cid", lookup), null);
});

test("sets captureId, captureMs, pairId on the record", () => {
  const lookup = lookupFrom({
    "kalshi:KTKR:yes": { snapshot: snap("KTKR", "yes"), stale: false },
    "kalshi:KTKR:no": { snapshot: snap("KTKR", "no"), stale: false },
    "polymarket-us:pslug:yes": { snapshot: snap("pslug", "yes"), stale: false },
  });
  const rec = buildCaptureRecord(singlePair(), 5000, "cid", lookup)!;
  assert.equal(rec.captureId, "cid");
  assert.equal(rec.captureMs, 5000);
  assert.equal(rec.pairId, "P");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./capture.js` not found.

- [ ] **Step 3: Implement** — create `src/logger/capture.ts`:

```ts
/**
 * Map a registry pair + cached per-instrument snapshots into a RAW CaptureRecord,
 * aligning each leg's books to the pair's YES/NO outcomes. Pure: it reads from a
 * caller-supplied lookup (the live logger backs this with a push-updated cache).
 *
 * Alignment rules:
 *  - Kalshi: the pair's YES side is `pair.kalshi.yesSide`; the NO side is its
 *    opposite (so a Kalshi market whose native YES is the other outcome inverts).
 *  - PM dualSlug: yesSlug→YES, noSlug→NO.
 *  - PM singleMarket: only the long side's book is readable; it maps to YES if
 *    `yesIsLong`, else NO; the other side stays null (one arb direction).
 */
import type { Side } from "../book.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { MarketPair } from "../registry/schema.js";
import type { CaptureLeg, CaptureRecord } from "./model.js";

const KALSHI: Venue = "kalshi";
const PM: Venue = "polymarket-us";

export interface InstrumentSnapshot {
  snapshot: BookSnapshot;
  stale: boolean;
}

export type SnapshotLookup = (
  venue: Venue,
  marketId: string,
  side: Side,
) => InstrumentSnapshot | null;

function otherSide(side: Side): Side {
  return side === "yes" ? "no" : "yes";
}

function kalshiLeg(pair: MarketPair, lookup: SnapshotLookup): CaptureLeg {
  const { ticker, yesSide } = pair.kalshi;
  const yes = lookup(KALSHI, ticker, yesSide);
  const no = lookup(KALSHI, ticker, otherSide(yesSide));
  return {
    venue: KALSHI,
    name: "kalshi",
    stale: (yes?.stale ?? false) || (no?.stale ?? false),
    yesSnapshot: yes?.snapshot ?? null,
    noSnapshot: no?.snapshot ?? null,
  };
}

function pmLeg(pair: MarketPair, lookup: SnapshotLookup): CaptureLeg {
  const pm = pair.polymarketUs;
  if (pm.kind === "dualSlug") {
    const yes = lookup(PM, pm.yesSlug, "yes");
    const no = lookup(PM, pm.noSlug, "no");
    return {
      venue: PM,
      name: "polymarket-us",
      stale: (yes?.stale ?? false) || (no?.stale ?? false),
      yesSnapshot: yes?.snapshot ?? null,
      noSnapshot: no?.snapshot ?? null,
    };
  }
  const longSide: Side = pm.yesIsLong ? "yes" : "no";
  const long = lookup(PM, pm.slug, longSide);
  return {
    venue: PM,
    name: "polymarket-us",
    stale: long?.stale ?? false,
    yesSnapshot: pm.yesIsLong ? (long?.snapshot ?? null) : null,
    noSnapshot: pm.yesIsLong ? null : (long?.snapshot ?? null),
  };
}

function hasData(leg: CaptureLeg): boolean {
  return leg.yesSnapshot !== null || leg.noSnapshot !== null;
}

/**
 * Build a CaptureRecord, or null if either leg has no snapshot yet (the logger
 * skips this tick for the pair). A leg with one side present and the other null
 * is kept (partial book → some strategies unfillable, still a valid record).
 */
export function buildCaptureRecord(
  pair: MarketPair,
  captureMs: number,
  captureId: string,
  lookup: SnapshotLookup,
): CaptureRecord | null {
  const legA = kalshiLeg(pair, lookup);
  const legB = pmLeg(pair, lookup);
  if (!hasData(legA) || !hasData(legB)) return null;
  return { captureId, captureMs, pairId: pair.pairId, legA, legB };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logger/capture.ts src/logger/capture.test.ts
git commit -m "Add capture mapping: pair + cached snapshots -> CaptureRecord"
```

---

### Task 5: Live logger orchestration, scripts, and docs

Wires it together: subscribe feeds, cache updates, sample on an interval, append. I/O — verified by `npm run log` / `npm run recompute` and typecheck/build (the pure cores are already unit-tested).

**Files:**
- Create: `src/logger/run.ts`
- Create: `src/scripts/logger.ts`
- Create: `src/scripts/recompute.ts`
- Modify: `package.json` (add `log`, `recompute` scripts)
- Modify: `CLAUDE.md` (reconcile safety rule + document logger/storage + commands)

**Interfaces:**
- Consumes: `FeedClient`/`FeedUpdate`/`InstrumentRef` (`src/feed/types.js`), `MarketPair`/`getLoggablePairs` (Task 2), `Side` (`src/book.js`), `Venue` (`src/snapshot.js`), `buildCaptureRecord`/`InstrumentSnapshot`/`SnapshotLookup` (Task 4), `computeOpportunity` + `DEFAULT_FEE_CONFIG` (Task 3), `appendRecord`/`rawPath`/`oppsPath` (Task 1), `recompute` (Task 3), `readRecords` (Task 1), `KalshiFeed`/`PolymarketFeed` (`src/kalshi/feed.js`, `src/polymarket/feed.js`), `PAIRS` (`src/registry/pairs.js`), `formatPrice` (`src/money.js`).
- Produces: `runLogger(opts: LoggerOptions): Promise<{ stop: () => void }>`.

- [ ] **Step 1: Implement** — create `src/logger/run.ts`:

```ts
/**
 * Live append-only logger (read-only). Subscribes the feeds to every loggable
 * (reviewed) pair's instruments, caches each instrument's latest {snapshot,
 * stale} from the push `update` events, and on a fixed interval appends a RAW
 * CaptureRecord + a computed StoredOpportunity per pair. Places no orders.
 */
import type { FeedClient, FeedUpdate, InstrumentRef } from "../feed/types.js";
import type { MarketPair } from "../registry/schema.js";
import type { Side } from "../book.js";
import type { Venue } from "../snapshot.js";
import { getLoggablePairs } from "../registry/schema.js";
import { buildCaptureRecord } from "./capture.js";
import type { InstrumentSnapshot, SnapshotLookup } from "./capture.js";
import { computeOpportunity } from "./compute.js";
import { DEFAULT_FEE_CONFIG } from "./model.js";
import { appendRecord, oppsPath, rawPath } from "../storage/jsonl.js";

export interface LoggerOptions {
  kalshiFeed: FeedClient;
  pmFeed: FeedClient;
  pairs: readonly MarketPair[];
  dataDir: string;
  intervalMs?: number;
  now?: () => number;
}

function instrumentsFor(pair: MarketPair): { kalshi: InstrumentRef[]; pm: InstrumentRef[] } {
  const kalshi: InstrumentRef[] = [
    { marketId: pair.kalshi.ticker, side: "yes" },
    { marketId: pair.kalshi.ticker, side: "no" },
  ];
  const pm: InstrumentRef[] =
    pair.polymarketUs.kind === "dualSlug"
      ? [
          { marketId: pair.polymarketUs.yesSlug, side: "yes" },
          { marketId: pair.polymarketUs.noSlug, side: "no" },
        ]
      : [{ marketId: pair.polymarketUs.slug, side: pair.polymarketUs.yesIsLong ? "yes" : "no" }];
  return { kalshi, pm };
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runLogger(opts: LoggerOptions): Promise<{ stop: () => void }> {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 1_000;
  const pairs = getLoggablePairs(opts.pairs);

  const key = (venue: Venue, marketId: string, side: Side): string => `${venue}:${marketId}:${side}`;
  const cache = new Map<string, InstrumentSnapshot>();
  const lookup: SnapshotLookup = (venue, marketId, side) => cache.get(key(venue, marketId, side)) ?? null;

  const onUpdate = (u: FeedUpdate): void => {
    cache.set(key(u.snapshot.venue, u.snapshot.marketId, u.snapshot.side), {
      snapshot: u.snapshot,
      stale: u.stale,
    });
  };
  opts.kalshiFeed.on("update", onUpdate);
  opts.pmFeed.on("update", onUpdate);

  const kalshiRefs: InstrumentRef[] = [];
  const pmRefs: InstrumentRef[] = [];
  for (const pair of pairs) {
    const { kalshi, pm } = instrumentsFor(pair);
    kalshiRefs.push(...kalshi);
    pmRefs.push(...pm);
  }
  if (kalshiRefs.length > 0) await opts.kalshiFeed.subscribe(kalshiRefs);
  if (pmRefs.length > 0) await opts.pmFeed.subscribe(pmRefs);

  let captureSeq = 0;
  const tick = (): void => {
    const captureMs = now();
    const date = dateOf(captureMs);
    for (const pair of pairs) {
      const captureId = `${captureMs}-${pair.pairId}-${captureSeq++}`;
      const record = buildCaptureRecord(pair, captureMs, captureId, lookup);
      if (!record) continue;
      const opp = computeOpportunity(record, DEFAULT_FEE_CONFIG);
      appendRecord(rawPath(opts.dataDir, date), record);
      appendRecord(oppsPath(opts.dataDir, date), opp);
    }
  };
  const timer = setInterval(tick, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      opts.kalshiFeed.close();
      opts.pmFeed.close();
    },
  };
}
```

- [ ] **Step 2: Implement** — create `src/scripts/logger.ts`:

```ts
/**
 * Read-only logger demo (issue #15): log the reviewed registry pairs' raw books
 * and computed opportunities to data/ for ~30s, then stop. No order placement.
 *
 * Usage: npm run log
 */
import { KalshiFeed } from "../kalshi/feed.js";
import { PolymarketFeed } from "../polymarket/feed.js";
import { PAIRS } from "../registry/pairs.js";
import { getLoggablePairs } from "../registry/schema.js";
import { runLogger } from "../logger/run.js";

async function main(): Promise<void> {
  const loggable = getLoggablePairs(PAIRS);
  if (loggable.length === 0) {
    console.log("No loggable (reviewed) pairs in the registry; nothing to log.");
    return;
  }
  console.log(`Logging ${loggable.length} reviewed pair(s): ${loggable.map((p) => p.pairId).join(", ")}`);

  const { stop } = await runLogger({
    kalshiFeed: new KalshiFeed(),
    pmFeed: new PolymarketFeed(),
    pairs: PAIRS,
    dataDir: "data",
    intervalMs: 1_000,
  });

  const runMs = 30_000;
  console.log(`Appending to data/raw and data/opps for ${runMs / 1000}s...`);
  setTimeout(() => {
    stop();
    console.log("Logger stopped.");
    process.exit(0);
  }, runMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Implement** — create `src/scripts/recompute.ts`:

```ts
/**
 * Recompute a day's opportunities from RAW capture records under a different fee
 * assumption (issue #15 verify: opps recomputable from raw with a CHANGED fee).
 *
 * Usage: npm run recompute -- <YYYY-MM-DD> <kalshiBps> <pmBps>
 */
import { readRecords, rawPath } from "../storage/jsonl.js";
import { recompute } from "../logger/recompute.js";
import type { CaptureRecord, StoredOpportunity } from "../logger/model.js";
import { formatPrice } from "../money.js";

function arg(i: number, name: string): string {
  const v = process.argv[i];
  if (v === undefined) throw new Error(`missing arg: ${name}`);
  return v;
}

function size1Net(opp: StoredOpportunity): number | null {
  return opp.edge.perSize.find((r) => r.sizeContracts === 1)?.best?.netPerContract ?? null;
}

function main(): void {
  const date = arg(2, "date (YYYY-MM-DD)");
  const kalshiRateBps = Number(arg(3, "kalshiBps"));
  const polymarketUsTakerBps = Number(arg(4, "pmBps"));

  const records = readRecords(rawPath("data", date)) as CaptureRecord[];
  const opps = recompute(records, { kalshiRateBps, polymarketUsTakerBps });
  console.log(
    `Recomputed ${opps.length} opportunit(ies) for ${date} at ` +
      `kalshi=${kalshiRateBps}bps pm=${polymarketUsTakerBps}bps:`,
  );
  for (const o of opps) {
    const net = size1Net(o);
    console.log(
      `  ${o.pairId} @${o.captureMs} skew=${o.bookSkewMs}ms: ` +
        `size-1 best net = ${net !== null ? formatPrice(net) : "unfillable"}`,
    );
  }
}

main();
```

- [ ] **Step 4: Add scripts to `package.json`** — in `"scripts"`, after `"feed"`:

```json
    "log": "tsx src/scripts/logger.ts",
    "recompute": "tsx src/scripts/recompute.ts",
```

- [ ] **Step 5: Reconcile the CLAUDE.md safety rule.** Replace this bullet in the "Safety rules for this repo" section:

```markdown
- Always validate that BOTH legs of a matched pair resolve identically (same
  source, timestamp, and strike) before treating a spread as arbitrage. Use
  Kalshi market rules and Polymarket US `markets.settlement` to verify, and record
  the result in the `src/registry/` pair registry (`resolutionVerified` only true
  when all checks pass). Never compare/log a pair that is not `isVerified`.
```

with:

```markdown
- Always validate that BOTH legs of a matched pair resolve identically (same
  source, timestamp, and strike) before treating a spread as arbitrage. Use
  Kalshi market rules and Polymarket US `markets.settlement` to verify, and record
  the result in the `src/registry/` pair registry (`resolutionVerified` only true
  when all checks pass). The **read-only logger gates on `isReviewed`** (all three
  dimension flags true), NOT on `resolutionVerified`: logging gathers the data
  that informs certification, so it must not require certification first.
  `resolutionVerified` / `isVerified` is the stricter gate for treating a pair as
  a tradeable arb (a future execution-phase concern) — never trade an unverified
  pair.
```

- [ ] **Step 6: Document the logger** in CLAUDE.md. After the "Per-opportunity timing (`src/opportunity.ts`)" bullet in "Stack & conventions", add:

```markdown
- Append-only logger (`src/logger/`, `src/storage/jsonl.ts`): subscribes the #13
  feeds to `getLoggablePairs(PAIRS)`, samples each on an interval (default 1s via
  `runLogger`), and appends RAW `CaptureRecord`s (`data/raw/<date>.jsonl`) +
  computed `StoredOpportunity`s (`data/opps/<date>.jsonl`) — separate append-only
  JSONL stores. A `CaptureRecord` stores each leg's books aligned to the pair's
  YES/NO (Kalshi `yesSide` inversion + dual/single mapping applied at capture in
  `src/logger/capture.ts`), so `recompute(records, feeConfig)` regenerates opps
  under a **changed fee** (`FeeConfig` = per-venue bps; `compute.ts` is the shared
  core used live and on recompute). Pure cores have no I/O. Demos: `npm run log`,
  `npm run recompute -- <date> <kalshiBps> <pmBps>`.
```

- [ ] **Step 7: Add the commands** to the "Commands" section of CLAUDE.md, after `npm run feed`:

```markdown
- `npm run log` — read-only: log reviewed registry pairs (raw books + computed
  opps) to `data/` for ~30s.
- `npm run recompute -- <date> <kalshiBps> <pmBps>` — recompute that day's opps
  from raw under a different fee assumption.
```

- [ ] **Step 8: Typecheck, build, and full test suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: PASS (all prior tests green; no test for the I/O `run.ts`/scripts by design).

- [ ] **Step 9: Live smoke (best-effort).** There is no `timeout` on this machine; the script self-exits after ~30s.

Run: `npm run log`
Expected: prints the reviewed pairs, runs ~30s, and writes `data/raw/<today>.jsonl` + `data/opps/<today>.jsonl` (if the live markets have books). Then:
Run: `npm run recompute -- <today's date> 1000 500`
Expected: prints recomputed size-1 nets per logged opportunity under the changed Kalshi fee. If no live books were available, the files may be empty — note it; the persistence + recompute logic is covered by the unit tests regardless.

- [ ] **Step 10: Commit**

```bash
git add src/logger/run.ts src/scripts/logger.ts src/scripts/recompute.ts package.json CLAUDE.md
git commit -m "Add live logger orchestration + log/recompute scripts; reconcile CLAUDE.md gate"
```

---

## Self-Review Notes

- **Spec coverage:** JSONL storage + restart persistence → Task 1 (+ checkbox 1 test); reviewed gate + CLAUDE.md reconcile → Task 2 + Task 5 step 5; data model → Task 3 model.ts; shared compute core → Task 3 compute.ts; recompute + changed-fee (checkbox 2) → Task 3 recompute.ts (+ test); capture mapping (yesSide/dual/single/skip) → Task 4; live orchestration + scripts + docs → Task 5.
- **Type consistency:** `CaptureRecord`/`CaptureLeg`/`FeeConfig`/`StoredOpportunity`/`DEFAULT_FEE_CONFIG` defined in Task 3 `model.ts` and consumed identically in Tasks 3–5. `SnapshotLookup`/`InstrumentSnapshot`/`buildCaptureRecord` from Task 4 used in Task 5. `appendRecord`/`rawPath`/`oppsPath`/`readRecords` from Task 1 used in Task 5. `VenueLeg` fee signature `(priceUnits, qtyUnits) => number` matches `netEdge`'s use.
- **No placeholders:** every code step is complete; the registry test reuses the existing `sample()` fixture; the capture test builds its own minimal `MarketPair`.
- **Reuse verified:** `feeUnits`, `netEdge`/`VenueLeg`, `buildOpportunity`, `BookSnapshot`/`Venue`, `FeedClient`/`FeedUpdate`/`InstrumentRef`, `MarketPair`, `formatPrice` all exist with the signatures used. Both current `PAIRS` are reviewed single-market pairs, so the live logger exercises the single-market path.
