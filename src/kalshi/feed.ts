/**
 * Kalshi orderbook_delta feed (read-only). Opens an authenticated WebSocket,
 * subscribes per ticker, maintains a KalshiLiveBook each, and emits FeedUpdate
 * on every change. Reconnects with backoff; on a seq gap it resubscribes to get
 * a fresh snapshot. Places no orders.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { buildKalshiAuthHeaders } from "./auth.js";
import { KalshiLiveBook } from "./live-book.js";
import type { KalshiSnapshotMsg, KalshiDeltaMsg } from "./live-book.js";
import { loadKalshiCredentials } from "../credentials.js";
import type { KalshiCredentials } from "../credentials.js";
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";
import type {
  FeedClient,
  FeedUpdate,
  FeedUpdateHandler,
  InstrumentRef,
} from "../feed/types.js";

export const KALSHI_WS_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
// The signed path is the WS handshake request path `/trade-api/ws/v2`
// (verified: this path returns 401 unauthenticated, root returns 404).
// The authenticated handshake signs `timestamp + "GET" + this path`.
export const KALSHI_WS_SIGN_PATH = "/trade-api/ws/v2";

const MAX_BACKOFF_MS = 30_000;

interface KalshiWsMessage {
  type: string;
  seq?: number;
  msg?: KalshiSnapshotMsg & KalshiDeltaMsg;
}

export class KalshiFeed implements FeedClient {
  private readonly emitter = new EventEmitter();
  private readonly books = new Map<string, KalshiLiveBook>();
  private nextCmdId = 1;
  private readonly sides = new Map<string, Set<Side>>(); // ticker -> requested sides
  private readonly stale = new Set<string>(); // tickers awaiting a fresh snapshot
  private ws: WebSocket | null = null;
  private backoffMs = 1_000;
  private closed = false;
  private fatal = false;

  constructor(private readonly creds: KalshiCredentials = loadKalshiCredentials()) {}

  subscribe(instruments: InstrumentRef[]): Promise<void> {
    for (const { marketId, side } of instruments) {
      if (!this.books.has(marketId)) this.books.set(marketId, new KalshiLiveBook(marketId));
      if (!this.sides.has(marketId)) this.sides.set(marketId, new Set());
      this.sides.get(marketId)!.add(side);
      this.stale.add(marketId);
    }
    return this.connect();
  }

  on(event: "update", handler: FeedUpdateHandler): void {
    this.emitter.on(event, handler);
  }

  getSnapshot(marketId: string, side: Side): BookSnapshot | null {
    const book = this.books.get(marketId);
    if (!book || book.lastUpdateMs === null) return null;
    return book.toSnapshot(side);
  }

  close(): void {
    this.closed = true;
    this.emitter.removeAllListeners();
    this.ws?.close();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = buildKalshiAuthHeaders(
        this.creds.keyId,
        this.creds.privateKeyPem,
        "GET",
        KALSHI_WS_SIGN_PATH,
      );
      const ws = new WebSocket(KALSHI_WS_URL, { headers });
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        settled = true;
        this.backoffMs = 1_000;
        for (const ticker of this.books.keys()) this.sendSubscribe(ws, ticker);
        resolve();
      });
      ws.on("message", (data: WebSocket.RawData) => this.handleMessage(data.toString()));
      ws.on("error", (err) => {
        console.error("[kalshi feed] socket error:", err);
      });
      ws.on("unexpected-response", (_req, res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          this.fatal = true;
          if (!settled) {
            settled = true;
            reject(
              new Error(
                "Kalshi WS auth failed (HTTP " +
                  res.statusCode +
                  "); check KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH",
              ),
            );
          }
        }
      });
      ws.on("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Kalshi WS closed before open"));
        }
        if (!this.closed && !this.fatal) {
          // Surface staleness to consumers before attempting to reconnect.
          for (const ticker of this.books.keys()) {
            this.stale.add(ticker);
            this.emitFor(ticker);
          }
          this.scheduleReconnect();
        }
      });
    });
  }

  private sendSubscribe(ws: WebSocket, ticker: string): void {
    this.stale.add(ticker);
    this.books.get(ticker)?.reset();
    ws.send(JSON.stringify({ id: this.nextCmdId++, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_ticker: ticker } }));
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (!this.closed) this.connect().catch(() => {});
    }, delay);
  }

  private handleMessage(raw: string): void {
    let parsed: KalshiWsMessage;
    try {
      parsed = JSON.parse(raw) as KalshiWsMessage;
    } catch {
      return; // ignore malformed frames
    }
    if (parsed.type === "orderbook_snapshot" || parsed.type === "orderbook_delta") {
      const ticker = parsed.msg?.market_ticker;
      if (!ticker) return;
      const book = this.books.get(ticker);
      if (!book || parsed.seq === undefined) return;

      const nowMs = Date.now();
      if (parsed.type === "orderbook_snapshot") {
        book.applySnapshot(parsed.msg as KalshiSnapshotMsg, parsed.seq, nowMs);
        this.stale.delete(ticker);
        this.emitFor(ticker);
      } else {
        const gap = book.applyDelta(parsed.msg as KalshiDeltaMsg, parsed.seq, nowMs);
        if (gap) {
          // Force a clean reconnect: closing triggers the reconnect path which
          // resubscribes ALL tickers and delivers fresh snapshots. Re-sending
          // subscribe on the same socket risks a duplicate-subscription reject.
          this.stale.add(ticker);
          // reset() nulls the book's lastUpdateMs, so the subsequent close
          // handler's emitFor intentionally skips this ticker (no empty stale
          // push). Consumers detect the gap via getSnapshot()===null / stale age.
          book.reset();
          this.ws?.close();
        } else {
          this.emitFor(ticker);
        }
      }
      return;
    }

    // Routine subscription acknowledgement: ignore quietly.
    if (parsed.type === "subscribed") return;
    // Anything else (e.g. an error frame) should not be silently dropped.
    console.error("[kalshi feed] unexpected frame:", raw);
  }

  private emitFor(ticker: string): void {
    const sides = this.sides.get(ticker);
    const book = this.books.get(ticker);
    if (!sides || !book || book.lastUpdateMs === null) return;
    const isStale = this.stale.has(ticker);
    for (const side of sides) {
      const update: FeedUpdate = {
        snapshot: book.toSnapshot(side),
        stale: isStale,
      };
      this.emitter.emit("update", update);
    }
  }
}
