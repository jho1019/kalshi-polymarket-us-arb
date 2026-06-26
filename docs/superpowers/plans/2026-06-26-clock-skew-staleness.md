# Clock Skew & Book Staleness Per Opportunity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record per-opportunity timing — `bookSkewMs` between the two legs and per-leg staleness — with freshness filters, so the analysis phase can separate real simultaneous spreads from stale artifacts.

**Architecture:** A pure `Opportunity` model + builder + filters (`src/opportunity.ts`), computed entirely from `BookSnapshot.tsLocalMs` (same local clock for both legs). A foundation fix first makes `tsLocalMs` mean "last book-update time" in the Kalshi feed (it currently stamps pull time, so a Kalshi book always looks fresh). No live loop, no persistence — those are #15, which calls `buildOpportunity` and stores its output.

**Tech Stack:** TypeScript / Node 18+, ESM/NodeNext (`.js` import specifiers), `node:test` via `tsx`.

## Global Constraints

- **Integer ms timestamps.** All times are integer ms since epoch (`number`), matching `BookSnapshot.tsLocalMs`. Durations are integer subtraction. No JS floats.
- **`src/opportunity.ts` is pure:** no I/O, no `Date.now()`. `captureMs` is always passed in by the caller (the #15 loop supplies `Date.now()`).
- **Skew/staleness use `tsLocalMs`, never `tsVenue`** (same local clock; cross-venue server clocks are not comparable).
- **`tsLocalMs` means "last book-update time"** — the time the book last changed (last applied snapshot/delta for Kalshi; last full-book message for PM), not when the snapshot was serialized.
- **READ-ONLY phase:** no order placement, no `orders.*`.
- **Reuse** `BookSnapshot`/`Venue` (`src/snapshot.ts`) and `NetEdgeReport` (`src/edge.ts`); do not duplicate the snapshot model or edge calc.
- Tests are `src/**/*.test.ts` via `npm test`; `npm run typecheck` and `npm run build` must pass.

---

### Task 1: Foundation fix — `tsLocalMs` = last book-update time

`KalshiLiveBook` currently has the feed pass `Date.now()` into `toSnapshot` at call time, so `getSnapshot` reports pull time and a Kalshi book always looks fresh. Make the book own its last-update time. The signature change to `applySnapshot`/`applyDelta` must propagate to the feed in the same commit so the build stays green, so this is one task.

**Files:**
- Modify: `src/kalshi/live-book.ts`
- Modify: `src/kalshi/feed.ts` (call sites: `handleMessage`, `getSnapshot`, `emitFor`)
- Test: `src/kalshi/live-book.test.ts` (rewrite to new signatures + new assertions)

**Interfaces:**
- Produces (`KalshiLiveBook`):
  - `applySnapshot(msg: KalshiSnapshotMsg, seq: number, tsLocalMs: number): void`
  - `applyDelta(msg: KalshiDeltaMsg, seq: number, tsLocalMs: number): boolean`
  - `toSnapshot(side: Side): BookSnapshot` (no time param; throws if no update applied yet)
  - `get lastUpdateMs(): number | null`
  - `reset(): void` (now also clears `lastUpdateMs`)

- [ ] **Step 1: Rewrite the test file** `src/kalshi/live-book.test.ts` to the new signatures and add the timing assertions:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { KalshiLiveBook } from "./live-book.js";

function fresh(tsLocalMs = 1000): KalshiLiveBook {
  const b = new KalshiLiveBook("TEST-TICKER");
  b.applySnapshot(
    {
      market_ticker: "TEST-TICKER",
      yes_dollars_fp: [["0.6000", "10.00"]],
      no_dollars_fp: [["0.3500", "20.00"]],
    },
    1,
    tsLocalMs,
  );
  return b;
}

test("snapshot then delta updates the YES bid book", () => {
  const b = fresh();
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    2,
    2000,
  );
  assert.equal(gap, false);
  const yes = b.toSnapshot("yes");
  assert.deepEqual(yes.bids, [{ price: 6000, qty: 150000 }]); // 10 + 5 = 15.0000
  assert.equal(yes.seq, 2);
});

test("delta to zero removes the level", () => {
  const b = fresh();
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.3500", delta_fp: "-20.00", side: "no" },
    2,
    2000,
  );
  assert.deepEqual(b.toSnapshot("no").bids, []);
});

test("seq gap is reported and leaves the book unchanged", () => {
  const b = fresh();
  const before = b.toSnapshot("yes");
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    5, // skipped 2..4
    9999,
  );
  assert.equal(gap, true);
  assert.deepEqual(b.toSnapshot("yes").bids, before.bids);
});

