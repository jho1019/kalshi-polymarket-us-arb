/**
 * Shared compute core: turn a RAW CaptureRecord into VenueLegs and a computed
 * StoredOpportunity under a given FeeConfig. Pure (no I/O). The live logger calls
 * this with the current fees; `recompute` calls it with a different FeeConfig —
 * one code path, so opportunities are always recomputable from raw.
 */
import { feeUnits } from "../fees.js";
import { netEdge } from "../edge.js";
import type { VenueLeg } from "../edge.js";
import { buildOpportunity } from "../opportunity.js";
import type { BookSnapshot } from "../snapshot.js";
import type { CaptureLeg, CaptureRecord, FeeConfig, StoredOpportunity } from "./model.js";

function legToVenueLeg(leg: CaptureLeg, rateBps: number): VenueLeg {
  return {
    name: leg.name,
    yesAsks: leg.yesSnapshot?.asks ?? [],
    noAsks: leg.noSnapshot?.asks ?? [],
    fee: (priceUnits, qtyUnits) => feeUnits(priceUnits, qtyUnits, rateBps),
  };
}

/** Build both VenueLegs from a capture record under the given fee config. */
export function captureToLegs(
  record: CaptureRecord,
  feeConfig: FeeConfig,
): { legA: VenueLeg; legB: VenueLeg } {
  return {
    legA: legToVenueLeg(record.legA, feeConfig.kalshiRateBps),
    legB: legToVenueLeg(record.legB, feeConfig.polymarketUsTakerBps),
  };
}

function legSnapshots(leg: CaptureLeg): BookSnapshot[] {
  return [leg.yesSnapshot, leg.noSnapshot].filter((s): s is BookSnapshot => s !== null);
}

/** Compute a StoredOpportunity from a capture record under the given fee config. */
export function computeOpportunity(
  record: CaptureRecord,
  feeConfig: FeeConfig,
): StoredOpportunity {
  const snapsA = legSnapshots(record.legA);
  const snapsB = legSnapshots(record.legB);
  if (snapsA.length === 0) {
    throw new Error("computeOpportunity: leg A (" + record.legA.venue + ") has no snapshot");
  }
  if (snapsB.length === 0) {
    throw new Error("computeOpportunity: leg B (" + record.legB.venue + ") has no snapshot");
  }
  const { legA, legB } = captureToLegs(record, feeConfig);
  const edge = netEdge(legA, legB);
  const opp = buildOpportunity({
    pairId: record.pairId,
    captureMs: record.captureMs,
    legA: { venue: record.legA.venue, snapshots: snapsA, stale: record.legA.stale },
    legB: { venue: record.legB.venue, snapshots: snapsB, stale: record.legB.stale },
    edge,
  });
  return { ...opp, captureId: record.captureId, feeConfig };
}
