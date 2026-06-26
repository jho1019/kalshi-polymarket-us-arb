import { test } from "node:test";
import assert from "node:assert/strict";
import { KalshiLiveBook } from "./live-book.js";

function fresh(tsLocalMs = 1000): KalshiLiveBook {
  const b = new KalshiLiveBook("TEST-TICKER");
  b.applySnapshot(
    {
      market_ticker: "TEST-TICKER",
      yes_dollars_fp: [["0.6000", "10.00"]],
      no_dollars_fp: [["0.3500", "20.00"]],
    },
    1,
    tsLocalMs,
  );
  return b;
}

test("snapshot then delta updates the YES bid book", () => {
  const b = fresh();
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    2,
    2000,
  );
  assert.equal(gap, false);
  const yes = b.toSnapshot("yes");
  assert.deepEqual(yes.bids, [{ price: 6000, qty: 150000 }]); // 10 + 5 = 15.0000
  assert.equal(yes.seq, 2);
});

test("delta to zero removes the level", () => {
  const b = fresh();
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.3500", delta_fp: "-20.00", side: "no" },
    2,
    2000,
  );
  assert.deepEqual(b.toSnapshot("no").bids, []);
});

test("seq gap is reported and leaves the book unchanged", () => {
  const b = fresh();
  const before = b.toSnapshot("yes");
  const gap = b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    5, // skipped 2..4
    9999,
  );
  assert.equal(gap, true);
  assert.deepEqual(b.toSnapshot("yes").bids, before.bids);
});

test("snapshot with only no_dollars_fp (missing yes_dollars_fp) does not throw", () => {
  const b = new KalshiLiveBook("TEST");
  const msg = {
    market_ticker: "TEST",
    no_dollars_fp: [["0.0100", "289658.00"], ["0.0200", "15.00"]],
  } as unknown as import("./live-book.js").KalshiSnapshotMsg;
  assert.doesNotThrow(() => b.applySnapshot(msg, 1, 1000));
  assert.deepEqual(b.toSnapshot("yes").bids, []);
  const noSnap = b.toSnapshot("no");
  assert.ok(noSnap.bids.length > 0, "NO bids should be non-empty");
  assert.equal(noSnap.bids[0]?.price, 200); // 0.0200 best NO bid → 200 units
});

test("toSnapshot stamps tsLocalMs from the last applied update", () => {
  const b = fresh(1000);
  assert.equal(b.toSnapshot("yes").tsLocalMs, 1000);
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    2,
    2500,
  );
  assert.equal(b.toSnapshot("yes").tsLocalMs, 2500);
  assert.equal(b.lastUpdateMs, 2500);
});

test("a seq gap does not advance lastUpdateMs", () => {
  const b = fresh(1000);
  b.applyDelta(
    { market_ticker: "TEST-TICKER", price_dollars: "0.6000", delta_fp: "5.00", side: "yes" },
    7, // gap
    8000,
  );
  assert.equal(b.lastUpdateMs, 1000); // unchanged
  assert.equal(b.toSnapshot("yes").tsLocalMs, 1000);
});

test("toSnapshot before any update throws; lastUpdateMs is null", () => {
  const b = new KalshiLiveBook("TEST");
  assert.equal(b.lastUpdateMs, null);
  assert.throws(() => b.toSnapshot("yes"), /before any update/);
});

test("reset clears lastUpdateMs", () => {
  const b = fresh(1000);
  b.reset();
  assert.equal(b.lastUpdateMs, null);
  assert.throws(() => b.toSnapshot("yes"));
});
