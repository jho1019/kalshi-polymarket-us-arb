import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKalshiCredentials, loadPolymarketCredentials } from "./credentials.js";

test("loadPolymarketCredentials throws a helpful error when unset", () => {
  const prev = { ...process.env };
  delete process.env.POLYMARKET_KEY_ID;
  delete process.env.POLYMARKET_SECRET_KEY;
  assert.throws(() => loadPolymarketCredentials(), /POLYMARKET_KEY_ID/);
  process.env = prev;
});

test("loadKalshiCredentials throws when the PEM path is missing", () => {
  const prev = { ...process.env };
  process.env.KALSHI_API_KEY_ID = "k";
  process.env.KALSHI_PRIVATE_KEY_PATH = "/no/such/file.pem";
  assert.throws(() => loadKalshiCredentials(), /KALSHI_PRIVATE_KEY_PATH/);
  process.env = prev;
});
