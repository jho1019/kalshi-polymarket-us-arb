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
  yes_dollars_fp?: RawWsLevel[];
  no_dollars_fp?: RawWsLevel[];
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
  private updatedMs: number | null = null;

  constructor(readonly ticker: string) {}

  /** Local time (ms) of the last applied update, or null before the first snapshot. */
  get lastUpdateMs(): number | null {
    return this.updatedMs;
  }

  /** Replace the whole book from a snapshot; set the seq baseline and update time. */
  applySnapshot(msg: KalshiSnapshotMsg, seq: number, tsLocalMs: number): void {
    this.yes.replace(toLevels(msg.yes_dollars_fp ?? []));
    this.no.replace(toLevels(msg.no_dollars_fp ?? []));
    this.seq = seq;
    this.updatedMs = tsLocalMs;
  }

  /**
   * Apply one delta. Returns `true` if a seq gap is detected — in that case the
   * book and update time are left unchanged and the caller should resubscribe
   * for a fresh snapshot.
   */
  applyDelta(msg: KalshiDeltaMsg, seq: number, tsLocalMs: number): boolean {
    if (isSeqGap(this.seq, seq)) return true;
    const levels = msg.side === "yes" ? this.yes : this.no;
    levels.applyDelta(parsePrice(msg.price_dollars), parseSignedQty(msg.delta_fp));
    this.seq = seq;
    this.updatedMs = tsLocalMs;
    return false;
  }

  /** Discard local state (after a disconnect or seq gap, before re-snapshot). */
  reset(): void {
    this.yes.clear();
    this.no.clear();
    this.seq = null;
    this.updatedMs = null;
  }

  /**
   * Render the current book as a one-sided `BookSnapshot`, stamped with the time
   * of the last applied update. Throws if called before any update (the feed
   * guards this via `lastUpdateMs`).
   */
  toSnapshot(side: Side): BookSnapshot {
    if (this.updatedMs === null) {
      throw new Error(`KalshiLiveBook.toSnapshot(${this.ticker}) called before any update`);
    }
    const book: Book = {
      ticker: this.ticker,
      yesBids: this.yes.toSorted(true),
      noBids: this.no.toSorted(true),
    };
    return bookToSnapshot(book, side, {
      tsLocalMs: this.updatedMs,
      ...(this.seq !== null ? { seq: this.seq } : {}),
    });
  }
}
