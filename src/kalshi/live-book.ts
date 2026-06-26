/**
 * Kalshi live order book: applies an `orderbook_snapshot` then incremental
 * `orderbook_delta` messages to maintain the YES/NO bid books locally, and
 * renders a one-sided `BookSnapshot` reusing the REST bid->ask conversion.
 *
 * READ-ONLY: maintains state from the public-data feed; places no orders.
 */
import { PriceLevels, isSeqGap } from "../feed/book-state.js";
import { bookToSnapshot } from "./orderbook.js";
import type { Book } from "./types.js";
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";
import { parsePrice, parseQty, parseSignedQty } from "../money.js";

/** A raw `[priceDollars, qty]` level as sent on the WS snapshot. */
type RawWsLevel = [string, string];

export interface KalshiSnapshotMsg {
  market_ticker: string;
  yes_dollars_fp: RawWsLevel[];
  no_dollars_fp: RawWsLevel[];
}

export interface KalshiDeltaMsg {
  market_ticker: string;
  price_dollars: string;
  delta_fp: string;
  side: Side;
  ts_ms?: number;
}

function toLevels(raw: RawWsLevel[]) {
  return raw.map(([price, qty]) => ({ price: parsePrice(price), qty: parseQty(qty) }));
}

export class KalshiLiveBook {
  private readonly yes = new PriceLevels();
  private readonly no = new PriceLevels();
  private seq: number | null = null;

  constructor(readonly ticker: string) {}

  /** Replace the whole book from a snapshot and set the seq baseline. */
  applySnapshot(msg: KalshiSnapshotMsg, seq: number): void {
    this.yes.replace(toLevels(msg.yes_dollars_fp));
    this.no.replace(toLevels(msg.no_dollars_fp));
    this.seq = seq;
  }

  /**
   * Apply one delta. Returns `true` if a seq gap is detected — in that case the
   * book is left unchanged and the caller should resubscribe for a fresh
   * snapshot.
   */
  applyDelta(msg: KalshiDeltaMsg, seq: number): boolean {
    if (isSeqGap(this.seq, seq)) return true;
    const levels = msg.side === "yes" ? this.yes : this.no;
    levels.applyDelta(parsePrice(msg.price_dollars), parseSignedQty(msg.delta_fp));
    this.seq = seq;
    return false;
  }

  /** Discard local state (after a disconnect or seq gap, before re-snapshot). */
  reset(): void {
    this.yes.clear();
    this.no.clear();
    this.seq = null;
  }

  /** Render the current book as a one-sided `BookSnapshot`. */
  toSnapshot(side: Side, meta: { tsLocalMs: number }): BookSnapshot {
    const book: Book = {
      ticker: this.ticker,
      yesBids: this.yes.toSorted(true),
      noBids: this.no.toSorted(true),
    };
    return bookToSnapshot(book, side, {
      tsLocalMs: meta.tsLocalMs,
      ...(this.seq !== null ? { seq: this.seq } : {}),
    });
  }
}
