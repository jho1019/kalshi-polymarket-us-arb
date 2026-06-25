# Kalshi public order book fetch + bids→asks conversion

Design for GitHub issue #4 (`phase:connectivity`).

## Goal

Read Kalshi's **public** order book for a live market and turn it into the
numbers an arb logger needs: the best price to *buy* each side, and the
executable average cost to buy a requested size (walking depth). Read-only, no
credentials.

## Verified API facts (official docs + live probe)

Confirmed against `docs.kalshi.com` and a live call to
`KXBTCD-26JUN2517-T72249.99`:

- **Endpoint:** `GET {KALSHI_API_BASE}/markets/{ticker}/orderbook?depth=N`,
  where `KALSHI_API_BASE = https://external-api.kalshi.com/trade-api/v2`
  (the issue-3 constant in `src/config.ts`).
- **Response shape (only this form is returned):**
  ```json
  { "orderbook_fp": { "yes_dollars": [["0.15","100.00"]], "no_dollars": [...] } }
  ```
  There is **no** integer-cents `orderbook` variant. Each level is
  `[priceDollarsString, quantityFixedPointString]`.
- **Bids only.** `yes_dollars` = YES bids, `no_dollars` = NO bids. No asks are
  returned: a YES bid at X is equivalent to a NO ask at (1 − X).
- **Prices are 4-decimal dollar strings** (e.g. `"0.9900"`) — sub-cent /
  fractional. Quantities are fixed-point contract counts (e.g. `"45.00"`).
- **`depth`:** `0` or negative = all levels; `1–100` = that many levels.
- **Auth discrepancy:** the docs page states auth headers are required, but the
  endpoint empirically returns a full book with **no credentials**, and both
  CLAUDE.md and issue #4 state it is public. We treat it as public-read (matching
  reality and the issue's "no credentials" requirement) and rely on the demo to
  prove no-auth access.

## Money representation

Project-wide decision (see also CLAUDE.md "never use JS floats"):

- **Price:** integer **1/10000-dollar** units. `PRICE_SCALE = 10000`,
  `$1 = 10000`, `parsePrice("0.9900") = 9900`.
- **Quantity:** integer **1/10000-contract** units. `QTY_SCALE = 10000`,
  `parseQty("45.00") = 450000`.
- Integer *cents* was rejected: it would discard the sub-cent precision the
  fractional API returns, which is exactly the dimension the project measures.
- A decimal library was rejected for now (YAGNI; revisit if fee/rebate math
  needs it).

Parsing is string-only (no float intermediate). `parseFixed(str, scale)` splits
on `.`, validates the decimal part has no more digits than the scale allows, and
**throws** on malformed input or excess precision — failing loud rather than
silently rounding.

## Architecture (Approach A: IO / pure-logic / money split)

```
src/money.ts                 # parseFixed, parsePrice, parseQty, formatPrice, formatDollars
src/kalshi/types.ts          # raw response types + normalized Level/Book/Fill
src/kalshi/client.ts         # fetchOrderbook(ticker, depth?) — native fetch, no auth (IO only)
src/kalshi/orderbook.ts      # pure: normalize, asksForBuying, bestAsk, executableCost
src/scripts/kalshi-book.ts   # demo: fetch + print raw book + computed costs for a live market
```

`orderbook.ts` is pure (takes a parsed `Book`, never touches the network) so it
is unit-testable when the fee-math phase introduces a test runner. `money.ts` is
project-wide and will be reused by the Polymarket US side.

### Types

```ts
type RawOrderbook = {
  orderbook_fp: {
    yes_dollars: [string, string][];
    no_dollars: [string, string][];
  };
};

type Level = { price: number; qty: number };   // integers: 1/10000 $, 1/10000 contract
type Book  = { ticker: string; yesBids: Level[]; noBids: Level[] };

type Side = "yes" | "no";

type Fill = {
  fillable: boolean;       // true iff full requested size was filled
  filledSize: number;      // qty units actually filled (= requested if fillable, else max available)
  totalCost: number;       // exact integer, units of 1e-8 dollar (= price * qty summed)
  avgCost: number | null;  // integer 1/10000 $/contract, rounded; null iff filledSize === 0
  levelsConsumed: number;
};
```

