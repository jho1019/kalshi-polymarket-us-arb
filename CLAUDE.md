# CLAUDE.md

Project conventions for `kalshi-polymarket-us-arb`. Read this before writing code
or looking up any API detail.

## What this project is

A **read-only cross-venue spread logger** between **Kalshi** and **Polymarket US**,
built to measure whether fee-adjusted, fillable, identically-resolving arbitrage
spreads actually exist before any trading code is written.

## Authoritative API documentation — ALWAYS use these

Whenever you need an API detail — base URL, endpoint path, parameters, auth,
fees, response schema, WebSocket channels — consult ONLY the official docs below.
Do **not** rely on third-party blogs, SEO guides, or Stack Overflow: they conflict
and are frequently out of date (e.g. three different Kalshi base URLs circulate
online). If the official docs are unclear, say so rather than guessing.

| Venue         | API reference                                            |
| ------------- | -------------------------------------------------------- |
| Kalshi        | https://docs.kalshi.com/api-reference                    |
| Polymarket US | https://docs.polymarket.us/api-reference/introduction    |

Useful Polymarket US sub-pages:
- TypeScript SDK quickstart: https://docs.polymarket.us/api-reference/sdks/typescript/quickstart
- Fees & rebates: https://docs.polymarket.us/fees
- WebSockets: https://docs.polymarket.us/api-reference/websocket/overview

## Critical: US vs International (the #1 source of errors)

- **`docs.polymarket.com` is the WRONG docs** — that's *international* Polymarket
  (Polygon / USDC / EIP-712 wallet auth), which is geoblocked in the US and is
  NOT this project. Always use **`docs.polymarket.us`**.
- Use the official **`polymarket-us`** npm package (repo
  `Polymarket/polymarket-us-typescript`). Do **NOT** use `@polymarket/client`,
  `@polymarket/clob-client`, or `@polymarket/sdk` — those are international.

## Stack & conventions

- **TypeScript / Node.js 18+.**
- Polymarket US data: `polymarket-us` SDK. For read-only market data, construct
  `new PolymarketUS()` with **no credentials** — `markets.book`, `markets.bbo`,
  `events`, `series`, `sports`, `search`, and `ws.markets` are all public.
- Kalshi data: the order book endpoint is public (no auth). Use native `fetch`
  for REST and `ws` for the `orderbook_delta` WebSocket.
- **Money math: never use JS floats** for prices, costs, or fees. This project
  represents prices as **integer 1/10000-dollar units** and quantities as
  **integer 1/10000-contract units** (see `src/money.ts`). Integer *cents* is
  too coarse — Kalshi's book returns 4-decimal (sub-cent) prices and the arb
  edges are ~1-2 cents, so the input precision must not be lossy.
- Kalshi book quirk: the orderbook (`GET {base}/markets/{ticker}/orderbook`,
  public/no-auth, see `src/kalshi/`) returns **bids only** as
  `orderbook_fp.{yes_dollars,no_dollars}`, each level `[priceDollarsString,
  qtyString]` (e.g. `["0.9900","45.00"]`) — there is **no** integer-cents
  `orderbook` variant. A YES bid at X == a NO ask at (1−X). To buy YES, lift NO
  bids; to buy NO, lift YES bids.
- Polymarket US book (see `src/polymarket/`): each **outcome is its own market
  slug** with its own book; `offers` are the asks to BUY that outcome (`bids` =
  sell it). A binary question is a **pair of complementary sibling slugs** (e.g.
  `…-dem`/`…-rep`) modeled as `{ yesSlug, noSlug }`. To buy NO, read the real
  NO-slug `offers` — do **not** infer NO from (1 − YES bid); levels diverge past
  top of book (verified live).
- Polymarket US SDK quirk: `markets.book`/`markets.bbo` return the payload
  wrapped in **`marketData`** at runtime, but the SDK's TS types declare a flat
  object (types ≠ runtime). Unwrap `.marketData` defensively. `px.value` and
  `qty` are 4-decimal strings, so `src/money.ts` parsing is shared with Kalshi.
- Shared, venue-neutral order-book math (`Level`, `Side`, `Fill`,
  `executableCost`) lives in `src/book.ts`; each venue normalizes its raw book
  into best-first ask `Level[]` and feeds the same engine.
- `BookSnapshot` (`src/snapshot.ts`) is the one normalized model both venues map
  into via `toBookSnapshot` (one snapshot per **side/instrument**;
  `bids`/`asks` are `Level[]`, best-first). Timestamps are `tsLocalMs` (ms,
  number) + optional `seq` — not nanoseconds (epoch-ns overflows JS safe ints and
  Node has no epoch-ns wall clock). `serializeSnapshot`/`deserializeSnapshot` are
  lossless (all fields JSON-native integers); `assertValidSnapshot` enforces
  enums, integer levels, and bid/ask ordering.

## Commands

- `npm run build` — compile `src/` to `dist/` with `tsc`.
- `npm run typecheck` — type-check only, no emit.
- `npm start` — run `src/index.ts` via `tsx`.
- `npm run book -- <ticker> [sizeContracts]` — read-only demo: print a live
  Kalshi book and executable buy costs. No ticker auto-picks a live market.
- `npm run pm-book -- <yesSlug> <noSlug> [sizeContracts]` — read-only demo: print
  a live Polymarket US YES/NO book pair and executable buy costs. No slugs
  auto-discovers a live binary pair.
- `npm run snapshot` — read-only demo: build a `BookSnapshot` from a live Kalshi
  and Polymarket US book and verify validation + lossless round-trip.

No test runner yet; tests arrive with the fee & net-edge math (the integer
1/10000-unit money and executable-cost logic is the first thing worth
unit-testing).

## Safety rules for this repo

- **The logger phase uses NO credentials on either venue.** Do not add key-loading
  to data-collection code.
- **No order placement / no `orders.*` calls** anywhere in the current backlog.
  Execution is a future phase with its own gated issues.
- Never commit secrets. `.env`, `*.pem`, and `data/` are gitignored. If a key is
  ever exposed, treat it as compromised and rotate it.
- Always validate that BOTH legs of a matched pair resolve identically (same
  source, timestamp, and strike) before treating a spread as arbitrage. Use
  Kalshi market rules and Polymarket US `markets.settlement` to verify.

## Build order (do not skip ahead)

setup → connectivity (read-only) → fee & net-edge math → hand-verified pair
registry → logger → viability analysis. Decide whether the edge is real from
free logged data **before** writing any code that can place a trade.