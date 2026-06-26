import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, constants, type KeyObject } from "node:crypto";
import { signWsRequest, buildKalshiAuthHeaders } from "./auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }) as {
  privateKey: KeyObject;
  publicKey: KeyObject;
};
const pem = String(privateKey.export({ type: "pkcs1", format: "pem" }));

test("signWsRequest produces a base64 RSA-PSS signature that verifies", () => {
  const ts = 1703123456789;
  const sig = signWsRequest(pem, ts, "GET", "/orderbook_delta");
  const verifier = createVerify("sha256");
  verifier.update(`${ts}GET/orderbook_delta`);
  verifier.end();
  const ok: boolean = verifier.verify(
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
    sig,
    "base64",
  ) as boolean;
  assert.equal(ok, true);
});

test("buildKalshiAuthHeaders sets the three required headers", () => {
  const h = buildKalshiAuthHeaders("key-123", pem, "GET", "/orderbook_delta");
  assert.equal(h["KALSHI-ACCESS-KEY"], "key-123");
  assert.match(h["KALSHI-ACCESS-TIMESTAMP"] ?? "", /^\d+$/);
  assert.ok((h["KALSHI-ACCESS-SIGNATURE"] ?? "").length > 0);
});
