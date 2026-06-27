# Feed-Staleness Alerting + Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add heartbeat logging, feed-staleness alerting, and stale-opportunity exclusion to the live logger.

**Architecture:** All changes land in `src/logger/run.ts`. A `venueStale` map in `runLogger` tracks per-venue staleness state; the existing `onUpdate` handler alerts on transitions; `tick()` gains a heartbeat log and skips appending opps when any leg is stale. Tests live in a new `src/logger/run.test.ts` using mock `FeedClient` implementations and real temp directories.

**Tech Stack:** TypeScript, Node.js 18+ (`node:test`, `node:fs`, `node:os`), `tsx`

## Global Constraints

- Money values are integer 1/10000-dollar units — do not introduce floats.
- No order placement; no `orders.*` calls anywhere.
- Tests use `node:test` runner (zero extra deps), run via `tsx src/**/*.test.ts`.
- `npm run typecheck` must pass; `npm test` must pass.
- `appendRecord` (in `src/storage/jsonl.ts`) creates parent dirs automatically — safe to use with temp dirs in tests.

---

### Task 1: Tests + implementation for heartbeat, staleness alerting, and stale exclusion

**Files:**
- Create: `src/logger/run.test.ts`
- Modify: `src/logger/run.ts`

**Interfaces:**
- Consumes: `runLogger(opts: LoggerOptions): Promise<{ stop: () => void }>` from `src/logger/run.ts` (unchanged signature)
- Produces: no new exports; three new runtime behaviors described in tests

---

- [ ] **Step 1: Write the failing tests**

Create `src/logger/run.test.ts`:

```typescript
import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedClient, FeedUpdate, FeedUpdateHandler, InstrumentRef } from "../feed/types.js";
import type { Side } from "../book.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
import { runLogger } from "./run.js";

// Minimal FeedClient that lets the test push FeedUpdates synchronously.
class MockFeed implements FeedClient {
  private handlers: FeedUpdateHandler[] = [];
  async subscribe(_instruments: InstrumentRef[]): Promise<void> {}
  on(_event: "update", handler: FeedUpdateHandler): void { this.handlers.push(handler); }
  getSnapshot(_marketId: string, _side: Side): BookSnapshot | null { return null; }
  close(): void { this.handlers = []; }
  push(update: FeedUpdate): void { for (const h of this.handlers) h(update); }
}

function makeSnapshot(venue: Venue, marketId: string, side: Side, tsLocalMs = Date.now()): BookSnapshot {
  return { venue, marketId, side, tsLocalMs, bids: [], asks: [] };
}

describe("runLogger heartbeat", () => {
  it("logs a heartbeat line to console.log each tick", async () => {
    const lines: string[] = [];
    const logSpy = mock.method(console, "log", (...args: unknown[]) => { lines.push(String(args[0])); });
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));

    const { stop } = await runLogger({
      kalshiFeed: new MockFeed(),
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    stop();

    const heartbeats = lines.filter((l) => l.includes("[logger] heartbeat"));
    assert.ok(heartbeats.length >= 3, `expected ≥3 heartbeats, got ${heartbeats.length}`);
    // Each heartbeat should contain an ISO timestamp
    for (const h of heartbeats) assert.match(h, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    logSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });
});

describe("runLogger staleness alerting", () => {
  it("writes ALERT to console.error on first stale update from a venue", async () => {
    const errors: string[] = [];
    const errSpy = mock.method(console, "error", (...args: unknown[]) => { errors.push(String(args[0])); });
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });

    const alerts = errors.filter((e) => e.includes("ALERT"));
    assert.equal(alerts.length, 1, "exactly one ALERT expected");
    assert.ok(alerts[0].includes("kalshi"), "alert should name the venue");

    stop();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });

  it("does not emit a duplicate ALERT when a second stale update arrives for the same venue", async () => {
    const errors: string[] = [];
    const errSpy = mock.method(console, "error", (...args: unknown[]) => { errors.push(String(args[0])); });
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-NO",  "no"),  stale: true });

    const alerts = errors.filter((e) => e.includes("ALERT"));
    assert.equal(alerts.length, 1, "second stale event must not re-alert");

    stop();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });

  it("logs RECOVERED to console.log when a stale venue emits a non-stale update", async () => {
    const lines: string[] = [];
    const logSpy = mock.method(console, "log", (...args: unknown[]) => { lines.push(String(args[0])); });
    const errSpy  = mock.method(console, "error", () => {});
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: false });

    const recoveries = lines.filter((l) => l.includes("RECOVERED"));
    assert.equal(recoveries.length, 1, "exactly one RECOVERED expected");
    assert.ok(recoveries[0].includes("kalshi"), "recovery should name the venue");

    stop();
    logSpy.mock.restore();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx tsx --test src/logger/run.test.ts
```

