/**
 * Append-only JSONL storage: one JSON record per line. A missing final newline
 * is harmless; a torn JSON line would throw on re-read — acceptable for this
 * single-process, non-adversarial logger. Survives restarts because it is just
 * a file. Records must be JSON-native (the project's money/time are integers,
 * so (de)serialization is lossless).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append one record as a JSON line, creating parent directories as needed. */
export function appendRecord(filePath: string, record: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(record) + "\n");
}

/** Read all records from a JSONL file (missing file → []). */
export function readRecords(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** Date-partitioned path for RAW capture records. */
export function rawPath(dataDir: string, date: string): string {
  return `${dataDir}/raw/${date}.jsonl`;
}

/** Date-partitioned path for computed opportunity records. */
export function oppsPath(dataDir: string, date: string): string {
  return `${dataDir}/opps/${date}.jsonl`;
}
