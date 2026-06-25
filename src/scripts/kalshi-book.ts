/**
 * Demo / verification script for issue #4.
 *
 * Read-only, no credentials. Prints the raw book for a live market, the
 * normalized bids, the best price to buy each side, and executable cost for
 * increasing sizes (showing avg cost rise + an oversized "unfillable" result).
 *
 *   npm run book -- <ticker> [sizeContracts]
 *
 * With no ticker it auto-picks the first market with a non-empty book from a
 * few known-liquid series.
 */

import { KALSHI_API_BASE } from "../config.js";
import { QTY_SCALE, formatFixed, formatPrice, formatQty } from "../money.js";
import { fetchOrderbook } from "../kalshi/client.js";
import {
  asksForBuying,
  bestAsk,
  costToBuy,
  normalize,
} from "../kalshi/orderbook.js";
import type { Book, Side } from "../kalshi/types.js";

const COST_SCALE = 100_000_000; // totalCost units: price(1/1e4 $) * qty(1/1e4 contract)
const CANDIDATE_SERIES = ["KXBTCD", "KXETHD", "KXBTC"];

async function fetchMarkets(seriesTicker: string): Promise<string[]> {
  const url = new URL(`${KALSHI_API_BASE}/markets`);
  url.searchParams.set("series_ticker", seriesTicker);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "50");
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as { markets?: { ticker: string }[] };
  return (json.markets ?? []).map((m) => m.ticker);
}

/** Find a live market that currently has a non-empty book. */
async function findLiveMarket(): Promise<string> {
  for (const series of CANDIDATE_SERIES) {
    for (const ticker of await fetchMarkets(series)) {
      const raw = await fetchOrderbook(ticker, 5);
      const { yes_dollars, no_dollars } = raw.orderbook_fp;
      if (yes_dollars.length > 0 || no_dollars.length > 0) return ticker;
    }
  }
  throw new Error(
    "Could not auto-find a market with a non-empty book; pass a ticker explicitly.",
  );
}

function totalAvailableQty(book: Book, side: Side): number {
  return asksForBuying(book, side).reduce((sum, l) => sum + l.qty, 0);
}

function reportSide(book: Book, side: Side, baseSizes: number[]): void {
  console.log(`\n--- BUY ${side.toUpperCase()} ---`);
  const best = bestAsk(book, side);
  console.log(`best ask: ${best === null ? "(no liquidity)" : "$" + formatPrice(best)}`);

  const availContracts = Math.ceil(totalAvailableQty(book, side) / QTY_SCALE);
  // A deep-but-fillable size (crosses levels, so avg cost visibly rises) and an
  // oversized request 1 contract beyond all depth (-> unfillable).
  const deepFillable = Math.floor(availContracts * 0.9);
  const sizes = [...baseSizes, deepFillable, availContracts + 1].filter(
    (s) => s > 0,
  );

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
  const ticker = process.argv[2] ?? (await findLiveMarket());
  const baseSize = process.argv[3] ? Number(process.argv[3]) : undefined;
  if (baseSize !== undefined && (!Number.isFinite(baseSize) || baseSize <= 0)) {
    throw new Error(`invalid size argument: ${process.argv[3]}`);
  }

  console.log(`Market: ${ticker}`);
  const raw = await fetchOrderbook(ticker);

  console.log("\n=== raw orderbook_fp ===");
  console.log(JSON.stringify(raw.orderbook_fp, null, 2));

  const book = normalize(ticker, raw);
  console.log("\n=== normalized bids (price x qty) ===");
  console.log(
    "YES bids:",
    book.yesBids.map((l) => `$${formatPrice(l.price)}x${formatQty(l.qty)}`).join(" ") || "(none)",
  );
  console.log(
    "NO  bids:",
    book.noBids.map((l) => `$${formatPrice(l.price)}x${formatQty(l.qty)}`).join(" ") || "(none)",
  );

  const baseSizes = baseSize !== undefined ? [baseSize] : [10, 100, 1000];
  reportSide(book, "yes", baseSizes);
  reportSide(book, "no", baseSizes);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
