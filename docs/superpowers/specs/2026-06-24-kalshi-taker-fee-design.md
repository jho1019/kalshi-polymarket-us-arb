# Kalshi taker fee module

Design for GitHub issue #8 (`phase:edge-calc`).

## Formula and the docs discrepancy

Issue text: `fee = ceil(0.07 × price × (1−price) × contracts)` rounded **up to the
next cent**. This is Kalshi's well-known *general* taker fee.

Official docs check (`docs.kalshi.com/getting_started/fee_rounding`): Kalshi rounds
the trade fee **up to the nearest $0.0001 (centicent)**, not up to the next cent.
The docs also describe a per-fill accumulator/rebate mechanism (an execution
detail beyond this aggregate estimator). The `0.07` coefficient is the general
rate and is not restated on the doc pages reachable here (the fee-schedule page
404s); some markets use other rates.

**Decision (approved):** use the official **centicent** rounding. A centicent is
exactly one unit in the project's 1/10000-dollar money model, so the fee returns
in the same unit as everything else — no separate "cents" concept. All three
verify cases are exact values, so they pass under either rounding rule.

## Function — `src/kalshi/fees.ts`

```ts
export function takerFee(
  priceUnits: number,          // 1/10000-$ price (0.50 -> 5000), in [0, PRICE_SCALE]
  qtyUnits: number,            // 1/10000-contract qty (composes with Fill.filledSize)
  opts?: { rateBps?: number }, // fee rate in basis points; default 700 = 0.07
): number;                     // fee in 1/10000-$ units, ceil'd to a centicent
```

- `qtyUnits` is in 1/10000-contract units (not whole contracts) so the fee
  applies directly to `executableCost(...).filledSize`.
- `rateBps` defaults to 700 (0.07); a basis-points knob keeps the rate exact and
  ready for markets with different rates (pair-registry phase). YAGNI-minimal.

### Exact integer math (BigInt)

Let `S = PRICE_SCALE = 10000`, `BPS_SCALE = 10000`, `QTY_SCALE = 10000`.

```
feeUnits = ceil( rateBps · priceUnits · (S − priceUnits) · qtyUnits
                 / (BPS_SCALE · S · QTY_SCALE) )            # denom = 1e12
```

Derivation: `rate=rateBps/BPS_SCALE`, `price=priceUnits/S`,
`(1−price)=(S−priceUnits)/S`, `contracts=qtyUnits/QTY_SCALE`; multiply by `S` to
express the dollar result back in 1/10000-$ units.

The numerator exceeds `Number.MAX_SAFE_INTEGER` beyond ~5k contracts, so the
product and ceil-division are done in **BigInt** (`(num + den − 1n) / den`), then
converted to `Number` (the fee itself is well within safe range). No floats.

### Validation

Throw on non-integer or out-of-range inputs: `priceUnits` in `[0, S]`,
`qtyUnits ≥ 0`, `rateBps ≥ 0` — fee math is money-critical, so fail loud.

## Tests — `src/kalshi/fees.test.ts` (node:test)

- `takerFee(5000, 100·QTY_SCALE) === 17500` ($1.75).
- `takerFee(1000, 100·QTY_SCALE) === 6300` ($0.63) — rounding check.
- Symmetry: `takerFee(p, q) === takerFee(S − p, q)` across several prices.
- Edges: `priceUnits` 0 and `S` → 0; a sub-centicent raw fee ceils **up** to 1;
  a large size in the overflow regime matches the BigInt-computed expectation.
- Validation: out-of-range price / negative qty throw.

## Out of scope

Per-fill accumulator/rebate modeling, Polymarket fees, and combining fee with
executable cost into net edge (later edge-calc issues). This is the standalone
Kalshi taker-fee estimator only.
