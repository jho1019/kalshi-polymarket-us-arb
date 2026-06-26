/**
 * Kalshi authenticated-request signing (used for the WebSocket handshake).
 *
 * Scheme (docs.kalshi.com): sign `timestampMs + METHOD + path` with RSA-PSS
 * over SHA-256 (MGF1/SHA-256, salt length = digest length), base64-encoded.
 * Headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE.
 *
 * READ-ONLY: this module only signs; it places no orders.
 */
import { createSign, constants } from "node:crypto";

/** Sign `${timestampMs}${method}${path}` with RSA-PSS/SHA-256, base64. */
export function signWsRequest(
  privateKeyPem: string,
  timestampMs: number,
  method: string,
  path: string,
): string {
  const signer = createSign("sha256");
  signer.update(`${timestampMs}${method}${path}`);
  signer.end();
  return signer.sign(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );
}

/** Build the three Kalshi auth headers for a handshake at `path`. */
export function buildKalshiAuthHeaders(
  keyId: string,
  privateKeyPem: string,
  method: string,
  path: string,
): Record<string, string> {
  const timestampMs = Date.now();
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
    "KALSHI-ACCESS-SIGNATURE": signWsRequest(privateKeyPem, timestampMs, method, path),
  };
}