### Pure logic — `orderbook.ts`

- `normalize(ticker, raw): Book` — map `yes_dollars`/`no_dollars` to integer
  `Level[]` via `parsePrice`/`parseQty`.
- `asksForBuying(book, side): Level[]` — **bids→asks conversion**:
  - Buy **YES** = lift **NO** bids: `askPrice = 10000 − noBid.price`,
    quantity carried through. Sort best-first (lowest ask ⇔ NO bids by price
    descending).
  - Buy **NO** = lift **YES** bids: `askPrice = 10000 − yesBid.price`,
    sorted best-first.
- `bestAsk(book, side): number | null` — first ask price, or null if that side
  has no liquidity. Satisfies "best price to BUY YES ≈ (1 − best NO bid)".
- `executableCost(asks, sizeQtyUnits): Fill` — walk `asks` best-first,
  accumulating qty until `sizeQtyUnits` is met:
  - `totalCost += price * min(remaining, level.qty)` (exact integer; partial last
    level allowed).
  - `filledSize` = qty consumed; `levelsConsumed` counts levels touched.
  - `avgCost = round(totalCost / filledSize)` — the **only** division, a single
    documented rounding to 1/10000-$/contract.
  - If depth is insufficient, return `fillable: false` with the partial
    `filledSize`/`totalCost`/`avgCost` (how much *could* fill). Empty asks →
    `{ fillable: false, filledSize: 0, totalCost: 0, avgCost: null, levelsConsumed: 0 }`.
  - Never throws on depth — "unfillable, not a crash".

Unit note: `price` is 1/10000 $, `qty` is 1/10000 contract, so
`price * qty` is in 1/1e8 dollar units; `totalCost / filledSize` reduces back to
1/10000-$/contract. All intermediate products stay well within `Number.MAX_SAFE_INTEGER`
for realistic book sizes.

### Fetch client — `client.ts`

`fetchOrderbook(ticker: string, depth?: number): Promise<RawOrderbook>`

- Builds `` `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/orderbook` ``
  with optional `?depth=`.
- Native `fetch`, **no auth headers** (explicit comment asserting the
  read-only / no-credential invariant for this phase).
- Non-200 → throw `Error` with status code and a body snippet.
- Missing `orderbook_fp` → throw a clear error.

## Demo script & verification — `src/scripts/kalshi-book.ts`

Run via a new npm script: `npm run book -- <ticker> [size]`
(`"book": "tsx src/scripts/kalshi-book.ts"` in `package.json`).

If no ticker is given, the script auto-selects the first open market with a
non-empty book (so it works out of the box). It prints, mapping 1:1 to the
issue's checklist:

1. Raw `orderbook_fp` JSON (proves the raw book for a live market).
2. Normalized YES/NO bids, dollar-formatted.
3. Best price to BUY YES and BUY NO (verifies `≈ 1 − best opposite bid`).
4. `executableCost` for increasing sizes (e.g. 10 / 100 / 1000 / oversized) —
   shows average cost rising with size and the oversized request returning
   `unfillable`.

Verification is by running this script and eyeballing the checklist; no unit
test runner is added this phase (per CLAUDE.md — tests arrive with the fee &
net-edge math).

## Error handling summary

| Condition                | Behavior                                  |
| ------------------------ | ----------------------------------------- |
| Network error / non-200  | `fetchOrderbook` throws (IO layer only)   |
| Missing `orderbook_fp`   | `fetchOrderbook` throws                    |
| Malformed number string  | `parseFixed` throws (no silent precision loss) |
| Size beyond depth        | `Fill { fillable: false, ...partial }`    |
| Empty book / no side     | `bestAsk` → null; `Fill` filledSize 0     |
| Credentials              | none used in any path                     |

## Out of scope

Order placement, any `orders.*` call, WebSocket `orderbook_delta` streaming,
Polymarket US, and fee/net-edge math (later phases). This issue is REST snapshot
read + conversion + executable-cost only.
```

