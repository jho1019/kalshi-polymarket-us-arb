import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignedQty, parseSignedFixed, QTY_SCALE } from "./money.js";

test("parseSignedQty parses a negative fixed-point quantity", () => {
  assert.equal(parseSignedQty("-54.00"), -540000);
});

test("parseSignedQty parses a positive fixed-point quantity", () => {
  assert.equal(parseSignedQty("54.00"), 540000);
});

test("parseSignedFixed leaves zero non-negative", () => {
  assert.equal(parseSignedFixed("-0.00", QTY_SCALE), 0);
  assert.ok(!Object.is(parseSignedFixed("-0.00", QTY_SCALE), -0));
});

test("parseSignedFixed rejects malformed input", () => {
  assert.throws(() => parseSignedFixed("--1", QTY_SCALE));
});
