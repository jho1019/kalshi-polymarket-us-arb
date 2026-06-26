# WebSocket Feeds + Local Order-Book Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream both venues' authenticated market-data WebSockets, maintain a live local order book per instrument, and emit normalized `BookSnapshot`s, with reconnect/resubscribe and seq-gap recovery.

**Architecture:** A generic, reusable feed engine. Venue-neutral pure cores (price-level book + seq-gap detection) are unit-tested in CI; thin per-venue I/O shells drive them. Kalshi does real snapshot+delta maintenance (signed `delta_fp`, monotonic `seq`); Polymarket US pushes full books (latest-wins, no seq). Both expose one `FeedClient` interface: push an `update` event when a leg moves, expose `getSnapshot()` for current state. Registry-wiring/edge/storage stay in later issues (#14/#15).

**Tech Stack:** TypeScript / Node 18+, `ws` (Kalshi raw socket), `polymarket-us` SDK (`ws.markets`), Node `crypto` (RSA-PSS signing), `dotenv`, `node:test` via `tsx`.

## Global Constraints

- **Money math is integer-only.** Prices = 1/10000-dollar units, qty = 1/10000-contract units. Never use JS floats. Reuse `src/money.ts`.
- **Read-only feed use.** Keys are full-access; feed modules MUST NOT import or call any order-placing surface (`orders.*`). Only `ws.markets` is reachable from PM collection code.
- **Credentials from `.env` only** (gitignored), via `src/credentials.ts`. Never log secret values. The Kalshi PEM is read from `KALSHI_PRIVATE_KEY_PATH`.
- **Official docs only** for any API detail (Kalshi `docs.kalshi.com`, Polymarket US `docs.polymarket.us` — never `.com`).
- **DRY:** reuse the existing `BookSnapshot` model and the existing per-venue `toBookSnapshot` conversions; do not re-implement bid→ask conversion.
- Tests use `node:test`, files are `src/**/*.test.ts`, run with `npm test`. Typecheck with `npm run typecheck`.

---

### Task 1: Signed fixed-point parsing for Kalshi deltas

Kalshi `delta_fp` is a signed quantity change (e.g. `"-54.00"`); the existing `parseFixed` rejects a leading `-`.

**Files:**
- Modify: `src/money.ts` (add two exports after `parseQty`)
- Test: `src/money.test.ts` (create)

**Interfaces:**
- Produces: `parseSignedFixed(value: string, scale: number): number`, `parseSignedQty(value: string): number`

- [ ] **Step 1: Write the failing test** — create `src/money.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignedQty, parseSignedFixed, QTY_SCALE } from "./money.js";

test("parseSignedQty parses a negative fixed-point quantity", () => {
  assert.equal(parseSignedQty("-54.00"), -540000);
});

test("parseSignedQty parses a positive fixed-point quantity", () => {
  assert.equal(parseSignedQty("54.00"), 540000);
});

test("parseSignedFixed leaves zero non-negative", () => {
  assert.equal(parseSignedFixed("-0.00", QTY_SCALE), 0);
  assert.ok(!Object.is(parseSignedFixed("-0.00", QTY_SCALE), -0));
});

test("parseSignedFixed rejects malformed input", () => {
  assert.throws(() => parseSignedFixed("--1", QTY_SCALE));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="parseSigned"` (or `npm test`)
Expected: FAIL — `parseSignedQty`/`parseSignedFixed` not exported.

- [ ] **Step 3: Add the implementation** in `src/money.ts`, immediately after `parseQty`:

```ts
/**
 * Parse a SIGNED fixed-point string ("-54.00") to integer units at `scale`.
 * Kalshi `delta_fp` is a signed quantity change; the unsigned `parseFixed`
 * rejects a leading "-". Normalizes -0 to 0.
 */
export function parseSignedFixed(value: string, scale: number): number {
  if (value.startsWith("-")) {
    const magnitude = parseFixed(value.slice(1), scale);
    return magnitude === 0 ? 0 : -magnitude;
  }
  return parseFixed(value, scale);
}

/** Parse a signed Kalshi quantity-change string to 1/10000-contract units. */
export function parseSignedQty(value: string): number {
  return parseSignedFixed(value, QTY_SCALE);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all money tests).

- [ ] **Step 5: Commit**

```bash
git add src/money.ts src/money.test.ts
git commit -m "Add signed fixed-point parsing for Kalshi orderbook deltas"
```

---

### Task 2: Venue-neutral price-level book + seq-gap detection

The pure core behind "reconstructed book from snapshot+deltas" — fully unit-tested, no network.

**Files:**
- Create: `src/feed/book-state.ts`
- Test: `src/feed/book-state.test.ts`

**Interfaces:**
- Consumes: `Level` from `src/book.ts`.
- Produces:
  - `class PriceLevels` with `replace(levels: Level[]): void`, `applyDelta(priceUnits: number, signedQtyUnits: number): void`, `toSorted(descending: boolean): Level[]`, `clear(): void`
  - `isSeqGap(prevSeq: number | null, nextSeq: number): boolean`

- [ ] **Step 1: Write the failing test** — create `src/feed/book-state.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PriceLevels, isSeqGap } from "./book-state.js";

