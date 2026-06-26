/**
 * Load read-only feed credentials from `.env` (gitignored). NEVER log secret
 * values. These keys are full-access; collection code must only use them for
 * market-data feeds (no `orders.*`). See CLAUDE.md safety rules.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

export interface KalshiCredentials {
  keyId: string;
  privateKeyPem: string;
}

export interface PolymarketCredentials {
  keyId: string;
  secretKey: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export function loadKalshiCredentials(): KalshiCredentials {
  const keyId = required("KALSHI_API_KEY_ID");
  const pemPath = required("KALSHI_PRIVATE_KEY_PATH");
  try {
    return { keyId, privateKeyPem: readFileSync(pemPath, "utf8") };
  } catch (err) {
    throw new Error(
      `Cannot read KALSHI_PRIVATE_KEY_PATH=${pemPath}: ${(err as Error).message}`,
    );
  }
}

export function loadPolymarketCredentials(): PolymarketCredentials {
  return {
    keyId: required("POLYMARKET_KEY_ID"),
    secretKey: required("POLYMARKET_SECRET_KEY"),
  };
}
