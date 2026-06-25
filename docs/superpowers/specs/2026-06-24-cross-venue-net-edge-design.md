# Cross-venue net-edge calculator at multiple sizes

Design for GitHub issue #10 (`phase:edge-calc`), the capstone of the phase. Ties
together executable cost (#7) and both fee modules (#8, #9).

## The arbitrage model

Buy YES on one venue and NO on the other for the SAME, identically-resolving
event (the pair-registry guarantee, a later phase). Exactly one of YES/NO pays
$1, so the payout is a guaranteed **$1 per contract pair**. Therefore, per
contract:

```
net = $1.00 − (cost_yes + cost_no + fee_yes + fee_no)
```

Two strategies for a venue pair (A, B):
- **S1 = YES@A + NO@B**
- **S2 = YES@B + NO@A**

All money is in 1/10000-$ units; `$1.00 = PRICE_SCALE = 10000`.

## Fee basis (decided)

Fee per leg is charged on the **average fill price**: `fee = leg.fee(avgFillPrice,
1 contract)`. Because `p(1−p)` is concave, this over-estimates the true per-level
fee (Jensen), so net edge is under-stated — the conservative/safe direction for
declaring an arb. Per-level fee was rejected as false precision (the venues' real
per-fill rounding/accumulators aren't reproduced exactly either) and heavier to
verify. Revisit if logged data shows fees swinging marginal edges.

## Architecture — `src/edge.ts` (venue-neutral)

```ts
interface VenueLeg {
  name: string;                 // "kalshi" | "polymarket-us"
  yesAsks: Level[];             // best-first asks to buy YES
  noAsks: Level[];              // best-first asks to buy NO
  fee: (priceUnits: number, qtyUnits: number) => number;
}

interface StrategyAtSize {
  strategy: string;             // e.g. "YES@kalshi+NO@polymarket-us"
  sizeContracts: number;
  fillable: boolean;
  costYes: number | null;       // per-contract avg, 1/10000-$
  costNo: number | null;
  feeYes: number | null;        // per-contract fee at avg price
  feeNo: number | null;
  netPerContract: number | null;// null iff unfillable
}

interface SizeRow {
  sizeContracts: number;
  s1: StrategyAtSize;
  s2: StrategyAtSize;
  best: { strategy: string; netPerContract: number } | null; // higher net; null if neither fillable
}

interface NetEdgeReport {
  perSize: SizeRow[];
  maxProfitableSize: number | null; // largest size where best net > 0
}

function netEdge(
  legA: VenueLeg,
  legB: VenueLeg,
  sizesContracts?: number[],    // default [1, 5, 10, 25, 50, 100]
): NetEdgeReport;
```

The caller builds each `VenueLeg` from a book (`asksForBuying`) plus the venue's
`takerFee`, so `edge.ts` stays venue-agnostic and reuses `avgFillPrice` and the
fee modules unchanged.

### Per strategy, per size N

- `costYes = avgFillPrice(yesLeg.yesAsks, N·QTY_SCALE)`,
  `costNo = avgFillPrice(noLeg.noAsks, N·QTY_SCALE)`. If either is `null`
  (insufficient depth) → strategy unfillable at N, `netPerContract = null`.
- `feeYes = yesLeg.fee(costYes, QTY_SCALE)`, `feeNo = noLeg.fee(costNo, QTY_SCALE)`.
- `netPerContract = PRICE_SCALE − costYes − costNo − feeYes − feeNo`.

`best` = the fillable strategy with the higher `netPerContract` (S1 on tie).
`maxProfitableSize` = the largest size whose `best.netPerContract > 0`
(net per contract is non-increasing in size, so this is a clean threshold).

## Tests — `src/edge.test.ts` (synthetic books, node:test)

Use real `kalshi.takerFee` (0.07) and `polymarket.takerFee` (0.05) as the leg
fees so totals include both venues' fees.

- **Hand calc:** known single-level prices → exact `netPerContract` for S1 and S2,
  including both fees; assert the literal integer.
- **Gross-positive but fee-negative:** `cost_yes + cost_no < $1` yet
  `+ fees > $1` → `best.netPerContract ≤ 0`, size excluded from
  `maxProfitableSize`.
- **Picks the more profitable strategy:** asymmetric books where S1 ≠ S2 → `best`
  names the higher-net strategy.
- **Depth limits:** small level quantities → larger sizes unfillable
  (`netPerContract null`); `maxProfitableSize` reflects the fillable+profitable
  threshold.
- **Multi-level fill:** exercises weighted-avg cost feeding fee-on-avg.

## Out of scope

Live wiring to real Kalshi↔Polymarket pairs (needs the hand-verified pair
registry, a later phase), spread logging, and per-level fee modeling. This issue
is the pure calculator + synthetic tests.
