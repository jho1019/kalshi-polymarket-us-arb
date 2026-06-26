/**
 * Recompute computed opportunities from RAW capture records under a (possibly
 * changed) fee assumption. The whole point of storing raw books separately.
 */
import { computeOpportunity } from "./compute.js";
import type { CaptureRecord, FeeConfig, StoredOpportunity } from "./model.js";

export function recompute(records: CaptureRecord[], feeConfig: FeeConfig): StoredOpportunity[] {
  return records.map((record) => computeOpportunity(record, feeConfig));
}
