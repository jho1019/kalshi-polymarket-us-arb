import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedClient, FeedUpdate, FeedUpdateHandler, InstrumentRef } from "../feed/types.js";
import type { Side } from "../book.js";
import type { BookSnapshot, Venue } from "../snapshot.js";
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

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
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
});