test("snapshot with only no_dollars_fp (missing yes_dollars_fp) does not throw", () => {
  const b = new KalshiLiveBook("TEST");
  const msg = {
    market_ticker: "TEST",
    no_dollars_fp: [["0.0100", "289658.00"], ["0.0200", "15.00"]],
  } as unknown as import("./live-book.js").KalshiSnapshotMsg;
  assert.doesNotThrow(() => b.applySnapshot(msg, 1, 1000));
  assert.deepEqual(b.toSnapshot("yes").bids, []);
  const noSnap = b.toSnapshot("no");
  assert.ok(noSnap.bids.length > 0, "NO bids should be non-empty");
  assert.equal(noSnap.bids[0]?.price, 200); // 0.0200 best NO bid → 200 units
});

test("toSnapshot stamps tsLocalMs from the last applied update", () => {
  const b = fresh(1000);
  assert.equal(b.toSnapshot("yes").tsLocalMs, 1000);
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    2,
    2500,
  );
  assert.equal(b.toSnapshot("yes").tsLocalMs, 2500);
  assert.equal(b.lastUpdateMs, 2500);
});

test("a seq gap does not advance lastUpdateMs", () => {
  const b = fresh(1000);
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    7, // gap
    8000,
  );
  assert.equal(b.lastUpdateMs, 1000); // unchanged
  assert.equal(b.toSnapshot("yes").tsLocalMs, 1000);
});

test("toSnapshot before any update throws; lastUpdateMs is null", () => {
  const b = new KalshiLiveBook("TEST");
  assert.equal(b.lastUpdateMs, null);
  assert.throws(() => b.toSnapshot("yes"), /before any update/);
});