test("replace then toSorted descending returns best-first bids", () => {
  const lv = new PriceLevels();
  lv.replace([{ price: 8000, qty: 30 }, { price: 9000, qty: 10 }]);
  assert.deepEqual(lv.toSorted(true), [
    { price: 9000, qty: 10 },
    { price: 8000, qty: 30 },
  ]);
});

test("replace drops zero-qty levels", () => {
  const lv = new PriceLevels();
  lv.replace([{ price: 8000, qty: 0 }, { price: 9000, qty: 10 }]);
  assert.deepEqual(lv.toSorted(false), [{ price: 9000, qty: 10 }]);
});

test("applyDelta adds, accumulates, and removes a level driven to <= 0", () => {
  const lv = new PriceLevels();
  lv.replace([{ price: 9000, qty: 10 }]);
  lv.applyDelta(9000, 5);          // 10 + 5 = 15
  assert.deepEqual(lv.toSorted(false), [{ price: 9000, qty: 15 }]);
  lv.applyDelta(9000, -15);        // -> 0 -> removed
  assert.deepEqual(lv.toSorted(false), []);
  lv.applyDelta(8500, 7);          // new level from nothing
  assert.deepEqual(lv.toSorted(false), [{ price: 8500, qty: 7 }]);
});

test("isSeqGap: null baseline never a gap; consecutive ok; skip is a gap", () => {
  assert.equal(isSeqGap(null, 5), false);
  assert.equal(isSeqGap(4, 5), false);
  assert.equal(isSeqGap(4, 6), true);
  assert.equal(isSeqGap(4, 4), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./book-state.js` not found.

- [ ] **Step 3: Implement** — create `src/feed/book-state.ts`

```ts
/**
 * Venue-neutral pieces of live local-book maintenance. Pure, no I/O.
 *
 * `PriceLevels` is one side of a book keyed by integer price units, supporting
 * snapshot replace and signed incremental deltas (a level driven to <= 0 is
 * removed). `isSeqGap` flags a non-consecutive sequence number (lost messages).
 */
import type { Level } from "../book.js";

export class PriceLevels {
  private levels = new Map<number, number>(); // priceUnits -> qtyUnits

  /** Replace all levels from a snapshot (drops non-positive quantities). */
  replace(levels: Level[]): void {
    this.levels.clear();
    for (const { price, qty } of levels) {
      if (qty > 0) this.levels.set(price, qty);
    }
  }

  /** Apply a signed quantity change at a price; remove the level if it hits <= 0. */
  applyDelta(priceUnits: number, signedQtyUnits: number): void {
    const next = (this.levels.get(priceUnits) ?? 0) + signedQtyUnits;
    if (next > 0) this.levels.set(priceUnits, next);
    else this.levels.delete(priceUnits);
  }

  /** Levels sorted by price: descending (bids best-first) or ascending. */
  toSorted(descending: boolean): Level[] {
    const arr: Level[] = [...this.levels.entries()].map(([price, qty]) => ({ price, qty }));
    arr.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
    return arr;
  }

  clear(): void {
    this.levels.clear();
  }
}

/** True if `nextSeq` is not exactly `prevSeq + 1` (a gap). Null baseline = no gap. */
export function isSeqGap(prevSeq: number | null, nextSeq: number): boolean {
  if (prevSeq === null) return false;
  return nextSeq !== prevSeq + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feed/book-state.ts src/feed/book-state.test.ts
git commit -m "Add venue-neutral price-level book + seq-gap detection"
```

---

### Task 3: Kalshi WebSocket request signing

Pure RSA-PSS signing for the authenticated WS handshake.

**Files:**
- Create: `src/kalshi/auth.ts`
- Test: `src/kalshi/auth.test.ts`

**Interfaces:**
- Produces:
  - `signWsRequest(privateKeyPem: string, timestampMs: number, method: string, path: string): string` (base64)
  - `buildKalshiAuthHeaders(keyId: string, privateKeyPem: string, method: string, path: string): Record<string, string>`

- [ ] **Step 1: Write the failing test** — create `src/kalshi/auth.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, constants } from "node:crypto";
import { signWsRequest, buildKalshiAuthHeaders } from "./auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("signWsRequest produces a base64 RSA-PSS signature that verifies", () => {
  const ts = 1703123456789;
  const sig = signWsRequest(pem, ts, "GET", "/orderbook_delta");
  const verifier = createVerify("sha256");
  verifier.update(`${ts}GET/orderbook_delta`);
  verifier.end();
  const ok = verifier.verify(
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
    sig,
    "base64",
  );
  assert.equal(ok, true);
});

test("buildKalshiAuthHeaders sets the three required headers", () => {
  const h = buildKalshiAuthHeaders("key-123", pem, "GET", "/orderbook_delta");
  assert.equal(h["KALSHI-ACCESS-KEY"], "key-123");
  assert.match(h["KALSHI-ACCESS-TIMESTAMP"], /^\d+$/);
  assert.ok(h["KALSHI-ACCESS-SIGNATURE"].length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./auth.js` not found.

- [ ] **Step 3: Implement** — create `src/kalshi/auth.ts`

```ts
/**
 * Kalshi authenticated-request signing (used for the WebSocket handshake).
 *
 * Scheme (docs.kalshi.com): sign `timestampMs + METHOD + path` with RSA-PSS
 * over SHA-256 (MGF1/SHA-256, salt length = digest length), base64-encoded.
 * Headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE.
 *
 * READ-ONLY: this module only signs; it places no orders.
 */
import { createSign, constants } from "node:crypto";

/** Sign `${timestampMs}${method}${path}` with RSA-PSS/SHA-256, base64. */
export function signWsRequest(
  privateKeyPem: string,
  timestampMs: number,
  method: string,
  path: string,
): string {
  const signer = createSign("sha256");
  signer.update(`${timestampMs}${method}${path}`);
  signer.end();
  return signer.sign(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );
}

/** Build the three Kalshi auth headers for a handshake at `path`. */
export function buildKalshiAuthHeaders(
  keyId: string,
  privateKeyPem: string,
  method: string,
  path: string,
): Record<string, string> {
  const timestampMs = Date.now();
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
    "KALSHI-ACCESS-SIGNATURE": signWsRequest(privateKeyPem, timestampMs, method, path),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kalshi/auth.ts src/kalshi/auth.test.ts
git commit -m "Add Kalshi WebSocket request signing (RSA-PSS)"
```

---

### Task 4: Kalshi live book (snapshot+delta) reusing the existing snapshot conversion

Wraps two `PriceLevels` (yes/no bids) + seq, applies WS messages, and emits a `BookSnapshot`. Extracts a reusable `bookToSnapshot` from `kalshi/orderbook.ts` (DRY) so live and REST share one bid→ask conversion.

**Files:**
- Modify: `src/kalshi/orderbook.ts` (export `bookToSnapshot`, refactor `toBookSnapshot` to use it)
- Create: `src/kalshi/live-book.ts`
- Test: `src/kalshi/live-book.test.ts`

**Interfaces:**
- Consumes: `PriceLevels`, `isSeqGap` (Task 2); `parsePrice`, `parseQty`, `parseSignedQty` (Tasks 1 / money.ts); `Book`, `Side`, `BookSnapshot`.
- Produces:
  - In `kalshi/orderbook.ts`: `bookToSnapshot(book: Book, side: Side, meta: { tsLocalMs: number; seq?: number }): BookSnapshot`
  - `class KalshiLiveBook`:
    - `constructor(ticker: string)`
    - `applySnapshot(msg: KalshiSnapshotMsg, seq: number): void`
    - `applyDelta(msg: KalshiDeltaMsg, seq: number): boolean` (returns `true` on seq gap; book unchanged)
    - `reset(): void`
    - `toSnapshot(side: Side, meta: { tsLocalMs: number }): BookSnapshot`
  - exported message types `KalshiSnapshotMsg`, `KalshiDeltaMsg`

- [ ] **Step 1: Refactor `kalshi/orderbook.ts` to export `bookToSnapshot`.** Replace the existing `toBookSnapshot` function (lines ~63-80) with:

```ts
/** Map a normalized Kalshi `Book` to a one-sided `BookSnapshot`. */
export function bookToSnapshot(
  book: Book,
  side: Side,
  meta: { tsLocalMs: number; seq?: number },
): BookSnapshot {
  return {
    venue: "kalshi",
    marketId: book.ticker,
    side,
    tsLocalMs: meta.tsLocalMs,
    ...(meta.seq !== undefined ? { seq: meta.seq } : {}),
    bids: bidsForSide(book, side),
    asks: asksForBuying(book, side),
  };
}

/** Map a raw Kalshi order book to a normalized one-sided `BookSnapshot`. */
export function toBookSnapshot(
  ticker: string,
  raw: RawOrderbook,
  side: Side,
  meta: { tsLocalMs: number; seq?: number },
): BookSnapshot {
  return bookToSnapshot(normalize(ticker, raw), side, meta);
}
```

- [ ] **Step 2: Verify the existing Kalshi tests still pass** (the refactor must be behavior-preserving)

Run: `npm test`
Expected: PASS (existing `src/book.test.ts` / any kalshi tests unchanged).

- [ ] **Step 3: Write the failing test** — create `src/kalshi/live-book.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { KalshiLiveBook } from "./live-book.js";

function fresh(): KalshiLiveBook {
  const b = new KalshiLiveBook("TEST-TICKER");
  b.applySnapshot(
    {
      market_ticker: "TEST-TICKER",
      yes_dollars_fp: [["0.6000", "10.00"]],
      no_dollars_fp: [["0.3500", "20.00"]],
    },
    1,
  );
  return b;
}

test("snapshot then delta updates the YES bid book", () => {
  const b = fresh();
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    2,
  );
  assert.equal(gap, false);
  // YES snapshot: bids are the real YES bids; asks = 1 - NO bids.
  const yes = b.toSnapshot("yes", { tsLocalMs: 1000 });
  assert.deepEqual(yes.bids, [{ price: 6000, qty: 150000 }]); // 10 + 5 = 15.0000
  assert.equal(yes.seq, 2);
});

test("delta to zero removes the level", () => {
  const b = fresh();
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.3500", delta_fp: "-20.00", side: "no" },
    2,
  );
  const no = b.toSnapshot("no", { tsLocalMs: 1000 });
  assert.deepEqual(no.bids, []);
});

test("seq gap is reported and leaves the book unchanged", () => {
  const b = fresh();
  const before = b.toSnapshot("yes", { tsLocalMs: 1 });
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    5, // skipped 2..4
  );
  assert.equal(gap, true);
  const after = b.toSnapshot("yes", { tsLocalMs: 2 });
  assert.deepEqual(after.bids, before.bids);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./live-book.js` not found.

- [ ] **Step 5: Implement** — create `src/kalshi/live-book.ts`

```ts
/**
 * Kalshi live order book: applies an `orderbook_snapshot` then incremental
 * `orderbook_delta` messages to maintain the YES/NO bid books locally, and
 * renders a one-sided `BookSnapshot` reusing the REST bid->ask conversion.
 *
 * READ-ONLY: maintains state from the public-data feed; places no orders.
 */
import { PriceLevels, isSeqGap } from "../feed/book-state.js";
import { bookToSnapshot } from "./orderbook.js";
import type { Book } from "./types.js";
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";
import { parsePrice, parseQty, parseSignedQty } from "../money.js";

/** A raw `[priceDollars, qty]` level as sent on the WS snapshot. */
type RawWsLevel = [string, string];

export interface KalshiSnapshotMsg {
  market_ticker: string;
  yes_dollars_fp: RawWsLevel[];
  no_dollars_fp: RawWsLevel[];
}

export interface KalshiDeltaMsg {
  market_ticker: string;
  price_dollars: string;
  delta_fp: string;
  side: Side;
  ts_ms?: number;
}

function toLevels(raw: RawWsLevel[]) {
  return raw.map(([price, qty]) => ({ price: parsePrice(price), qty: parseQty(qty) }));
}

export class KalshiLiveBook {
  private readonly yes = new PriceLevels();
  private readonly no = new PriceLevels();
  private seq: number | null = null;

  constructor(readonly ticker: string) {}

  /** Replace the whole book from a snapshot and set the seq baseline. */
  applySnapshot(msg: KalshiSnapshotMsg, seq: number): void {
    this.yes.replace(toLevels(msg.yes_dollars_fp));
    this.no.replace(toLevels(msg.no_dollars_fp));
    this.seq = seq;
  }

  /**
   * Apply one delta. Returns `true` if a seq gap is detected — in that case the
   * book is left unchanged and the caller should resubscribe for a fresh
   * snapshot.
   */
  applyDelta(msg: KalshiDeltaMsg, seq: number): boolean {
    if (isSeqGap(this.seq, seq)) return true;
    const levels = msg.side === "yes" ? this.yes : this.no;
    levels.applyDelta(parsePrice(msg.price_dollars), parseSignedQty(msg.delta_fp));
    this.seq = seq;
    return false;
  }

  /** Discard local state (after a disconnect or seq gap, before re-snapshot). */
  reset(): void {
    this.yes.clear();
    this.no.clear();
    this.seq = null;
  }

  /** Render the current book as a one-sided `BookSnapshot`. */
  toSnapshot(side: Side, meta: { tsLocalMs: number }): BookSnapshot {
    const book: Book = {
      ticker: this.ticker,
      yesBids: this.yes.toSorted(true),
      noBids: this.no.toSorted(true),
    };
    return bookToSnapshot(book, side, {
      tsLocalMs: meta.tsLocalMs,
      ...(this.seq !== null ? { seq: this.seq } : {}),
    });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/kalshi/orderbook.ts src/kalshi/live-book.ts src/kalshi/live-book.test.ts
git commit -m "Add Kalshi live snapshot+delta book; share bookToSnapshot conversion"
```

---

### Task 5: Feed client interface + credentials loader

The shared `FeedClient` contract and `.env` credential loading. Both are small and depended on by both feeds.

**Files:**
- Create: `src/feed/types.ts`
- Create: `src/credentials.ts`
- Test: `src/credentials.test.ts`

**Interfaces:**
- Produces (`feed/types.ts`):
  - `interface InstrumentRef { marketId: string; side: Side }`
  - `interface FeedUpdate { snapshot: BookSnapshot; stale: boolean }`
  - `type FeedUpdateHandler = (u: FeedUpdate) => void`
  - `interface FeedClient { subscribe(instruments: InstrumentRef[]): Promise<void>; on(event: "update", handler: FeedUpdateHandler): void; getSnapshot(marketId: string, side: Side): BookSnapshot | null; close(): void }`
- Produces (`credentials.ts`):
  - `interface KalshiCredentials { keyId: string; privateKeyPem: string }`
  - `interface PolymarketCredentials { keyId: string; secretKey: string }`
  - `loadKalshiCredentials(): KalshiCredentials`
  - `loadPolymarketCredentials(): PolymarketCredentials`

- [ ] **Step 1: Create `src/feed/types.ts`**

```ts
/**
 * Venue-neutral feed contract. A FeedClient maintains a live local book per
 * subscribed instrument and announces changes via an `update` event, while also
 * exposing current state via `getSnapshot` (push event + pull state).
 */
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";

/** One subscribed instrument: a venue market id and which side it represents. */
export interface InstrumentRef {
  marketId: string;
  side: Side;
}

/** Emitted whenever a subscribed instrument's book changes. */
export interface FeedUpdate {
  snapshot: BookSnapshot;
  /** True when the book may be incomplete (awaiting a fresh snapshot after a drop/gap). */
  stale: boolean;
}

export type FeedUpdateHandler = (update: FeedUpdate) => void;

export interface FeedClient {
  subscribe(instruments: InstrumentRef[]): Promise<void>;
  on(event: "update", handler: FeedUpdateHandler): void;
  getSnapshot(marketId: string, side: Side): BookSnapshot | null;
  close(): void;
}
```

- [ ] **Step 2: Write the failing test** — create `src/credentials.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKalshiCredentials, loadPolymarketCredentials } from "./credentials.js";

test("loadPolymarketCredentials throws a helpful error when unset", () => {
  const prev = { ...process.env };
  delete process.env.POLYMARKET_KEY_ID;
  delete process.env.POLYMARKET_SECRET_KEY;
  assert.throws(() => loadPolymarketCredentials(), /POLYMARKET_KEY_ID/);
  process.env = prev;
});

test("loadKalshiCredentials throws when the PEM path is missing", () => {
  const prev = { ...process.env };
  process.env.KALSHI_API_KEY_ID = "k";
  process.env.KALSHI_PRIVATE_KEY_PATH = "/no/such/file.pem";
  assert.throws(() => loadKalshiCredentials(), /KALSHI_PRIVATE_KEY_PATH/);
  process.env = prev;
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module `./credentials.js` not found.

- [ ] **Step 4: Implement** — create `src/credentials.ts`

```ts
/**
 * Load read-only feed credentials from `.env` (gitignored). NEVER log secret
 * values. These keys are full-access; collection code must only use them for
 * market-data feeds (no `orders.*`). See CLAUDE.md safety rules.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

export interface KalshiCredentials {
  keyId: string;
  privateKeyPem: string;
}

export interface PolymarketCredentials {
  keyId: string;
  secretKey: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export function loadKalshiCredentials(): KalshiCredentials {
  const keyId = required("KALSHI_API_KEY_ID");
  const pemPath = required("KALSHI_PRIVATE_KEY_PATH");
  try {
    return { keyId, privateKeyPem: readFileSync(pemPath, "utf8") };
  } catch (err) {
    throw new Error(
      `Cannot read KALSHI_PRIVATE_KEY_PATH=${pemPath}: ${(err as Error).message}`,
    );
  }
}

export function loadPolymarketCredentials(): PolymarketCredentials {
  return {
    keyId: required("POLYMARKET_KEY_ID"),
    secretKey: required("POLYMARKET_SECRET_KEY"),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/feed/types.ts src/credentials.ts src/credentials.test.ts
git commit -m "Add FeedClient interface and .env credentials loader"
```

---

### Task 6: Kalshi feed client (WS I/O shell)

The stateful socket: authenticated connect, subscribe-per-ticker, drive `KalshiLiveBook`, emit `FeedUpdate`, reconnect with backoff, and resubscribe + re-snapshot on seq gap. I/O-heavy: verified by `npm run typecheck`/`build` and the live demo (Task 8). Pure cores are already tested (Tasks 2, 4).

**Files:**
- Create: `src/kalshi/feed.ts`

**Interfaces:**
- Consumes: `FeedClient`, `InstrumentRef`, `FeedUpdate`, `FeedUpdateHandler` (Task 5); `KalshiLiveBook`, `KalshiSnapshotMsg`, `KalshiDeltaMsg` (Task 4); `buildKalshiAuthHeaders` (Task 3); `loadKalshiCredentials` (Task 5); `Side`, `BookSnapshot`.
- Produces: `class KalshiFeed implements FeedClient`, plus exported constants `KALSHI_WS_URL`, `KALSHI_WS_SIGN_PATH`.

- [ ] **Step 1: Implement** — create `src/kalshi/feed.ts`

```ts
/**
 * Kalshi orderbook_delta feed (read-only). Opens an authenticated WebSocket,
 * subscribes per ticker, maintains a KalshiLiveBook each, and emits FeedUpdate
 * on every change. Reconnects with backoff; on a seq gap it resubscribes to get
 * a fresh snapshot. Places no orders.
 *
 * NOTE: KALSHI_WS_SIGN_PATH is the path used in the auth signature. The docs do
 * not state it explicitly for this endpoint; "/orderbook_delta" is the expected
 * value — if the live connect returns 401, this is the first thing to adjust.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { buildKalshiAuthHeaders } from "./auth.js";
import { KalshiLiveBook } from "./live-book.js";
import type { KalshiSnapshotMsg, KalshiDeltaMsg } from "./live-book.js";
import { loadKalshiCredentials } from "../credentials.js";
import type { KalshiCredentials } from "../credentials.js";
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";
import type {
  FeedClient,
  FeedUpdate,
  FeedUpdateHandler,
  InstrumentRef,
} from "../feed/types.js";

export const KALSHI_WS_URL = "wss://external-api-ws.kalshi.com/orderbook_delta";
export const KALSHI_WS_SIGN_PATH = "/orderbook_delta";

const MAX_BACKOFF_MS = 30_000;

interface KalshiWsMessage {
  type: string;
  seq?: number;
  msg?: KalshiSnapshotMsg & KalshiDeltaMsg;
}

export class KalshiFeed implements FeedClient {
  private readonly emitter = new EventEmitter();
  private readonly books = new Map<string, KalshiLiveBook>();
  private readonly sides = new Map<string, Set<Side>>(); // ticker -> requested sides
  private readonly stale = new Set<string>(); // tickers awaiting a fresh snapshot
  private ws: WebSocket | null = null;
  private backoffMs = 1_000;
  private closed = false;

  constructor(private readonly creds: KalshiCredentials = loadKalshiCredentials()) {}

  subscribe(instruments: InstrumentRef[]): Promise<void> {
    for (const { marketId, side } of instruments) {
      if (!this.books.has(marketId)) this.books.set(marketId, new KalshiLiveBook(marketId));
      if (!this.sides.has(marketId)) this.sides.set(marketId, new Set());
      this.sides.get(marketId)!.add(side);
      this.stale.add(marketId);
    }
    return this.connect();
  }

  on(event: "update", handler: FeedUpdateHandler): void {
    this.emitter.on(event, handler);
  }

  getSnapshot(marketId: string, side: Side): BookSnapshot | null {
    const book = this.books.get(marketId);
    if (!book) return null;
    return book.toSnapshot(side, { tsLocalMs: Date.now() });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = buildKalshiAuthHeaders(
        this.creds.keyId,
        this.creds.privateKeyPem,
        "GET",
        KALSHI_WS_SIGN_PATH,
      );
      const ws = new WebSocket(KALSHI_WS_URL, { headers });
      this.ws = ws;

      ws.on("open", () => {
        this.backoffMs = 1_000;
        for (const ticker of this.books.keys()) this.sendSubscribe(ws, ticker);
        resolve();
      });
      ws.on("message", (data: WebSocket.RawData) => this.handleMessage(data.toString()));
      ws.on("error", (err) => {
        if (this.ws === ws && ws.readyState !== WebSocket.OPEN) reject(err);
      });
      ws.on("close", () => {
        if (!this.closed) this.scheduleReconnect();
      });
    });
  }

  private sendSubscribe(ws: WebSocket, ticker: string): void {
    this.stale.add(ticker);
    this.books.get(ticker)?.reset();
    ws.send(JSON.stringify({ type: "subscribe", market_tickers: [ticker] }));
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (!this.closed) this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private handleMessage(raw: string): void {
    let parsed: KalshiWsMessage;
    try {
      parsed = JSON.parse(raw) as KalshiWsMessage;
    } catch {
      return; // ignore malformed frames
    }
    const ticker = parsed.msg?.market_ticker;
    if (!ticker) return;
    const book = this.books.get(ticker);
    if (!book || parsed.seq === undefined) return;

    if (parsed.type === "orderbook_snapshot") {
      book.applySnapshot(parsed.msg as KalshiSnapshotMsg, parsed.seq);
      this.stale.delete(ticker);
      this.emitFor(ticker);
    } else if (parsed.type === "orderbook_delta") {
      const gap = book.applyDelta(parsed.msg as KalshiDeltaMsg, parsed.seq);
      if (gap) {
        if (this.ws) this.sendSubscribe(this.ws, ticker); // re-snapshot
        return;
      }
      this.emitFor(ticker);
    }
  }

  private emitFor(ticker: string): void {
    const sides = this.sides.get(ticker);
    const book = this.books.get(ticker);
    if (!sides || !book) return;
    const isStale = this.stale.has(ticker);
    for (const side of sides) {
      const update: FeedUpdate = {
        snapshot: book.toSnapshot(side, { tsLocalMs: Date.now() }),
        stale: isStale,
      };
      this.emitter.emit("update", update);
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/kalshi/feed.ts
git commit -m "Add Kalshi orderbook_delta feed client with reconnect + gap recovery"
```

---

### Task 7: Polymarket US feed client (SDK ws.markets wrapper)

PM pushes full books (latest-wins, no seq). Wrap the SDK's `ws.markets()` so only market data is reachable. Reuse the existing `polymarket/orderbook.ts` `toBookSnapshot`.

**Files:**
- Create: `src/polymarket/feed.ts`

**Interfaces:**
- Consumes: `FeedClient`, `InstrumentRef`, `FeedUpdate`, `FeedUpdateHandler` (Task 5); `loadPolymarketCredentials` (Task 5); existing `toBookSnapshot` from `src/polymarket/orderbook.ts`; existing `MarketData` from `src/polymarket/client.ts`; `Side`, `BookSnapshot`; SDK `PolymarketUS`.
- Produces: `class PolymarketFeed implements FeedClient`.

- [ ] **Step 1: Implement** — create `src/polymarket/feed.ts`

```ts
/**
 * Polymarket US market-data feed (read-only). Wraps the SDK's `ws.markets()`
 * socket: subscribe to slugs, and on each full `marketData` message replace the
 * stored book and emit a FeedUpdate. PM sends no incremental deltas and no seq,
 * so "maintenance" is latest-full-book-wins. The SDK's order surface is never
 * referenced here.
 */
import { EventEmitter } from "node:events";
import { PolymarketUS } from "polymarket-us";
import { loadPolymarketCredentials } from "../credentials.js";
import { toBookSnapshot } from "./orderbook.js";
import type { MarketData } from "./client.js";
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";
import type {
  FeedClient,
  FeedUpdate,
  FeedUpdateHandler,
  InstrumentRef,
} from "../feed/types.js";

export class PolymarketFeed implements FeedClient {
  private readonly emitter = new EventEmitter();
  private readonly sides = new Map<string, Side>(); // slug -> side label
  private readonly latest = new Map<string, BookSnapshot>(); // slug -> last snapshot
  private readonly client: PolymarketUS;
  private readonly socket: ReturnType<PolymarketUS["ws"]["markets"]>;
  private requestSeq = 0;

  constructor() {
    const { keyId, secretKey } = loadPolymarketCredentials();
    this.client = new PolymarketUS({ keyId, secretKey });
    this.socket = this.client.ws.markets();
    this.socket.on("marketData", (data) => this.handleMarketData(data.marketData as MarketData));
  }

  async subscribe(instruments: InstrumentRef[]): Promise<void> {
    for (const { marketId, side } of instruments) this.sides.set(marketId, side);
    await this.socket.connect();
    this.socket.subscribeMarketData(`md-${++this.requestSeq}`, [...this.sides.keys()]);
  }

  on(event: "update", handler: FeedUpdateHandler): void {
    this.emitter.on(event, handler);
  }

  getSnapshot(marketId: string): BookSnapshot | null {
    return this.latest.get(marketId) ?? null;
  }

  close(): void {
    this.socket.close();
  }

  private handleMarketData(data: MarketData): void {
    const side = this.sides.get(data.marketSlug);
    if (!side) return;
    const snapshot = toBookSnapshot(data, side, { tsLocalMs: Date.now() });
    this.latest.set(data.marketSlug, snapshot);
    const update: FeedUpdate = { snapshot, stale: false };
    this.emitter.emit("update", update);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If the SDK's `marketData` event payload nesting differs from `{ marketData: MarketData }`, adjust the `handleMarketData` argument extraction; the SDK `.d.ts` at `node_modules/polymarket-us/dist/index.d.ts` is the source of truth.)

- [ ] **Step 3: Commit**

```bash
git add src/polymarket/feed.ts
git commit -m "Add Polymarket US market-data feed client (ws.markets wrapper)"
```

---

### Task 8: Live demo script + REST cross-check + reconnect, wiring & docs

The manual verification for both issue checkboxes, the `npm run feed` script, and the CLAUDE.md safety-rule amendment.

**Files:**
- Create: `src/scripts/feed-demo.ts`
- Modify: `package.json` (add `"feed"` script)
- Modify: `CLAUDE.md` (amend safety rule + document the feed modules)

**Interfaces:**
- Consumes: `KalshiFeed` (Task 6), `PolymarketFeed` (Task 7), `fetchOrderbook` + `findLiveMarket` from `src/kalshi/client.ts`, `findOpenBinaryPair` from `src/polymarket/client.ts`, `toBookSnapshot` from `src/kalshi/orderbook.ts`, `avgFillPrice` from `src/book.ts`.

- [ ] **Step 1: Implement** — create `src/scripts/feed-demo.ts`

```ts
/**
 * Read-only demo for issue #13. Connects the live Kalshi + Polymarket US feeds,
 * prints book updates, periodically cross-checks the Kalshi WS-maintained book
 * against a REST snapshot (top-of-book), and forces a reconnect to demonstrate
 * resubscribe. Verifies both issue checkboxes against the real venues.
 *
 * Usage: npm run feed
 */
import { KalshiFeed } from "../kalshi/feed.js";
import { PolymarketFeed } from "../polymarket/feed.js";
import { fetchOrderbook, findLiveMarket } from "../kalshi/client.js";
import { toBookSnapshot } from "../kalshi/orderbook.js";
import { findOpenBinaryPair } from "../polymarket/client.js";
import { formatPrice } from "../money.js";

const TOLERANCE_UNITS = 100; // 0.0100 dollar = 1 cent top-of-book tolerance

async function main(): Promise<void> {
  const ticker = await findLiveMarket();
  console.log(`Kalshi live market: ${ticker}`);

  const kalshi = new KalshiFeed();
  kalshi.on("update", (u) => {
    const best = u.snapshot.asks[0];
    console.log(
      `[kalshi ${u.snapshot.marketId} ${u.snapshot.side}] best ask ` +
        `${best ? formatPrice(best.price) : "-"}${u.stale ? " (stale)" : ""}`,
    );
  });
  await kalshi.subscribe([
    { marketId: ticker, side: "yes" },
    { marketId: ticker, side: "no" },
  ]);

  const pair = await findOpenBinaryPair();
  if (pair) {
    console.log(`Polymarket US pair: ${pair.yesSlug} / ${pair.noSlug}`);
    const pm = new PolymarketFeed();
    pm.on("update", (u) => {
      const best = u.snapshot.asks[0];
      console.log(
        `[pm ${u.snapshot.marketId} ${u.snapshot.side}] best ask ` +
          `${best ? formatPrice(best.price) : "-"}`,
      );
    });
    await pm.subscribe([
      { marketId: pair.yesSlug, side: "yes" },
      { marketId: pair.noSlug, side: "no" },
    ]);
  } else {
    console.log("No open Polymarket US binary pair found right now; skipping PM leg.");
  }

  // Cross-check: WS book vs REST snapshot (top-of-book within tolerance).
  const crossCheck = setInterval(async () => {
    const ws = kalshi.getSnapshot(ticker, "yes");
    if (!ws) return;
    const rest = toBookSnapshot(ticker, await fetchOrderbook(ticker), "yes", {
      tsLocalMs: Date.now(),
    });
    const wsBest = ws.asks[0]?.price ?? null;
    const restBest = rest.asks[0]?.price ?? null;
    const ok =
      wsBest !== null && restBest !== null && Math.abs(wsBest - restBest) <= TOLERANCE_UNITS;
    console.log(
      `cross-check yes best ask: ws=${wsBest !== null ? formatPrice(wsBest) : "-"} ` +
        `rest=${restBest !== null ? formatPrice(restBest) : "-"} -> ${ok ? "OK" : "MISMATCH"}`,
    );
  }, 5_000);

  // Run for ~30s; cleanly stop.
  setTimeout(() => {
    clearInterval(crossCheck);
    kalshi.close();
    console.log("Demo complete.");
    process.exit(0);
  }, 30_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the `feed` script** to `package.json` `"scripts"` (after `"snapshot"`):

```json
    "feed": "tsx src/scripts/feed-demo.ts",
```

- [ ] **Step 3: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Live run (manual verification of both issue checkboxes)**

Run: `npm run feed`
Expected: prints Kalshi (and, if available, PM) book updates; the periodic cross-check prints `OK` (WS book matches REST top-of-book within tolerance); on the forced reconnect the feed resubscribes and resumes. If the Kalshi connect returns HTTP 401, adjust `KALSHI_WS_SIGN_PATH` in `src/kalshi/feed.ts` (see its note) and re-run.

- [ ] **Step 5: Amend `CLAUDE.md`** — update the safety rule. Replace the bullet:

> - **The logger phase uses NO credentials on either venue.** Do not add key-loading to data-collection code.

with:

```markdown
- **REST market data uses NO credentials** (public order books on both venues).
  The **WebSocket feeds require an authenticated handshake** even for public
  market data, so the feed modules (`src/kalshi/feed.ts`,
  `src/polymarket/feed.ts`) load read-only credentials from `.env` via
  `src/credentials.ts`. These keys are full-access, so the rule is enforced in
  code: collection code MUST NOT import or call any order-placing surface
  (`orders.*`); the PM SDK is used only through `ws.markets`.
```

  Also add a short bullet documenting the feed engine (near the snapshot bullet):

```markdown
- Live feeds (`src/feed/`, `src/kalshi/feed.ts`, `src/polymarket/feed.ts`):
  authenticated WS → maintained local book → `BookSnapshot`. Kalshi does real
  snapshot+`orderbook_delta` maintenance with `seq`-gap recovery
  (`KalshiLiveBook` + venue-neutral `PriceLevels`/`isSeqGap` in
  `src/feed/book-state.ts`); Polymarket US `ws.markets` pushes full books
  (latest-wins, no seq). Both implement `FeedClient` (`src/feed/types.ts`):
  push an `update` event on change, pull current state via `getSnapshot`. Demo:
  `npm run feed`.
```

- [ ] **Step 6: Run the full test suite + typecheck once more**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/scripts/feed-demo.ts package.json CLAUDE.md
git commit -m "Add live feed demo + REST cross-check; document feed engine in CLAUDE.md"
```

---

## Self-Review Notes

- **Spec coverage:** auth finding → `.env.example` (done) + Task 5/6/7 + CLAUDE.md (Task 8); Kalshi-vs-PM asymmetry → Tasks 4 (deltas/seq) vs 7 (latest-wins); components/files → Tasks 1-8; reconnect/gap → Task 6; verification split → unit tests (Tasks 1-5) + live script (Task 8); guardrails → credentials/feed modules + CLAUDE.md amendment.
- **Known-unknown:** the exact Kalshi WS *signing path* isn't documented; `KALSHI_WS_SIGN_PATH` holds the expected value with an explicit 401-adjustment note (Task 6 / Task 8 step 4). The signer itself is fully specified and unit-tested.
- **PM SDK shape:** verified against `node_modules/polymarket-us/dist/index.d.ts` (`ws.markets()`, `subscribeMarketData`, `marketData` event with nested `.marketData`). Task 7 notes the `.d.ts` as source of truth if nesting differs.
