/**
 * Demo / verification script for issue #6.
 *
 * Read-only, no credentials. Builds a normalized BookSnapshot from a live Kalshi
 * book and a live Polymarket US book, validates each, and confirms lossless
 * round-trip serialization. Prints PASS/FAIL for the issue's verify items.
 *
 *   npm run snapshot
 */

import { isDeepStrictEqual } from "node:util";

import { fetchOrderbook, findLiveMarket } from "../kalshi/client.js";
import { toBookSnapshot as kalshiSnapshot } from "../kalshi/orderbook.js";
import { fetchBook, findOpenBinaryPair } from "../polymarket/client.js";
import { toBookSnapshot as pmSnapshot } from "../polymarket/orderbook.js";
import {
  assertValidSnapshot,
  deserializeSnapshot,
  serializeSnapshot,
} from "../snapshot.js";
import type { BookSnapshot } from "../snapshot.js";

let failures = 0;

function check(label: string, snap: BookSnapshot): void {
  console.log(
    `\n[${snap.venue} ${snap.side}] ${snap.marketId}` +
      `  bids=${snap.bids.length} asks=${snap.asks.length}` +
      ` bestBid=${snap.bids[0]?.price ?? "-"} bestAsk=${snap.asks[0]?.price ?? "-"}` +
      ` tsVenue=${snap.tsVenue ?? "-"}`,
  );
  try {
    assertValidSnapshot(snap);
    console.log(`  ${label} valid:        PASS`);
  } catch (e) {
    failures++;
    console.log(`  ${label} valid:        FAIL — ${e instanceof Error ? e.message : e}`);
  }
  const round = deserializeSnapshot(serializeSnapshot(snap));
  const ok = isDeepStrictEqual(snap, round);
  if (!ok) failures++;
  console.log(`  ${label} round-trips:  ${ok ? "PASS" : "FAIL"}`);
}

async function main(): Promise<void> {
  const ticker = await findLiveMarket();
  const raw = await fetchOrderbook(ticker);
  check("kalshi", kalshiSnapshot(ticker, raw, "yes", { tsLocalMs: Date.now() }));

  const pair = await findOpenBinaryPair();
  if (!pair) {
    console.log("\nNo open Polymarket US binary pair right now (markets may be halted).");
    console.log("Skipping the Polymarket leg; re-run during market hours.");
  } else {
    const yesBook = await fetchBook(pair.yesSlug);
    check("polymarket-us", pmSnapshot(yesBook, "yes", { tsLocalMs: Date.now(), seq: 1 }));
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
