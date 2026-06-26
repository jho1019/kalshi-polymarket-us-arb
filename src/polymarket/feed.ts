/**
 * Polymarket US market-data feed (read-only). Wraps the SDK's `ws.markets()`
 * socket: subscribe to slugs, and on each full `marketData` message replace the
 * stored book and emit a FeedUpdate. PM sends no incremental deltas and no seq,
 * so "maintenance" is latest-full-book-wins. The SDK's order surface is never
 * referenced here.
 *
 * The SDK does not auto-reconnect (its `handleClose` only re-emits `close`), so
 * on a dropped connection we mark the last books stale and reconnect/resubscribe
 * with capped backoff, mirroring the Kalshi feed's single-driver approach.
 */
import { EventEmitter } from "node:events";
import { PolymarketUS } from "polymarket-us";
import { loadPolymarketCredentials } from "../credentials.js";
import { toBookSnapshot } from "./orderbook.js";
import type { MarketData } from "./client.js";
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";
import type {
  FeedClient,
  FeedUpdate,
  FeedUpdateHandler,
  InstrumentRef,
} from "../feed/types.js";

const MAX_BACKOFF_MS = 30_000;

export class PolymarketFeed implements FeedClient {
  private readonly emitter = new EventEmitter();
  private readonly sides = new Map<string, Side>(); // slug -> side label
  private readonly latest = new Map<string, BookSnapshot>(); // slug -> last snapshot
  private readonly client: PolymarketUS;
  private readonly socket: ReturnType<PolymarketUS["ws"]["markets"]>;
  private requestSeq = 0;
  private closed = false;
  private backoffMs = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const { keyId, secretKey } = loadPolymarketCredentials();
    this.client = new PolymarketUS({ keyId, secretKey });
    this.socket = this.client.ws.markets();
    this.socket.on("marketData", (data) => this.handleMarketData(data.marketData as MarketData));
    this.socket.on("close", () => {
      if (this.closed) return;
      // Surface staleness for every slug with a known prior book, then reconnect.
      for (const slug of this.sides.keys()) {
        const last = this.latest.get(slug);
        if (!last) continue;
        this.emitter.emit("update", { snapshot: last, stale: true });
      }
      this.scheduleReconnect();
    });
    this.socket.on("error", (e) => console.error("[pm feed] socket error:", e));
  }

  async subscribe(instruments: InstrumentRef[]): Promise<void> {
    for (const { marketId, side } of instruments) this.sides.set(marketId, side);
    await this.socket.connect();
    this.socket.subscribeMarketData(`md-${++this.requestSeq}`, [...this.sides.keys()]);
    this.backoffMs = 1_000;
  }

  on(event: "update", handler: FeedUpdateHandler): void {
    this.emitter.on(event, handler);
  }

  getSnapshot(marketId: string, _side: Side): BookSnapshot | null {
    return this.latest.get(marketId) ?? null;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.emitter.removeAllListeners();
    this.socket.close();
  }

  /** Reconnect + resubscribe after a drop. Exactly one timer pending at a time. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed) return;
      try {
        await this.socket.connect();
        this.socket.subscribeMarketData(`md-${++this.requestSeq}`, [...this.sides.keys()]);
        this.backoffMs = 1_000;
      } catch (e) {
        console.error("[pm feed] reconnect failed:", e);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private handleMarketData(data: MarketData): void {
    const side = this.sides.get(data.marketSlug);
    if (!side) return;
    const snapshot = toBookSnapshot(data, side, { tsLocalMs: Date.now() });
    this.latest.set(data.marketSlug, snapshot);
    const update: FeedUpdate = { snapshot, stale: false };
    this.emitter.emit("update", update);
  }
}
