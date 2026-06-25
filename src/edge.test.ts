/**
 * Unit tests for the cross-venue net-edge calculator (issue #10).
 *
 * Synthetic books with known prices; real Kalshi (0.07) and PM US (0.05) taker
 * fees. Prices/net in 1/10000-$ units; a whole contract is QTY_SCALE qty units.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Level } from "./book.js";
import { netEdge } from "./edge.js";
import type { VenueLeg } from "./edge.js";
import { takerFee as kalshiTakerFee } from "./kalshi/fees.js";
import { PRICE_SCALE, QTY_SCALE } from "./money.js";
import { takerFee as pmTakerFee } from "./polymarket/fees.js";

const lvl = (price: number, contracts: number): Level => ({
  price,
  qty: contracts * QTY_SCALE,
});

const kalshiLeg = (yesAsks: Level[], noAsks: Level[]): VenueLeg => ({
  name: "kalshi",
  yesAsks,
  noAsks,
  fee: (p, q) => kalshiTakerFee(p, q),
});

const pmLeg = (yesAsks: Level[], noAsks: Level[]): VenueLeg => ({
  name: "polymarket-us",
  yesAsks,
  noAsks,
  fee: (p, q) => pmTakerFee(p, q),
});

test("hand calc: both strategies' net incl. both fees", () => {
  const a = kalshiLeg([lvl(4000, 1000)], [lvl(5500, 1000)]);
  const b = pmLeg([lvl(4800, 1000)], [lvl(4800, 1000)]);
  const { perSize } = netEdge(a, b, [1]);
  const row = perSize[0]!;

  // S1 = YES@kalshi(4000) + NO@pm(4800): fees 168 (kalshi) + 125 (pm)
  assert.equal(row.s1.strategy, "YES@kalshi+NO@polymarket-us");
  assert.equal(row.s1.costYes, 4000);
  assert.equal(row.s1.costNo, 4800);
  assert.equal(row.s1.feeYes, 168);
  assert.equal(row.s1.feeNo, 125);
  assert.equal(row.s1.netPerContract, PRICE_SCALE - 4000 - 4800 - 168 - 125); // 907

  // S2 = YES@pm(4800) + NO@kalshi(5500): fees 125 (pm) + 174 (kalshi)
  assert.equal(row.s2.strategy, "YES@polymarket-us+NO@kalshi");
  assert.equal(row.s2.netPerContract, PRICE_SCALE - 4800 - 5500 - 125 - 174); // -599

  assert.deepEqual(row.best, { strategy: row.s1.strategy, netPerContract: 907 });
});

test("gross-positive but fee-negative is reported as no-arb", () => {
  const a = kalshiLeg([lvl(4950, 1000)], [lvl(5100, 1000)]);
  const b = pmLeg([lvl(5100, 1000)], [lvl(4990, 1000)]);
  const { perSize, maxProfitableSize } = netEdge(a, b, [1]);
  const s1 = perSize[0]!.s1;

  const gross = PRICE_SCALE - s1.costYes! - s1.costNo!;
  assert.ok(gross > 0, "gross edge should be positive before fees");
  assert.ok(s1.netPerContract! < 0, "net should be negative after fees");
  assert.ok((perSize[0]!.best?.netPerContract ?? 0) <= 0);
  assert.equal(maxProfitableSize, null);
});

test("picks the more profitable strategy (S2 wins)", () => {
  const a = kalshiLeg([lvl(5500, 1000)], [lvl(4000, 1000)]);
  const b = pmLeg([lvl(4000, 1000)], [lvl(4800, 1000)]);
  const { perSize } = netEdge(a, b, [1]);
  const row = perSize[0]!;

  // S2 = YES@pm(4000) + NO@kalshi(4000): fees 120 (pm) + 168 (kalshi) -> 1712
  assert.equal(row.best?.strategy, "YES@polymarket-us+NO@kalshi");
  assert.equal(row.best?.netPerContract, PRICE_SCALE - 4000 - 4000 - 120 - 168);
});

test("depth limit: larger size unfillable, maxProfitableSize is the threshold", () => {
  const a = kalshiLeg([lvl(4000, 50)], [lvl(4000, 50)]);
  const b = pmLeg([lvl(4000, 50)], [lvl(4000, 50)]);
  const { perSize, maxProfitableSize } = netEdge(a, b, [50, 100]);

  assert.equal(perSize[0]!.sizeContracts, 50);
  assert.ok((perSize[0]!.best?.netPerContract ?? 0) > 0, "50 is profitable");

  const big = perSize[1]!;
  assert.equal(big.sizeContracts, 100);
  assert.equal(big.s1.fillable, false);
  assert.equal(big.s1.costYes, null);
  assert.equal(big.s1.netPerContract, null);
  assert.equal(big.best, null);

  assert.equal(maxProfitableSize, 50);
});

test("multi-level fill feeds weighted-avg cost into fee-on-avg", () => {
  // YES@kalshi spans two levels: 10@4000 + 10@4200 over 20 -> avg 4100.
  const a = kalshiLeg([lvl(4000, 10), lvl(4200, 10)], [lvl(4000, 1000)]);
  const b = pmLeg([lvl(4000, 1000)], [lvl(4500, 1000)]);
  const { perSize } = netEdge(a, b, [20]);
  const s1 = perSize[0]!.s1;

  assert.equal(s1.costYes, 4100); // weighted average price
  assert.equal(s1.costNo, 4500); // NO@pm
  assert.equal(s1.feeYes, kalshiTakerFee(4100, QTY_SCALE));
  assert.equal(s1.feeNo, pmTakerFee(4500, QTY_SCALE));
  assert.equal(
    s1.netPerContract,
    PRICE_SCALE - 4100 - 4500 - kalshiTakerFee(4100, QTY_SCALE) - pmTakerFee(4500, QTY_SCALE),
  );
});

test("default sizes are [1,5,10,25,50,100]", () => {
  const a = kalshiLeg([lvl(4000, 1000)], [lvl(4000, 1000)]);
  const b = pmLeg([lvl(4000, 1000)], [lvl(4000, 1000)]);
  const { perSize } = netEdge(a, b);
  assert.deepEqual(
    perSize.map((r) => r.sizeContracts),
    [1, 5, 10, 25, 50, 100],
  );
});
