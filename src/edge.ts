/**
 * Cross-venue net-edge calculator.
 *
 * Arbitrage: buy YES on one venue and NO on the other for the same,
 * identically-resolving event. Exactly one side pays $1, so the payout is a
 * guaranteed $1 per contract pair and, per contract:
 *
 *   net = $1.00 − (cost_yes + cost_no + fee_yes + fee_no)
 *
 * All money is in 1/10000-$ units ($1.00 = PRICE_SCALE). Fees are charged on the
 * average fill price (conservative: over-estimates fee, under-states edge).
 */

import { avgFillPrice } from "./book.js";
import type { Level } from "./book.js";
import { PRICE_SCALE, QTY_SCALE } from "./money.js";

export interface VenueLeg {
  name: string;
  /** Best-first asks to BUY the YES side. */
  yesAsks: Level[];
  /** Best-first asks to BUY the NO side. */
  noAsks: Level[];
  /** Venue taker fee in 1/10000-$ units for a fill at `priceUnits` of `qtyUnits`. */
  fee: (priceUnits: number, qtyUnits: number) => number;
}

export interface StrategyAtSize {
  strategy: string;
  sizeContracts: number;
  fillable: boolean;
  costYes: number | null;
  costNo: number | null;
  feeYes: number | null;
  feeNo: number | null;
  /** 1/10000-$ per contract; null iff unfillable. */
  netPerContract: number | null;
}

export interface SizeRow {
  sizeContracts: number;
  s1: StrategyAtSize;
  s2: StrategyAtSize;
  best: { strategy: string; netPerContract: number } | null;
}

export interface NetEdgeReport {
  perSize: SizeRow[];
  /** Largest size where the best strategy's net per contract is > 0; null if none. */
  maxProfitableSize: number | null;
}

const DEFAULT_SIZES = [1, 5, 10, 25, 50, 100];

/** Net edge for buying YES on `yesLeg` and NO on `noLeg` at `sizeContracts`. */
function evaluateStrategy(
  yesLeg: VenueLeg,
  noLeg: VenueLeg,
  sizeContracts: number,
): StrategyAtSize {
  const strategy = `YES@${yesLeg.name}+NO@${noLeg.name}`;
  const qty = sizeContracts * QTY_SCALE;
  const costYes = avgFillPrice(yesLeg.yesAsks, qty);
  const costNo = avgFillPrice(noLeg.noAsks, qty);

  if (costYes === null || costNo === null) {
    return {
      strategy,
      sizeContracts,
      fillable: false,
      costYes,
      costNo,
      feeYes: null,
      feeNo: null,
      netPerContract: null,
    };
  }

  const feeYes = yesLeg.fee(costYes, QTY_SCALE);
  const feeNo = noLeg.fee(costNo, QTY_SCALE);
  const netPerContract = PRICE_SCALE - costYes - costNo - feeYes - feeNo;

  return {
    strategy,
    sizeContracts,
    fillable: true,
    costYes,
    costNo,
    feeYes,
    feeNo,
    netPerContract,
  };
}

/** Pick the fillable strategy with the higher net (S1 wins ties). */
function pickBest(s1: StrategyAtSize, s2: StrategyAtSize): SizeRow["best"] {
  const candidates = [s1, s2].filter(
    (s): s is StrategyAtSize & { netPerContract: number } => s.netPerContract !== null,
  );
  if (candidates.length === 0) return null;
  const winner = candidates.reduce((a, b) =>
    b.netPerContract > a.netPerContract ? b : a,
  );
  return { strategy: winner.strategy, netPerContract: winner.netPerContract };
}

/**
 * Evaluate both arbitrage strategies (YES@A+NO@B and YES@B+NO@A) across sizes,
 * returning per-size results and the largest size with positive net edge.
 */
export function netEdge(
  legA: VenueLeg,
  legB: VenueLeg,
  sizesContracts: number[] = DEFAULT_SIZES,
): NetEdgeReport {
  const perSize: SizeRow[] = sizesContracts.map((sizeContracts) => {
    const s1 = evaluateStrategy(legA, legB, sizeContracts);
    const s2 = evaluateStrategy(legB, legA, sizeContracts);
    return { sizeContracts, s1, s2, best: pickBest(s1, s2) };
  });

  let maxProfitableSize: number | null = null;
  for (const row of perSize) {
    if (row.best && row.best.netPerContract > 0) {
      maxProfitableSize = Math.max(maxProfitableSize ?? 0, row.sizeContracts);
    }
  }

  return { perSize, maxProfitableSize };
}
