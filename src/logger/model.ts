/**
 * Storage record types for the append-only logger. A CaptureRecord is the RAW
 * store (everything needed to recompute); a StoredOpportunity is the computed
 * store. All fields are JSON-native integers → lossless JSONL (de)serialization.
 */
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { Opportunity } from "../opportunity.js";

/** A fee assumption: per-venue coefficient in basis points (feeUnits' coefficient). */
export interface FeeConfig {
  kalshiRateBps: number;
  polymarketUsTakerBps: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  kalshiRateBps: 700,
  polymarketUsTakerBps: 500,
};

/** One venue's books at capture time, aligned to the PAIR's YES/NO outcomes. */
export interface CaptureLeg {
  venue: Venue;
  /** VenueLeg name, e.g. "kalshi". */
  name: string;
  /** OR of the constituent books' stale flags. */
  stale: boolean;
  /** asks = asks to buy the pair's YES on this venue (null = side unreadable/missing). */
  yesSnapshot: BookSnapshot | null;
  /** asks = asks to buy the pair's NO on this venue (null = side unreadable/missing). */
  noSnapshot: BookSnapshot | null;
}

/** RAW store record: a single capture tick for one pair. */
export interface CaptureRecord {
  captureId: string;
  captureMs: number;
  pairId: string;
  legA: CaptureLeg; // kalshi
  legB: CaptureLeg; // polymarket-us
}

/** Computed store record: an Opportunity tagged with provenance. */
export interface StoredOpportunity extends Opportunity {
  captureId: string;
  feeConfig: FeeConfig;
}
