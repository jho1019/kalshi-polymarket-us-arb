/**
 * Demo / verification script for issue #5.
 *
 * Read-only, no credentials. Confirms a live public book, prints the raw YES and
 * NO books, the best price to buy each side, a proof that buy-NO ask != (1 - YES
 * bid) past top of book, and executable cost for increasing sizes.
 *
 *   npm run pm-book -- <yesSlug> <noSlug> [sizeContracts]
 *
 * With no slugs it defaults to a known live binary pair.
 */

import { PRICE_SCALE, QTY_SCALE, formatFixed, formatPrice, formatQty, parsePrice } from "../money.js";
import { fetchBook, findOpenBinaryPair, hasCredentials } from "../polymarket/client.js";
import type { RawPmLevel } from "../polymarket/client.js";
import {
  asksForBuying,
  bestAsk,
  costToBuy,
  normalize,
} from "../polymarket/orderbook.js";
import type { PmBook } from "../polymarket/orderbook.js";
import type { Side } from "../book.js";

const COST_SCALE = 100_000_000; // totalCost units: price(1/1e4 $) * qty(1/1e4 contract)

function fmtLevels(levels: RawPmLevel[]): string {
  return (
    levels
      .slice(0, 5)
      .map((l) => `$${l.px.value}x${l.qty}`)
      .join(" ") || "(none)"
  );
}

function totalAvailableQty(book: PmBook, side: Side): number {
  return asksForBuying(book, side).reduce((sum, l) => sum + l.qty, 0);
}

function reportSide(book: PmBook, side: Side, baseSizes: number[]): void {
  console.log(`\n--- BUY ${side.toUpperCase()} ---`);
  const best = bestAsk(book, side);
  console.log(`best ask: ${best === null ? "(no liquidity)" : "$" + formatPrice(best)}`);

  const availContracts = Math.ceil(totalAvailableQty(book, side) / QTY_SCALE);
  const deepFillable = Math.floor(availContracts * 0.9);
  const sizes = [...baseSizes, deepFillable, availContracts + 1].filter((s) => s > 0);

  for (const contracts of sizes) {
    const fill = costToBuy(book, side, contracts * QTY_SCALE);
    const avg = fill.avgCost === null ? "n/a" : "$" + formatPrice(fill.avgCost);
    const tag = fill.fillable ? "FILLABLE" : "UNFILLABLE";
    console.log(
      `  size ${String(contracts).padStart(8)} contracts -> ${tag.padEnd(10)} ` +
        `avg ${avg.padStart(9)}  total $${formatFixed(fill.totalCost, COST_SCALE)}  ` +
        `filled ${formatQty(fill.filledSize)}  levels ${fill.levelsConsumed}`,
    );
  }
}

async function main(): Promise<void> {
  const baseSize = process.argv[4] ? Number(process.argv[4]) : undefined;
  if (baseSize !== undefined && (!Number.isFinite(baseSize) || baseSize <= 0)) {
    throw new Error(`invalid size argument: ${process.argv[4]}`);
  }

  let yesSlug = process.argv[2];
  let noSlug = process.argv[3];
  if (!yesSlug || !noSlug) {
    console.log("No slug pair given — auto-discovering a live binary pair...");
    const pair = await findOpenBinaryPair();
    if (!pair) {
      throw new Error(
        "No open binary market pair found right now (PM US markets may be halted). " +
          "Pass slugs explicitly: npm run pm-book -- <yesSlug> <noSlug> [size]",
      );
    }
    yesSlug = pair.yesSlug;
    noSlug = pair.noSlug;
  }

  console.log(`Client credentials present: ${hasCredentials} (expected: false)`);
  console.log(`YES slug: ${yesSlug}\nNO  slug: ${noSlug}`);

  const yesRaw = await fetchBook(yesSlug);
  const noRaw = await fetchBook(noSlug);
  console.log(`\nbook state: YES=${yesRaw.state} NO=${noRaw.state}`);

  console.log("\n=== raw offers (asks to BUY each side), top 5 ===");
  console.log("YES offers:", fmtLevels(yesRaw.offers));
  console.log("NO  offers:", fmtLevels(noRaw.offers));

  const book = normalize({ yesSlug, noSlug }, yesRaw.offers, noRaw.offers);

  // Proof: buy-NO ask is NOT (1 - best YES bid) beyond top of book.
  console.log("\n=== buy-NO ask  vs  (1 - YES bid) — diverge past L1 ===");
  const realNoAsks = asksForBuying(book, "no");
  for (let i = 0; i < Math.min(3, yesRaw.bids.length, realNoAsks.length); i++) {
    const inferred = PRICE_SCALE - parsePrice(yesRaw.bids[i]!.px.value);
    const real = realNoAsks[i]!.price;
    console.log(
      `  L${i + 1}: real NO ask $${formatPrice(real)}  vs  inferred (1 - YES bid) $${formatPrice(inferred)}` +
        `${real === inferred ? "" : "   <-- DIFFERS"}`,
    );
  }

  const baseSizes = baseSize !== undefined ? [baseSize] : [10, 100, 1000];
  reportSide(book, "yes", baseSizes);
  reportSide(book, "no", baseSizes);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
