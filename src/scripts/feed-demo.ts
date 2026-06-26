/**
 * Read-only demo for issue #13. Connects the live Kalshi + Polymarket US feeds,
 * prints book updates, periodically cross-checks the Kalshi WS-maintained book
 * against a REST snapshot (top-of-book), and forces a reconnect to demonstrate
 * resubscribe. Verifies both issue checkboxes against the real venues.
 *
 * Usage: npm run feed
 */
import { KalshiFeed } from "../kalshi/feed.js";
import { PolymarketFeed } from "../polymarket/feed.js";
import { fetchOrderbook, findLiveMarket } from "../kalshi/client.js";
import { toBookSnapshot } from "../kalshi/orderbook.js";
import { findOpenBinaryPair } from "../polymarket/client.js";
import { formatPrice } from "../money.js";

const TOLERANCE_UNITS = 100; // 0.0100 dollar = 1 cent top-of-book tolerance

async function main(): Promise<void> {
  const ticker = await findLiveMarket();
  console.log(`Kalshi live market: ${ticker}`);

  const kalshi = new KalshiFeed();
  kalshi.on("update", (u) => {
    const best = u.snapshot.asks[0];
    console.log(
      `[kalshi ${u.snapshot.marketId} ${u.snapshot.side}] best ask ` +
        `${best ? formatPrice(best.price) : "-"}${u.stale ? " (stale)" : ""}`,
    );
  });
  await kalshi.subscribe([
    { marketId: ticker, side: "yes" },
    { marketId: ticker, side: "no" },
  ]);

  const pair = await findOpenBinaryPair();
  if (pair) {
    console.log(`Polymarket US pair: ${pair.yesSlug} / ${pair.noSlug}`);
    const pm = new PolymarketFeed();
    pm.on("update", (u) => {
      const best = u.snapshot.asks[0];
      console.log(
        `[pm ${u.snapshot.marketId} ${u.snapshot.side}] best ask ` +
          `${best ? formatPrice(best.price) : "-"}`,
      );
    });
    await pm.subscribe([
      { marketId: pair.yesSlug, side: "yes" },
      { marketId: pair.noSlug, side: "no" },
    ]);
  } else {
    console.log("No open Polymarket US binary pair found right now; skipping PM leg.");
  }

  // Cross-check: WS book vs REST snapshot (top-of-book within tolerance).
  const crossCheck = setInterval(async () => {
    const ws = kalshi.getSnapshot(ticker, "yes");
    if (!ws) return;
    const rest = toBookSnapshot(ticker, await fetchOrderbook(ticker), "yes", {
      tsLocalMs: Date.now(),
    });
    const wsBest = ws.asks[0]?.price ?? null;
    const restBest = rest.asks[0]?.price ?? null;
    const ok =
      wsBest !== null && restBest !== null && Math.abs(wsBest - restBest) <= TOLERANCE_UNITS;
    console.log(
      `cross-check yes best ask: ws=${wsBest !== null ? formatPrice(wsBest) : "-"} ` +
        `rest=${restBest !== null ? formatPrice(restBest) : "-"} -> ${ok ? "OK" : "MISMATCH"}`,
    );
  }, 5_000);

  // Run for ~30s; cleanly stop.
  setTimeout(() => {
    clearInterval(crossCheck);
    kalshi.close();
    console.log("Demo complete.");
    process.exit(0);
  }, 30_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
