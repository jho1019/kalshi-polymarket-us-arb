/**
 * Recompute a day's opportunities from RAW capture records under a different fee
 * assumption (issue #15 verify: opps recomputable from raw with a CHANGED fee).
 *
 * Usage: npm run recompute -- <YYYY-MM-DD (UTC)> <kalshiBps> <pmBps>
 */
import { readRecords, rawPath } from "../storage/jsonl.js";
import { recompute } from "../logger/recompute.js";
import type { CaptureRecord, StoredOpportunity } from "../logger/model.js";
import { formatPrice } from "../money.js";

function arg(i: number, name: string): string {
  const v = process.argv[i];
  if (v === undefined) throw new Error(`missing arg: ${name}`);
  return v;
}

function size1Net(opp: StoredOpportunity): number | null {
  return opp.edge.perSize.find((r) => r.sizeContracts === 1)?.best?.netPerContract ?? null;
}

function main(): void {
  const date = arg(2, "date (YYYY-MM-DD)");
  const kalshiRateBps = Number(arg(3, "kalshiBps"));
  const polymarketUsTakerBps = Number(arg(4, "pmBps"));
  if (!Number.isFinite(kalshiRateBps) || !Number.isFinite(polymarketUsTakerBps)) {
    throw new Error(
      "kalshiBps/pmBps must be numbers; usage: npm run recompute -- <YYYY-MM-DD> <kalshiBps> <pmBps>",
    );
  }

  const records = readRecords(rawPath("data", date)) as CaptureRecord[];
  const opps = recompute(records, { kalshiRateBps, polymarketUsTakerBps });
  console.log(
    `Recomputed ${opps.length} opportunit(ies) for ${date} at ` +
      `kalshi=${kalshiRateBps}bps pm=${polymarketUsTakerBps}bps:`,
  );
  for (const o of opps) {
    const net = size1Net(o);
    console.log(
      `  ${o.pairId} @${o.captureMs} skew=${o.bookSkewMs}ms: ` +
        `size-1 best net = ${net !== null ? formatPrice(net) : "unfillable"}`,
    );
  }
}

main();
