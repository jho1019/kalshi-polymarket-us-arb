/**
 * Venue-neutral pieces of live local-book maintenance. Pure, no I/O.
 *
 * `PriceLevels` is one side of a book keyed by integer price units, supporting
 * snapshot replace and signed incremental deltas (a level driven to <= 0 is
 * removed). `isSeqGap` flags a non-consecutive sequence number (lost messages).
 */
import type { Level } from "../book.js";

export class PriceLevels {
  private levels = new Map<number, number>(); // priceUnits -> qtyUnits

  /** Replace all levels from a snapshot (drops non-positive quantities). */
  replace(levels: Level[]): void {
    this.levels.clear();
    for (const { price, qty } of levels) {
      if (qty > 0) this.levels.set(price, qty);
    }
  }

  /** Apply a signed quantity change at a price; remove the level if it hits <= 0. */
  applyDelta(priceUnits: number, signedQtyUnits: number): void {
    const next = (this.levels.get(priceUnits) ?? 0) + signedQtyUnits;
    if (next > 0) this.levels.set(priceUnits, next);
    else this.levels.delete(priceUnits);
  }

  /** Levels sorted by price: descending (bids best-first) or ascending. */
  toSorted(descending: boolean): Level[] {
    const arr: Level[] = [...this.levels.entries()].map(([price, qty]) => ({ price, qty }));
    arr.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
    return arr;
  }

  clear(): void {
    this.levels.clear();
  }
}

/** True if `nextSeq` is not exactly `prevSeq + 1` (a gap). Null baseline = no gap. */
export function isSeqGap(prevSeq: number | null, nextSeq: number): boolean {
  if (prevSeq === null) return false;
  return nextSeq !== prevSeq + 1;
}
