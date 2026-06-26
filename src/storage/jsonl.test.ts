import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords, rawPath, oppsPath } from "./jsonl.js";

test("appendRecord then readRecords round-trips multiple records (and creates the dir)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
  try {
    const p = join(dir, "sub", "x.jsonl"); // nested dir must be auto-created
    appendRecord(p, { a: 1 });
    appendRecord(p, { a: 2, b: [3, 4] });
    assert.deepEqual(readRecords(p), [{ a: 1 }, { a: 2, b: [3, 4] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecords on a missing file returns []", () => {
  assert.deepEqual(readRecords(join(tmpdir(), "definitely-missing-12345.jsonl")), []);
});

test("records persist across a re-read (simulated restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
  try {
    const p = join(dir, "data.jsonl");
    appendRecord(p, { n: 1 });
    const rereadAfterFirstRun = readRecords(p); // a fresh process reading the same file
    appendRecord(p, { n: 2 });
    assert.deepEqual(rereadAfterFirstRun, [{ n: 1 }]);
    assert.deepEqual(readRecords(p), [{ n: 1 }, { n: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path helpers partition by date", () => {
  assert.equal(rawPath("data", "2026-06-26"), "data/raw/2026-06-26.jsonl");
  assert.equal(oppsPath("data", "2026-06-26"), "data/opps/2026-06-26.jsonl");
});
