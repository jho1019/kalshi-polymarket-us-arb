/**
 * Live append-only logger (read-only). Subscribes the feeds to every loggable
 * (reviewed) pair's instruments, caches each instrument's latest {snapshot,
 * stale} from the push `update` events, and on a fixed interval appends a RAW
 * CaptureRecord + a computed StoredOpportunity per pair. Places no orders.
 *
 * Ops behaviors:
 *  - Heartbeat: logs "[logger] heartbeat <ISO>" to stdout each tick.
 *  - Feed alerting: logs an ALERT to stderr when any venue first goes stale;
 *    logs RECOVERED to stdout when it returns to non-stale.
 *  - Stale exclusion: raw captures are always written; opportunity records are
 *    only written when BOTH legs are non-stale.
 */
import type { FeedClient, FeedUpdate, InstrumentRef } from "../feed/types.js";
import type { MarketPair } from "../registry/schema.js";
import type { Side } from "../book.js";
import type { Venue } from "../snapshot.js";
import { getLoggablePairs } from "../registry/schema.js";
import { buildCaptureRecord } from "./capture.js";
import type { InstrumentSnapshot, SnapshotLookup } from "./capture.js";
import { computeOpportunity } from "./compute.js";
import { DEFAULT_FEE_CONFIG } from "./model.js";
import { appendRecord, oppsPath, rawPath } from "../storage/jsonl.js";

export interface LoggerOptions {
  kalshiFeed: FeedClient;
  pmFeed: FeedClient;
  pairs: readonly MarketPair[];
  dataDir: string;
  intervalMs?: number;
  now?: () => number;
}

function instrumentsFor(pair: MarketPair): { kalshi: InstrumentRef[]; pm: InstrumentRef[] } {
  const kalshi: InstrumentRef[] = [
    { marketId: pair.kalshi.ticker, side: "yes" },
    { marketId: pair.kalshi.ticker, side: "no" },
  ];
  const pm: InstrumentRef[] =
    pair.polymarketUs.kind === "dualSlug"
      ? [
          { marketId: pair.polymarketUs.yesSlug, side: "yes" },
          { marketId: pair.polymarketUs.noSlug, side: "no" },
        ]
      : [{ marketId: pair.polymarketUs.slug, side: pair.polymarketUs.yesIsLong ? "yes" : "no" }];
  return { kalshi, pm };
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runLogger(opts: LoggerOptions): Promise<{ stop: () => void }> {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 1_000;
  const pairs = getLoggablePairs(opts.pairs);

  const key = (venue: Venue, marketId: string, side: Side): string => `${venue}:${marketId}:${side}`;
  const cache = new Map<string, InstrumentSnapshot>();
  const lookup: SnapshotLookup = (venue, marketId, side) => cache.get(key(venue, marketId, side)) ?? null;

  // Track per-venue staleness to fire exactly one ALERT per drop, one RECOVERED per recovery.
  const venueStale = new Map<Venue, boolean>();

  const onUpdate = (u: FeedUpdate): void => {
    cache.set(key(u.snapshot.venue, u.snapshot.marketId, u.snapshot.side), {
      snapshot: u.snapshot,
      stale: u.stale,
    });
    const venue = u.snapshot.venue;
    const prev = venueStale.get(venue) ?? false;
    if (u.stale && !prev) {
      console.error(`[logger] ALERT: ${venue} feed stale at ${new Date(u.snapshot.tsLocalMs).toISOString()}`);
      venueStale.set(venue, true);
    } else if (!u.stale && prev) {
      console.log(`[logger] RECOVERED: ${venue} feed recovered`);
      venueStale.set(venue, false);
    }
  };
  opts.kalshiFeed.on("update", onUpdate);
  opts.pmFeed.on("update", onUpdate);

  const kalshiRefs: InstrumentRef[] = [];
  const pmRefs: InstrumentRef[] = [];
  for (const pair of pairs) {
    const { kalshi, pm } = instrumentsFor(pair);
    kalshiRefs.push(...kalshi);
    pmRefs.push(...pm);
  }
  if (kalshiRefs.length > 0) await opts.kalshiFeed.subscribe(kalshiRefs);
  if (pmRefs.length > 0) await opts.pmFeed.subscribe(pmRefs);

  let captureSeq = 0;
  const tick = (): void => {
    const captureMs = now();
    console.log(`[logger] heartbeat ${new Date(captureMs).toISOString()}`);
    const date = dateOf(captureMs);
    for (const pair of pairs) {
      try {
        const captureId = `${captureMs}-${pair.pairId}-${captureSeq++}`;
        const record = buildCaptureRecord(pair, captureMs, captureId, lookup);
        if (!record) continue;
        appendRecord(rawPath(opts.dataDir, date), record);
        if (!record.legA.stale && !record.legB.stale) {
          const opp = computeOpportunity(record, DEFAULT_FEE_CONFIG);
          appendRecord(oppsPath(opts.dataDir, date), opp);
        }
      } catch (err) {
        console.error("[logger] capture failed for " + pair.pairId + ":", err);
      }
    }
  };
  const timer = setInterval(tick, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      opts.kalshiFeed.close();
      opts.pmFeed.close();
    },
  };
}
