# Polymarket US order book via the polymarket-us SDK (public, no auth)

Design for GitHub issue #5 (`phase:connectivity`). The Polymarket US mirror of
issue #4 (Kalshi), normalized into the **same** buy-YES / buy-NO `Level[]` + `Fill`
shape so a single executable-cost engine serves both venues.

## Verified SDK facts (live probe + docs)

`docs.polymarket.us/api-reference/sdks/typescript/quickstart` confirms public
construction and `markets.book(slug)` usage but does NOT document the response
shape or YES/NO representation, so the following were established by live probe
against `polymarket-us@0.1.1` (`api.polymarket.us`):

- **Public, no creds:** `new PolymarketUS()` with no options → `keyId`/`secretKey`
  are `undefined`; `markets.book`/`markets.bbo` return live data. Credentials are
  only for orders/portfolio/account (never touched this phase).
- **Runtime≠types quirk:** the SDK *types* declare `book(slug): Promise<MarketBook>`
  (flat `{ marketSlug, bids, offers, ... }`), but the *runtime* returns
  `{ marketData: { marketSlug, bids, offers, state, transactTime, ... } }`.
  `bbo` is wrapped the same way. We must unwrap `.marketData` defensively.
- **Level shape:** `bids`/`offers` are `{ px: { value: string, currency: "USD" }, qty: string }`,
  with `px.value` and `qty` as **4-decimal strings** (e.g. `"0.7610"`,
  `"39587.0000"`). `offers` are asks (price to BUY the token); `bids` are the
  price to SELL it.
- **Money reuse:** the 4-decimal strings map directly onto `src/money.ts`
  (integer 1/10000 units). No new money code.

## YES/NO representation (the issue's central question)

Each outcome is its **own market slug** with its own book. A binary question is
two complementary sibling slugs (e.g. `…-dem` / `…-rep`). To buy an outcome you
lift that slug's `offers`.

Proven with the live U.S. House midterms event:

| | best bid | best ask (offers) | deeper offers |
| --- | --- | --- | --- |
| `…-dem` | 0.7600 | 0.7610 | 0.7610, 0.8100, 0.9860 |
| `…-rep` | 0.2390 | 0.2400 | 0.2400, 0.2990, 0.3000 |

Top-of-book is complementary (`ask(dem)+bid(rep)=1`), **but deeper levels are
not**: `1 − dem bids` = `0.24, 0.979, 0.98`, which does not match the real `rep`
offers `0.24, 0.299, 0.30`. So **buy-NO must read the real NO-slug `offers`**;
inferring NO from `(1 − YES bid)` is wrong past level 1, exactly as the issue
warns.

Consequence: a Polymarket binary is modeled as a **slug pair** `{ yesSlug, noSlug }`.
This also matches the future hand-verified pair registry (each Kalshi market maps
to a PM US yes/no slug pair).

## Architecture

### Refactor: extract venue-neutral `src/book.ts`

`Level`, `Side`, `Fill`, and `executableCost(asks, sizeQtyUnits)` move out of
`src/kalshi/` into a new `src/book.ts` (no network, pure). Justified by DRY — the
depth-walk and `Fill` are money-critical and must exist once.

- `src/kalshi/types.ts` keeps only Kalshi raw types (`RawLevel`, `RawOrderbook`,
  `Book`); imports `Level` from `../book.js`.
- `src/kalshi/orderbook.ts` keeps `normalize`, `asksForBuying` (bids→asks),
  `bestAsk`, `costToBuy`; imports `Side`/`Fill`/`Level`/`executableCost` from
  `../book.js`.
- Verified by re-running `npm run book` (no behavior change).

```
src/book.ts                    # Level, Side, Fill, executableCost  (venue-neutral)
src/money.ts                   # unchanged, shared
src/kalshi/...                 # imports from book.ts (refactored)
src/polymarket/client.ts       # new PolymarketUS() + unwrapping fetch wrappers
src/polymarket/orderbook.ts    # normalize pair → asks; bestAsk; costToBuy
src/scripts/polymarket-book.ts # read-only demo  (npm run pm-book)
```

### `src/polymarket/client.ts`

- One module-level `new PolymarketUS()` (no credentials — explicit comment
  asserting the invariant).
- `fetchBook(slug): Promise<MarketData>` and `fetchBbo(slug): Promise<BboData>`:
  call the SDK and **unwrap** `(resp as any).marketData ?? resp`. Throw a clear
  error if the unwrapped payload lacks `bids`/`offers` (book) — guarding the
  runtime quirk. Locally-declared `MarketData`/`BboData`/`RawPmLevel` types
  describe the real runtime shape (the SDK's are wrong).

### `src/polymarket/orderbook.ts`

```ts
interface PmPair { yesSlug: string; noSlug: string; }
interface PmBook { pair: PmPair; yesOffers: Level[]; noOffers: Level[]; }
```

- `levelsToAsks(offers): Level[]` — `parsePrice(px.value)`, `parseQty(qty)`,
  sorted best (lowest price) first. **No 1−X conversion** (PM US gives asks
  directly; that conversion is Kalshi-only).
- `normalize(pair, yesRaw, noRaw): PmBook`.
- `asksForBuying(book, side)`: YES → `yesOffers`, NO → `noOffers`.
- `bestAsk(book, side)` and `costToBuy(book, side, sizeQtyUnits)` delegate to the
  shared `executableCost`, yielding the identical `Fill` shape as Kalshi.

## Demo & verification — `src/scripts/polymarket-book.ts`

New npm script `pm-book`: `npm run pm-book -- <yesSlug> <noSlug> [sizeContracts]`.
With no args, defaults to a known live binary pair (midterms `…-dem`/`…-rep`).
Read-only. Prints, mapping to the issue checklist:

1. `new PolymarketUS()` (no creds) + `markets.book(...)` returns a live book.
2. Raw `marketData` for both YES and NO slugs (NO read from real data).
3. Best buy-YES / buy-NO, plus a side-by-side showing `buy-NO ask ≠ 1 − YES bid`
   beyond top of book.
4. Executable cost for increasing sizes including an oversized `unfillable` result.

No unit-test runner this phase (per CLAUDE.md); verification is the demo, as with
Kalshi.

## Error handling

| Condition | Behavior |
| --- | --- |
| SDK / network error | propagates from `client.ts` |
| Missing/empty `marketData` | `client.ts` throws a clear error |
| Empty book side | shared `executableCost` → `Fill { fillable:false, filledSize:0, avgCost:null }` |
| Size beyond depth | `Fill { fillable:false, ...partial }` (no crash) |
| Credentials | none used in any path |

## Out of scope

Orders/portfolio/account (authenticated surface), WebSocket `ws.markets`
streaming, fee/net-edge math, the pair registry, and cross-venue spread logging
(later phases). This issue is the public REST book read + normalization only.
```
