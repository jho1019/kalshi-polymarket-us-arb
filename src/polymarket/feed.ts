/**
 * Polymarket US market-data feed (read-only). Wraps the SDK's `ws.markets()`
 * socket: subscribe to slugs, and on each full `marketData` message replace the
 * stored book and emit a FeedUpdate. PM sends no incremental deltas and no seq,
 * so "maintenance" is latest-full-book-wins. The SDK's order surface is never
 * referenced here.
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

export class PolymarketFeed implements FeedClient {
  private readonly emitter = new EventEmitter();
  private readonly sides = new Map<string, Side>(); // slug -> side label
  private readonly latest = new Map<string, BookSnapshot>(); // slug -> last snapshot
  private readonly client: PolymarketUS;
  private readonly socket: ReturnType<PolymarketUS["ws"]["markets"]>;
  private requestSeq = 0;

  constructor() {
    const { keyId, secretKey } = loadPolymarketCredentials();
    this.client = new PolymarketUS({ keyId, secretKey });
    this.socket = this.client.ws.markets();
    this.socket.on("marketData", (data) => this.handleMarketData(data.marketData as MarketData));
  }

  async subscribe(instruments: InstrumentRef[]): Promise<void> {
    for (const { marketId, side } of instruments) this.sides.set(marketId, side);
    await this.socket.connect();
    this.socket.subscribeMarketData(`md-${++this.requestSeq}`, [...this.sides.keys()]);
  }

  on(event: "update", handler: FeedUpdateHandler): void {
    this.emitter.on(event, handler);
  }

  getSnapshot(marketId: string, _side: Side): BookSnapshot | null {
    return this.latest.get(marketId) ?? null;
  }

  close(): void {
    this.socket.close();
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
