# kalshi-polymarket-us-arb

A **read-only cross-venue spread logger** between **Kalshi** and **Polymarket US**.

The goal of this phase is to measure — from free, logged market data — whether
fee-adjusted, fillable, identically-resolving arbitrage spreads actually exist
between the two venues, **before any trading code is written**. This phase
produces **zero trading code**: no order placement, no credentials.

## Two non-obvious facts

1. **The target is Polymarket US, accessed via the official `polymarket-us` SDK
   — not international Polymarket.** International Polymarket
   (`docs.polymarket.com`, the `@polymarket/*` packages, Polygon/USDC/EIP-712
   wallet auth) is geoblocked in the US and is **not** this project. We use the
   `polymarket-us` npm package (repo `Polymarket/polymarket-us-typescript`) and
   the `docs.polymarket.us` docs only.
2. **Kalshi is a CFTC-regulated exchange.** Its order book endpoint is public
   (no auth), and — a key quirk — it returns **bids only** for yes and no:
   a YES bid at X equals a NO ask at (1−X). To buy YES you lift NO bids, and
   vice versa.

## Stack

- **TypeScript / Node.js 18+**, built with `tsc`.
- `polymarket-us` (official PM US SDK) for Polymarket US market data.
- `ws` for the Kalshi `orderbook_delta` WebSocket; native `fetch` for Kalshi REST.
- `dotenv` (forward-looking; the logger phase needs no credentials).
- **Money math uses integer cents or a decimal library — never JS floats.**

## Scripts

| Command            | Purpose                          |
| ------------------ | -------------------------------- |
| `npm run build`    | Compile `src/` to `dist/` (tsc). |
| `npm run typecheck`| Type-check without emitting.     |
| `npm start`        | Run `src/index.ts` via `tsx`.    |

## Build order

Work proceeds in this order (do not skip ahead):

```
setup → connectivity (read-only) → fee & net-edge math → hand-verified pair
registry → logger → viability analysis
```

See [`CLAUDE.md`](./CLAUDE.md) for project conventions and the authoritative API
documentation (Kalshi: <https://docs.kalshi.com/api-reference>, Polymarket US:
<https://docs.polymarket.us/api-reference/introduction>). Always use those
sources for API details — third-party blogs conflict and are frequently wrong.