test("reset clears lastUpdateMs", () => {
  const b = fresh(1000);
  b.reset();
  assert.equal(b.lastUpdateMs, null);
  assert.throws(() => b.toSnapshot("yes"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `applySnapshot`/`applyDelta` reject the 3rd arg / `toSnapshot` still requires the meta arg / `lastUpdateMs` not defined (compile or assertion errors).

- [ ] **Step 3: Update `src/kalshi/live-book.ts`** — add `lastUpdateMs` ownership. Replace the class body (the four methods + fields) with:

```ts
export class KalshiLiveBook {
  private readonly yes = new PriceLevels();
  private readonly no = new PriceLevels();
  private seq: number | null = null;
  private updatedMs: number | null = null;

  constructor(readonly ticker: string) {}

  /** Local time (ms) of the last applied update, or null before the first snapshot. */
  get lastUpdateMs(): number | null {
    return this.updatedMs;
  }

  /** Replace the whole book from a snapshot; set the seq baseline and update time. */
  applySnapshot(msg: KalshiSnapshotMsg, seq: number, tsLocalMs: number): void {
    this.yes.replace(toLevels(msg.yes_dollars_fp ?? []));
    this.no.replace(toLevels(msg.no_dollars_fp ?? []));
    this.seq = seq;
    this.updatedMs = tsLocalMs;
  }

  /**
   * Apply one delta. Returns `true` if a seq gap is detected — in that case the
   * book and update time are left unchanged and the caller should resubscribe
   * for a fresh snapshot.
   */
  applyDelta(msg: KalshiDeltaMsg, seq: number, tsLocalMs: number): boolean {
    if (isSeqGap(this.seq, seq)) return true;
    const levels = msg.side === "yes" ? this.yes : this.no;
    levels.applyDelta(parsePrice(msg.price_dollars), parseSignedQty(msg.delta_fp));
    this.seq = seq;
    this.updatedMs = tsLocalMs;
    return false;
  }

  /** Discard local state (after a disconnect or seq gap, before re-snapshot). */
  reset(): void {
    this.yes.clear();
    this.no.clear();
    this.seq = null;
    this.updatedMs = null;
  }

  /**
   * Render the current book as a one-sided `BookSnapshot`, stamped with the time
   * of the last applied update. Throws if called before any update (the feed
   * guards this via `lastUpdateMs`).
   */
  toSnapshot(side: Side): BookSnapshot {
    if (this.updatedMs === null) {
      throw new Error(`KalshiLiveBook.toSnapshot(${this.ticker}) called before any update`);
    }
    const book: Book = {
      ticker: this.ticker,
      yesBids: this.yes.toSorted(true),
      noBids: this.no.toSorted(true),
    };
    return bookToSnapshot(book, side, {
      tsLocalMs: this.updatedMs,
      ...(this.seq !== null ? { seq: this.seq } : {}),
    });
  }
}
```

- [ ] **Step 4: Update the feed call sites in `src/kalshi/feed.ts`.**

In `getSnapshot` (currently lines ~64-68), guard on `lastUpdateMs` and drop the time arg:

```ts
  getSnapshot(marketId: string, side: Side): BookSnapshot | null {
    const book = this.books.get(marketId);
    if (!book || book.lastUpdateMs === null) return null;
    return book.toSnapshot(side);
  }
```

In `handleMessage`, capture the local receipt time once and pass it into both apply calls. Replace the `orderbook_snapshot`/`orderbook_delta` block body (after `if (!book || parsed.seq === undefined) return;`) with:

```ts
      const nowMs = Date.now();
      if (parsed.type === "orderbook_snapshot") {
        book.applySnapshot(parsed.msg as KalshiSnapshotMsg, parsed.seq, nowMs);
        this.stale.delete(ticker);
        this.emitFor(ticker);
      } else {
        const gap = book.applyDelta(parsed.msg as KalshiDeltaMsg, parsed.seq, nowMs);
        if (gap) {
          // Force a clean reconnect: closing triggers the reconnect path which
          // resubscribes ALL tickers and delivers fresh snapshots. Re-sending
          // subscribe on the same socket risks a duplicate-subscription reject.
          this.stale.add(ticker);
          book.reset();
          this.ws?.close();
        } else {
          this.emitFor(ticker);
        }
      }
      return;
```

In `emitFor`, skip a book that has no data yet (so the stale-on-drop emit can't throw on a never-populated or reset book) and drop the time arg:

```ts
  private emitFor(ticker: string): void {
    const sides = this.sides.get(ticker);
    const book = this.books.get(ticker);
    if (!sides || !book || book.lastUpdateMs === null) return;
    const isStale = this.stale.has(ticker);
    for (const side of sides) {
      const update: FeedUpdate = {
        snapshot: book.toSnapshot(side),
        stale: isStale,
      };
      this.emitter.emit("update", update);
    }
  }
```

- [ ] **Step 5: Run tests + typecheck + build to verify green**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS — all live-book tests pass (the suite total goes from 52 to 56 with the 4 new timing tests), no type errors, clean build.

- [ ] **Step 6: Commit**

```bash
git add src/kalshi/live-book.ts src/kalshi/live-book.test.ts src/kalshi/feed.ts
git commit -m "Make Kalshi tsLocalMs the last book-update time (not pull time)"
```

---

### Task 2: `Opportunity` model, builder, and freshness filters

The pure module that records skew/staleness and filters by freshness. Implements both verify checkboxes. Also documents the new concept (and the tsLocalMs semantics from Task 1) in CLAUDE.md.

**Files:**
- Create: `src/opportunity.ts`
- Test: `src/opportunity.test.ts`
- Modify: `CLAUDE.md` (add an Opportunity bullet + the tsLocalMs-semantics note)

**Interfaces:**
- Consumes: `BookSnapshot`, `Venue` from `src/snapshot.js`; `NetEdgeReport` from `src/edge.js`.
- Produces:
  - `interface OpportunityLeg { venue: Venue; tsLocalMs: number; ageMs: number; stale: boolean }`
  - `interface Opportunity { pairId: string; captureMs: number; bookSkewMs: number; legA: OpportunityLeg; legB: OpportunityLeg; edge: NetEdgeReport }`
  - `interface OpportunityLegInput { venue: Venue; snapshots: BookSnapshot[]; stale: boolean }`
  - `interface BuildOpportunityInput { pairId: string; captureMs: number; legA: OpportunityLegInput; legB: OpportunityLegInput; edge: NetEdgeReport }`
  - `buildOpportunity(input: BuildOpportunityInput): Opportunity`
  - `withinSkew(opp: Opportunity, maxSkewMs: number): boolean`
  - `bothFresh(opp: Opportunity, maxAgeMs: number): boolean`

- [ ] **Step 1: Write the failing test** — create `src/opportunity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpportunity, withinSkew, bothFresh } from "./opportunity.js";
import type { BuildOpportunityInput } from "./opportunity.js";
import type { BookSnapshot, Venue } from "./snapshot.js";
import type { NetEdgeReport } from "./edge.js";

const EDGE: NetEdgeReport = { perSize: [], maxProfitableSize: null };

function snap(venue: Venue, tsLocalMs: number): BookSnapshot {
  return { venue, marketId: "m", side: "yes", tsLocalMs, bids: [], asks: [] };
}

function input(over: Partial<BuildOpportunityInput> = {}): BuildOpportunityInput {
  return {
    pairId: "PAIR-1",
    captureMs: 10_000,
    legA: { venue: "kalshi", snapshots: [snap("kalshi", 9_800)], stale: false },
    legB: { venue: "polymarket-us", snapshots: [snap("polymarket-us", 9_500)], stale: false },
    edge: EDGE,
    ...over,
  };
}

test("bookSkewMs is the absolute difference between the two legs' tsLocalMs", () => {
  assert.equal(buildOpportunity(input()).bookSkewMs, 300); // |9800 - 9500|
});

test("per-leg ageMs is captureMs minus the leg's tsLocalMs", () => {
  const opp = buildOpportunity(input());
  assert.equal(opp.legA.ageMs, 200); // 10000 - 9800
  assert.equal(opp.legB.ageMs, 500); // 10000 - 9500
});

test("a multi-book leg takes the OLDEST (min) snapshot time", () => {
  const opp = buildOpportunity(
    input({
      legB: {
        venue: "polymarket-us",
        snapshots: [snap("polymarket-us", 9_900), snap("polymarket-us", 9_400)],
        stale: false,
      },
    }),
  );
  assert.equal(opp.legB.tsLocalMs, 9_400); // oldest of the two PM books
  assert.equal(opp.legB.ageMs, 600); // 10000 - 9400
  assert.equal(opp.bookSkewMs, 400); // |9800 - 9400|
});

test("stale flag is carried through per leg", () => {
  const opp = buildOpportunity(
    input({ legA: { venue: "kalshi", snapshots: [snap("kalshi", 9_800)], stale: true } }),
  );
  assert.equal(opp.legA.stale, true);
  assert.equal(opp.legB.stale, false);
});

test("withinSkew includes at the boundary and excludes just past it", () => {
  const opp = buildOpportunity(input()); // skew 300
  assert.equal(withinSkew(opp, 300), true);
  assert.equal(withinSkew(opp, 299), false);
  assert.equal(withinSkew(opp, 1000), true);
});

test("bothFresh requires BOTH legs within maxAgeMs (boundary inclusive)", () => {
  const opp = buildOpportunity(input()); // ages: A=200, B=500
  assert.equal(bothFresh(opp, 500), true); // both <= 500
  assert.equal(bothFresh(opp, 499), false); // legB 500 > 499
  assert.equal(bothFresh(opp, 200), false); // legB 500 > 200
});

test("a leg with no snapshots throws", () => {
  assert.throws(
    () => buildOpportunity(input({ legA: { venue: "kalshi", snapshots: [], stale: false } })),
    /at least one snapshot/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./opportunity.js` not found.

- [ ] **Step 3: Implement** — create `src/opportunity.ts`:

```ts
/**
 * Per-opportunity timing metadata: clock skew between the two legs' books and
 * per-leg staleness, plus freshness filters. An apparent spread whose two books
 * were captured seconds apart is staleness, not edge.
 *
 * All times are LOCAL capture times (`BookSnapshot.tsLocalMs`) on one clock, so
 * `bookSkewMs` is a true measure of how far apart we saw the two books — NOT a
 * cross-venue server-clock comparison (`tsVenue`), which is not trustworthy.
 * Pure module: no I/O, no `Date.now()`; `captureMs` is always supplied.
 */
import type { BookSnapshot, Venue } from "./snapshot.js";
import type { NetEdgeReport } from "./edge.js";

export interface OpportunityLeg {
  venue: Venue;
  /** Representative last-update time for this leg (oldest of its books). */
  tsLocalMs: number;
  /** captureMs − tsLocalMs: how stale this leg was when computed. */
  ageMs: number;
  /** Feed stale flag (book awaiting a fresh snapshot after a drop). */
  stale: boolean;
}

export interface Opportunity {
  pairId: string;
  captureMs: number;
  /** |legA.tsLocalMs − legB.tsLocalMs|: skew between the two legs' captures. */
  bookSkewMs: number;
  legA: OpportunityLeg;
  legB: OpportunityLeg;
  edge: NetEdgeReport;
}

export interface OpportunityLegInput {
  venue: Venue;
  /** The book(s) this leg used: 1 (Kalshi / PM single) or 2 (PM dual-slug). */
  snapshots: BookSnapshot[];
  stale: boolean;
}

export interface BuildOpportunityInput {
  pairId: string;
  captureMs: number;
  legA: OpportunityLegInput;
  legB: OpportunityLegInput;
  edge: NetEdgeReport;
}

/** A leg is only as fresh as its STALEST book → the oldest (min) tsLocalMs. */
function representativeTsLocalMs(snapshots: BookSnapshot[]): number {
  if (snapshots.length === 0) {
    throw new Error("buildOpportunity: a leg must have at least one snapshot");
  }
  return snapshots.reduce((min, s) => Math.min(min, s.tsLocalMs), Infinity);
}

function buildLeg(input: OpportunityLegInput, captureMs: number): OpportunityLeg {
  const tsLocalMs = representativeTsLocalMs(input.snapshots);
  return { venue: input.venue, tsLocalMs, ageMs: captureMs - tsLocalMs, stale: input.stale };
}

/** Build an Opportunity, computing per-leg staleness and inter-leg book skew. */
export function buildOpportunity(input: BuildOpportunityInput): Opportunity {
  const legA = buildLeg(input.legA, input.captureMs);
  const legB = buildLeg(input.legB, input.captureMs);
  return {
    pairId: input.pairId,
    captureMs: input.captureMs,
    bookSkewMs: Math.abs(legA.tsLocalMs - legB.tsLocalMs),
    legA,
    legB,
    edge: input.edge,
  };
}

/** True if the two legs were captured within `maxSkewMs` of each other (headline filter). */
export function withinSkew(opp: Opportunity, maxSkewMs: number): boolean {
  return opp.bookSkewMs <= maxSkewMs;
}

/** True if BOTH legs' books are no older than `maxAgeMs` at compute time. */
export function bothFresh(opp: Opportunity, maxAgeMs: number): boolean {
  return opp.legA.ageMs <= maxAgeMs && opp.legB.ageMs <= maxAgeMs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (all opportunity tests, plus the rest of the suite).

- [ ] **Step 5: Update `CLAUDE.md`.** Immediately after the "Live feeds (`src/feed/`, …)" bullet in the **Stack & conventions** section, add:

```markdown
- Per-opportunity timing (`src/opportunity.ts`): `buildOpportunity` wraps a
  registry pair's two legs + the `netEdge` result with `bookSkewMs`
  (`|legA.tsLocalMs − legB.tsLocalMs|`, same local clock — NOT cross-venue
  `tsVenue`) and per-leg `ageMs` (staleness at compute time). A leg's
  representative time is the OLDEST of its books (PM dual-slug has two, which can
  tick apart). Filters: `withinSkew(opp, maxSkewMs)` (headline — "two books
  seconds apart = staleness") and `bothFresh(opp, maxAgeMs)`. Pure: `captureMs`
  is passed in. #15 calls this in the logging loop and persists the result.
- `BookSnapshot.tsLocalMs` is the time the book was **last updated** (last applied
  snapshot/delta for Kalshi via `KalshiLiveBook.lastUpdateMs`; last full-book
  message for PM), so staleness/skew are measurable. `getSnapshot` reports that
  time, not the pull time, and returns `null` before a book has any data.
```

- [ ] **Step 6: Run the full suite + typecheck + build once more**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/opportunity.ts src/opportunity.test.ts CLAUDE.md
git commit -m "Add Opportunity model: bookSkewMs, per-leg staleness, freshness filters"
```

---

## Self-Review Notes

- **Spec coverage:** `Opportunity`/`OpportunityLeg` model → Task 2; `buildOpportunity` skew/age computation + dual-slug min-time rule → Task 2; `withinSkew`/`bothFresh` filters (both verify checkboxes) → Task 2 tests; `tsLocalMs` = last-update foundation fix (incl. Kalshi `getSnapshot` pull-time bug) → Task 1; `tsVenue`-not-used decision → enforced by only reading `tsLocalMs`; purity/integer-ms constraints → Task 2 impl + tests.
- **Type consistency:** `lastUpdateMs` getter + 3-arg `applySnapshot`/`applyDelta` + 1-arg `toSnapshot` used identically in Task 1 live-book impl, its tests, and the feed call sites. `BuildOpportunityInput`/`Opportunity`/`OpportunityLeg` field names match between impl and tests.
- **No placeholders:** every code step contains complete code; commands have expected output.
- **Call-site completeness:** the only callers of `KalshiLiveBook.toSnapshot`/`applySnapshot`/`applyDelta` are `src/kalshi/feed.ts` and `src/kalshi/live-book.test.ts` (verified by grep); `feed-demo.ts` uses `KalshiFeed.getSnapshot` (signature unchanged) and the REST `toBookSnapshot`, so no demo change is needed.
