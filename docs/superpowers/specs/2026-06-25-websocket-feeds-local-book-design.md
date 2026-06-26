# WebSocket feeds with local order-book maintenance

Design for GitHub issue #13 (`phase:logger`). Connect the authenticated
market-data WebSockets on both venues, maintain a live local order book per
instrument, and emit normalized `BookSnapshot`s. Scope is a **generic, reusable
feed + book engine plus a demo script** — registry-wiring, edge, and storage
stay in later issues (#14/#15).

## Finding that reshaped the issue (approved)

The issue's premise assumed the public market-data WebSockets need no auth, like
the REST order books. The official docs say otherwise:

| Venue         | REST order book      | WebSocket feed                                                              |
| ------------- | -------------------- | -------------------------------------------------------------------------- |
| Kalshi        | public, no auth      | `wss://external-api-ws.kalshi.com/orderbook_delta` — connection requires auth |
| Polymarket US | public, no auth      | `wss://api.polymarket.us/v1/ws/markets` — handshake requires API key headers   |

WebSockets are still worth it (over fast REST polling) for **measurement
quality**: tighter inter-leg simultaneity reduces noise on the one thing this
phase measures — whether a spread was *jointly* fillable at the same instant. A
non-colocated retail logger can't fill sub-second windows regardless, so WS is
about a cleaner dataset, not catching faster opportunities.

**Decision:** use authenticated WS with the user's (full-access) keys, read-only.
This amends the project's "NO credentials on either venue" invariant to
"read-only feed credentials are allowed; `orders.*` is still forbidden in
collection code" (see Guardrails).

## The key asymmetry (drives the design)

The two venues' "snapshot + deltas" stories differ, per the docs:

- **Kalshi** sends an `orderbook_snapshot` first, then incremental
  `orderbook_delta` messages — a signed `delta_fp` quantity change at a
  `price_dollars` on a `side` (`yes`/`no`) — each carrying a monotonic `seq`.
  This is real local-book maintenance: apply deltas, detect `seq` gaps.
- **Polymarket US** `ws.markets` pushes a **full `marketData` book on every
  update** (same shape as REST `markets.book`), with **no `seq` and no
  incremental deltas**. "Maintaining" the book is just *latest-full-book-wins*.

So the interesting reducer logic lives on the Kalshi side; PM is a thin
latest-wins holder. Both expose the same outward interface.

Snapshot/delta message shapes (Kalshi, from official docs):

```jsonc
// orderbook_snapshot
{ "type": "orderbook_snapshot", "sid": 2, "seq": 2,
  "msg": { "market_ticker": "...", "yes_dollars_fp": [["0.0800","300.00"]],
           "no_dollars_fp": [["0.5400","20.00"]] } }
// orderbook_delta
{ "type": "orderbook_delta", "sid": 2, "seq": 3,
  "msg": { "market_ticker": "...", "price_dollars": "0.960",
           "delta_fp": "-54.00", "side": "yes", "ts_ms": 1669149841000 } }
```

## Components & files

- `src/feed/types.ts` — venue-neutral `FeedClient` interface:
  `subscribe(instruments)`, `on("update", cb)`, `getSnapshot(marketId, side)`,
  `close()`. `FeedUpdate` payload = `{ snapshot: BookSnapshot, stale: boolean }`.
  Consumption model is **push event + pull state** (approved): the engine
  announces *when* a leg moves and exposes current state; downstream decides when
  to snapshot/compute across both legs.

- `src/feed/book-state.ts` — the **Kalshi local-book reducer** (pure,
  venue-neutral core, no I/O). A mutable book held as `price → qtyUnits` maps for
  bids and asks, with:
  - `applySnapshot(levels, seq)` — replace book, set baseline `seq`.
  - `applyDelta(side, priceUnits, signedDeltaUnits, seq)` — add signed delta at a
    price; a level driven to `≤ 0` is removed.
  - `seq`-gap detection — non-consecutive `seq` signals lost messages.
  - `toBookSnapshot(meta)` — sorted best-first, integer-exact, reusing the
    existing `BookSnapshot` model and ordering invariants.

- `src/money.ts` — add `parseSignedFixed` / `parseSignedQty`. The existing
  `parseFixed` rejects a leading `-`, but Kalshi's `delta_fp` is signed
  (e.g. `"-54.00"`); the signed helper strips the sign and reuses `parseFixed`.

- `src/kalshi/feed.ts` — raw `ws` connection to the `orderbook_delta` endpoint
  with an authenticated handshake (RSA signing; exact header/signature scheme
  pulled from the official docs at implementation time). Sends
  `{ "type": "subscribe", "market_tickers": [...] }`, parses
  `orderbook_snapshot`/`orderbook_delta`, drives `book-state`, and emits a
  per-side `BookSnapshot` on each change.

- `src/polymarket/feed.ts` — wraps the SDK's `ws.markets`: subscribe to slugs,
  replace the stored book on each `marketData` message, emit a `BookSnapshot`.
  The SDK's order surface is **never imported here** — only `ws.markets` is
  reachable from this module.

- `src/credentials.ts` — loads keys from `.env` (gitignored). Single place; feed
  modules import only what they need. Fields per `.env.example`:
  `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, `POLYMARKET_KEY_ID`,
  `POLYMARKET_SECRET_KEY`.

- `src/scripts/feed-demo.ts` — `npm run feed`: connect a live market on each
  venue, print updates, run the live REST cross-check, and force a reconnect to
  demonstrate resubscribe.

## Reconnect / gap handling

- **Disconnect** → exponential backoff, reconnect, **resubscribe**; mark books
  `stale` until fresh data arrives (Kalshi: a fresh `orderbook_snapshot`; PM: the
  next full book).
- **Kalshi `seq` gap** (non-consecutive) → discard the local book, reconnect /
  resubscribe to get a clean snapshot; `stale=true` meanwhile.
- **Auth failure (401)** → fail fast with a clear error; do not retry-loop a bad
  credential.
- **Malformed message** → log and skip.

## Verification

Mirrors the existing CI-offline / live-script split (pure logic unit-tested in
CI; live behavior in `src/scripts/`).

- **Deterministic unit tests** (`src/feed/book-state.test.ts`, in CI, no
  network/creds): apply synthetic snapshot+delta sequences and assert the
  resulting book; level removal when a delta drives qty `≤ 0`; **`seq`-gap
  detection** fires on a skipped sequence; `toBookSnapshot` ordering and
  integer-exactness. This is the core correctness behind the "reconstructed book"
  verify checkbox.
- **Live cross-check script** (manual; needs creds + a live market): periodically
  `fetch` the REST order book and assert the WS-maintained book matches the
  top-N levels within tolerance; exercise reconnect/resubscribe. Covers both
  verify checkboxes against the real venues without putting flaky network in CI.

## Guardrails (full-access keys, read-only use)

- Feed modules never import or expose any order-placing path; the PM SDK is
  wrapped so only `ws.markets` is reachable from collection code.
- Amend the CLAUDE.md safety rule: the logger may use **read-only feed
  credentials**; `orders.*` remains forbidden in collection code. Real `.env`
  and `*.pem` stay gitignored.
