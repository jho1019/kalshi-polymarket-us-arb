# Polymarket US fee module

Design for GitHub issue #9 (`phase:edge-calc`). Implement the real PM US fee from
the official docs — no guessing.

## Source (verify item: cite the fees page)

`https://docs.polymarket.us/fees`. Quoted facts:

- **Formula:** `Fee = Θ × C × p × (1 − p)`, where `C` = contract count, `p` =
  trade price ($0.01–$0.99), `Θ` = fee coefficient. Same shape as Kalshi.
- **Taker coefficient Θ = 0.05** (max $1.25 / 100 contracts at p=$0.50).
- **Maker rebate coefficient = −0.0125** (125 bps, = 25% of taker), applied at
  trade execution.
- **Volume promo:** 30% taker rebate for >$250,000 taker volume between
  2026-05-15 and 2026-06-30 inclusive. Time-limited and volume-conditional — a
  promo, not a per-trade fee.
- **No settlement fees and no withdrawal fees** are mentioned on the page.

### Worked examples (used as tests)

- Taker @ $0.50, 1000 contracts: `0.05 × 1000 × 0.50 × 0.50 = $12.50`.
- Taker @ $0.10, 1000 contracts: `0.05 × 1000 × 0.10 × 0.90 = $4.50`.
- Maker @ $0.50, 1000 contracts: `0.0125 × 1000 × 0.25 = $3.125` (docs display
  "$3.13").
- Maker @ $0.10, 1000 contracts: `0.0125 × 1000 × 0.09 = $1.125` (docs "$1.13").

In the project's 1/10000-$ unit these are exact integers (125000, 45000, 31250,
11250). The docs' "$3.13"/"$1.13" are cent-level display rounding of $3.125 /
$1.125. PM US docs (unlike Kalshi's) state no rounding granularity/direction, so
fees stay **exact at the centicent** (our unit), matching the taker examples
exactly.

## Architecture

### Extract shared fee math — `src/fees.ts` (venue-neutral)

Kalshi taker, PM taker, and PM maker all use the same `Θ·C·p·(1−p)` ceil formula.
Extract the overflow-safe BigInt core once (parallels `executableCost` in
`book.ts`):

```ts
// feeUnits = ceil( coefficientBps · P · (S−P) · Q / (BPS_SCALE · S · QTY_SCALE) )
export function feeUnits(priceUnits: number, qtyUnits: number, coefficientBps: number): number;
```

`S = PRICE_SCALE`, `BPS_SCALE = 10000`, denom = 1e12. BigInt product + ceil-division
(numerator overflows JS safe ints past ~5k contracts), returns a `Number`.
Validates: `priceUnits ∈ [0, S]`, `qtyUnits ≥ 0`, `coefficientBps ≥ 0`, all
integers.

`src/kalshi/fees.ts` `takerFee` is refactored to call `feeUnits(p, q, rateBps)`
(behavior unchanged; default 700 bps). Its tests must stay green.

### `src/polymarket/fees.ts`

```ts
export const PM_TAKER_BPS = 500;        // 0.05
export const PM_MAKER_REBATE_BPS = 125; // 0.0125 (25% of taker)

export function takerFee(priceUnits, qtyUnits): number;    // feeUnits(p, q, 500)
export function makerRebate(priceUnits, qtyUnits): number; // feeUnits(p, q, 125), a positive credit
```

Both return 1/10000-$ units. The volume promo is a documented comment, not
implemented. No settlement/withdrawal fee functions (none exist).

## Tests — `src/polymarket/fees.test.ts` (node:test)

- `takerFee(5000, 1000·QTY) === 125000` ($12.50) and `takerFee(1000, 1000·QTY) === 45000`
  ($4.50) — doc worked examples.
- `makerRebate(5000, 1000·QTY) === 31250` ($3.125) and `makerRebate(1000, 1000·QTY) === 11250`
  ($1.125).
- `makerRebate × 4 === takerFee` (documented 25% relationship), symmetry
  `fee(p) === fee(S − p)`, `p=0`/`p=S` → 0, validation throws.

## Out of scope

Volume-rebate promo logic, combining fees with executable cost into net edge
(#10). Standalone PM US fee estimator only.
