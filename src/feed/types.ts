/**
 * Venue-neutral feed contract. A FeedClient maintains a live local book per
 * subscribed instrument and announces changes via an `update` event, while also
 * exposing current state via `getSnapshot` (push event + pull state).
 */
import type { Side } from "../book.js";
import type { BookSnapshot } from "../snapshot.js";

/** One subscribed instrument: a venue market id and which side it represents. */
export interface InstrumentRef {
  marketId: string;
  side: Side;
}

/** Emitted whenever a subscribed instrument's book changes. */
export interface FeedUpdate {
  snapshot: BookSnapshot;
  /** True when the book may be incomplete (awaiting a fresh snapshot after a drop/gap). */
  stale: boolean;
}

export type FeedUpdateHandler = (update: FeedUpdate) => void;

export interface FeedClient {
  subscribe(instruments: InstrumentRef[]): Promise<void>;
  on(event: "update", handler: FeedUpdateHandler): void;
  getSnapshot(marketId: string, side: Side): BookSnapshot | null;
  close(): void;
}
