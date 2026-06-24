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
- **Money math: integer cents or a decimal library. Never use JS floats** for
  prices, costs, or fees.
- Kalshi book quirk: the orderbook returns **bids only** (yes and no). A YES bid
  at X == a NO ask at (1−X). To buy YES, lift NO bids; to buy NO, lift YES bids.
- Polymarket US: read the **NO token's actual book**; do not infer NO from
  (1 − YES bid) — thin books make that wrong.

## Commands

- `npm run build` — compile `src/` to `dist/` with `tsc`.
- `npm run typecheck` — type-check only, no emit.
- `npm start` — run `src/index.ts` via `tsx`.

No test runner yet; tests arrive with the fee & net-edge math (integer-cents
logic is the first thing worth unit-testing).

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