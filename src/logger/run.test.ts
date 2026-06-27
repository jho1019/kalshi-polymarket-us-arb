import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedClient, FeedUpdate, FeedUpdateHandler, InstrumentRef } from "../feed/types.js";
import type { Side } from "../book.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
import type { MarketPair } from "../registry/schema.js";
import { readRecords, rawPath, oppsPath } from "../storage/jsonl.js";
import { runLogger } from "./run.js";

// Minimal FeedClient that lets the test push FeedUpdates synchronously.
class MockFeed implements FeedClient {
  private handlers: FeedUpdateHandler[] = [];
  async subscribe(_instruments: InstrumentRef[]): Promise<void> {}
  on(_event: "update", handler: FeedUpdateHandler): void { this.handlers.push(handler); }
  getSnapshot(_marketId: string, _side: Side): BookSnapshot | null { return null; }
  close(): void { this.handlers = []; }
  push(update: FeedUpdate): void { for (const h of this.handlers) h(update); }
}

function makeSnapshot(venue: Venue, marketId: string, side: Side, tsLocalMs = Date.now()): BookSnapshot {
  return { venue, marketId, side, tsLocalMs, bids: [], asks: [] };
}

describe("runLogger heartbeat", () => {
  it("logs a heartbeat line to console.log each tick", async () => {
    const lines: string[] = [];
    const logSpy = mock.method(console, "log", (...args: unknown[]) => { lines.push(String(args[0])); });
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));

    const { stop } = await runLogger({
      kalshiFeed: new MockFeed(),
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    stop();

    const heartbeats = lines.filter((l) => l.includes("[logger] heartbeat"));
    assert.ok(heartbeats.length >= 3, `expected ≥3 heartbeats, got ${heartbeats.length}`);
    // Each heartbeat should contain an ISO timestamp
    for (const h of heartbeats) assert.match(h, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    logSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });
});

describe("runLogger staleness alerting", () => {
  it("writes ALERT to console.error on first stale update from a venue", async () => {
    const errors: string[] = [];
    const errSpy = mock.method(console, "error", (...args: unknown[]) => { errors.push(String(args[0])); });
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });

    const alerts = errors.filter((e) => e.includes("ALERT"));
    assert.equal(alerts.length, 1, "exactly one ALERT expected");
    assert.ok(alerts[0]!.includes("kalshi"), "alert should name the venue");

    stop();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });

  it("does not emit a duplicate ALERT when a second stale update arrives for the same venue", async () => {
    const errors: string[] = [];
    const errSpy = mock.method(console, "error", (...args: unknown[]) => { errors.push(String(args[0])); });
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-NO",  "no"),  stale: true });

    const alerts = errors.filter((e) => e.includes("ALERT"));
    assert.equal(alerts.length, 1, "second stale event must not re-alert");

    stop();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });

  it("logs RECOVERED to console.log when a stale venue emits a non-stale update", async () => {
    const lines: string[] = [];
    const logSpy = mock.method(console, "log", (...args: unknown[]) => { lines.push(String(args[0])); });
    const errSpy  = mock.method(console, "error", () => {});
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: false });

    const recoveries = lines.filter((l) => l.includes("RECOVERED"));
    assert.equal(recoveries.length, 1, "exactly one RECOVERED expected");
    assert.ok(recoveries[0]!.includes("kalshi"), "recovery should name the venue");

    stop();
    logSpy.mock.restore();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });

  it("does not emit RECOVERED while a second instrument for the venue is still stale", async () => {
    const lines: string[] = [];
    const logSpy = mock.method(console, "log", (...args: unknown[]) => { lines.push(String(args[0])); });
    const errSpy  = mock.method(console, "error", () => {});
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const kalshiFeed = new MockFeed();

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed: new MockFeed(),
      pairs: [],
      dataDir: tmpDir,
      intervalMs: 10_000,
    });

    // Two instruments on the same venue go stale
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: true });
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-NO",  "no"),  stale: true });
    // One recovers — the other is still stale, so RECOVERED must NOT fire
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TICKER-YES", "yes"), stale: false });

    const recoveries = lines.filter((l) => l.includes("RECOVERED"));
    assert.equal(recoveries.length, 0, "RECOVERED must not fire while another instrument is still stale");

    stop();
    logSpy.mock.restore();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });
});

describe("runLogger stale opp exclusion", () => {
  it("writes raw capture but skips opp when a leg is stale", async () => {
    const logSpy = mock.method(console, "log", () => {});
    const errSpy = mock.method(console, "error", () => {});
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const fixedMs = 1_700_000_000_000; // 2023-11-14, arbitrary fixed timestamp

    const kalshiFeed = new MockFeed();
    const pmFeed = new MockFeed();

    // Minimal loggable pair (settlementSourceMatch + settlementTimeMatch + strikeMatch = true)
    const testPair: MarketPair = {
      pairId: "test-pair",
      description: "Test pair",
      kalshi: { ticker: "TEST-TICKER", yesSide: "yes" },
      polymarketUs: { kind: "dualSlug", yesSlug: "test-yes", noSlug: "test-no" },
      settlementSourceMatch: true,
      settlementTimeMatch: true,
      strikeMatch: true,
      resolutionVerified: false,
      verifiedDate: "2026-06-27",
    };

    const { stop } = await runLogger({
      kalshiFeed,
      pmFeed,
      pairs: [testPair],
      dataDir: tmpDir,
      intervalMs: 20,
      now: () => fixedMs,
    });

    // Seed cache: kalshi stale, pm fresh — both legs have data so buildCaptureRecord returns non-null
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TEST-TICKER", "yes"), stale: true });
    kalshiFeed.push({ snapshot: makeSnapshot("kalshi", "TEST-TICKER", "no"),  stale: true });
    pmFeed.push({ snapshot: makeSnapshot("polymarket-us", "test-yes", "yes"), stale: false });
    pmFeed.push({ snapshot: makeSnapshot("polymarket-us", "test-no",  "no"),  stale: false });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    stop();

    const date = new Date(fixedMs).toISOString().slice(0, 10);
    const rawRecords = readRecords(rawPath(tmpDir, date));
    const oppRecords = readRecords(oppsPath(tmpDir, date));

    assert.ok(rawRecords.length >= 1, "raw capture should be written even when stale");
    assert.equal(oppRecords.length, 0, "opp must not be written when a leg is stale");

    logSpy.mock.restore();
    errSpy.mock.restore();
    rmSync(tmpDir, { recursive: true });
  });
});
