/**
 * Read-only logger demo (issue #15): log the reviewed registry pairs' raw books
 * and computed opportunities to data/ for ~30s, then stop. No order placement.
 *
 * Usage: npm run log
 */
import { KalshiFeed } from "../kalshi/feed.js";
import { PolymarketFeed } from "../polymarket/feed.js";
import { PAIRS } from "../registry/pairs.js";
import { getLoggablePairs } from "../registry/schema.js";
import { runLogger } from "../logger/run.js";

async function main(): Promise<void> {
  const loggable = getLoggablePairs(PAIRS);
  if (loggable.length === 0) {
    console.log("No loggable (reviewed) pairs in the registry; nothing to log.");
    return;
  }
  console.log(`Logging ${loggable.length} reviewed pair(s): ${loggable.map((p) => p.pairId).join(", ")}`);

  const { stop } = await runLogger({
    kalshiFeed: new KalshiFeed(),
    pmFeed: new PolymarketFeed(),
    pairs: PAIRS,
    dataDir: "data",
    intervalMs: 1_000,
  });

  const runMs = 30_000;
  console.log(`Appending to data/raw and data/opps for ${runMs / 1000}s...`);
  setTimeout(() => {
    stop();
    console.log("Logger stopped.");
    process.exit(0);
  }, runMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