Expected: all three `staleness alerting` tests fail ("ALERT"/"RECOVERED" not found), heartbeat test fails ("expected ≥3 heartbeats, got 0").

- [ ] **Step 3: Implement all three behaviors in `src/logger/run.ts`**

Replace the file with this updated version (all additions are highlighted inline):

```typescript
/**
 * Live append-only logger (read-only). Subscribes the feeds to every loggable
 * (reviewed) pair's instruments, caches each instrument's latest {snapshot,
 * stale} from the push `update` events, and on a fixed interval appends a RAW
 * CaptureRecord + a computed StoredOpportunity per pair. Places no orders.
 *
 * Ops behaviors:
 *  - Heartbeat: logs "[logger] heartbeat <ISO>" to stdout each tick.
 *  - Feed alerting: logs an ALERT to stderr when any venue first goes stale;
 *    logs RECOVERED to stdout when it returns to non-stale.
 *  - Stale exclusion: raw captures are always written; opportunity records are
 *    only written when BOTH legs are non-stale.
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

  // Track per-venue staleness to fire exactly one ALERT per drop, one RECOVERED per recovery.
  const venueStale = new Map<Venue, boolean>();

  const onUpdate = (u: FeedUpdate): void => {
    cache.set(key(u.snapshot.venue, u.snapshot.marketId, u.snapshot.side), {
      snapshot: u.snapshot,
      stale: u.stale,
    });
    const venue = u.snapshot.venue;
    const prev = venueStale.get(venue) ?? false;
    if (u.stale && !prev) {
      console.error(`[logger] ALERT: ${venue} feed stale at ${new Date(u.snapshot.tsLocalMs).toISOString()}`);
      venueStale.set(venue, true);
    } else if (!u.stale && prev) {
      console.log(`[logger] RECOVERED: ${venue} feed recovered`);
      venueStale.set(venue, false);
    }
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
    console.log("[logger] heartbeat", new Date(captureMs).toISOString());
    const date = dateOf(captureMs);
    for (const pair of pairs) {
      try {
        const captureId = `${captureMs}-${pair.pairId}-${captureSeq++}`;
        const record = buildCaptureRecord(pair, captureMs, captureId, lookup);
        if (!record) continue;
        appendRecord(rawPath(opts.dataDir, date), record);
        if (!record.legA.stale && !record.legB.stale) {
          const opp = computeOpportunity(record, DEFAULT_FEE_CONFIG);
          appendRecord(oppsPath(opts.dataDir, date), opp);
        }
      } catch (err) {
        console.error("[logger] capture failed for " + pair.pairId + ":", err);
      }
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

- [ ] **Step 4: Run tests to verify they pass**

```
npx tsx --test src/logger/run.test.ts
```

Expected: all four tests pass (heartbeat ≥3 lines, ALERT fires once per venue drop, no duplicate ALERT, RECOVERED fires on recovery).

- [ ] **Step 5: Run the full test suite and typecheck**

```
npm run typecheck && npm test
```

Expected: zero type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/logger/run.ts src/logger/run.test.ts
git commit -m "feat(logger): heartbeat + feed-staleness alerting + stale opp exclusion (issue #16)"
```
