import { test } from "node:test";
import assert from "node:assert/strict";
import { KalshiLiveBook } from "./live-book.js";

function fresh(): KalshiLiveBook {
  const b = new KalshiLiveBook("TEST-TICKER");
  b.applySnapshot(
    {
      market_ticker: "TEST-TICKER",
      yes_dollars_fp: [["0.6000", "10.00"]],
      no_dollars_fp: [["0.3500", "20.00"]],
    },
    1,
  );
  return b;
}

test("snapshot then delta updates the YES bid book", () => {
  const b = fresh();
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    2,
  );
  assert.equal(gap, false);
  // YES snapshot: bids are the real YES bids; asks = 1 - NO bids.
  const yes = b.toSnapshot("yes", { tsLocalMs: 1000 });
  assert.deepEqual(yes.bids, [{ price: 6000, qty: 150000 }]); // 10 + 5 = 15.0000
  assert.equal(yes.seq, 2);
});

test("delta to zero removes the level", () => {
  const b = fresh();
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.3500", delta_fp: "-20.00", side: "no" },
    2,
  );
  const no = b.toSnapshot("no", { tsLocalMs: 1000 });
  assert.deepEqual(no.bids, []);
});

test("seq gap is reported and leaves the book unchanged", () => {
  const b = fresh();
  const before = b.toSnapshot("yes", { tsLocalMs: 1 });
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    5, // skipped 2..4
  );
  assert.equal(gap, true);
  const after = b.toSnapshot("yes", { tsLocalMs: 2 });
  assert.deepEqual(after.bids, before.bids);
});
