import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomUUID } from "node:crypto";

const encoder = new TextEncoder();

export interface SignedHeaders {
  "X-API-Wallet-Public-Key": string;
  "X-API-Wallet-Signature": string;
  "X-API-Wallet-Timestamp": string;
  "X-API-Wallet-Nonce": string;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Strike accepts a 32-byte seed or a 64-byte expanded key; only the seed signs. */
export function normalizePrivateKey(privateKeyHex: string): Uint8Array {
  const bytes = Buffer.from(privateKeyHex, "hex");
  return new Uint8Array(bytes.length === 64 ? bytes.subarray(0, 32) : bytes);
}

/**
 * Message format from the Strike docs:
 *   {METHOD}:{PATH_WITH_QUERY}:{UNIX_SECONDS}:{UUID_NONCE}:{SHA256_HEX(BODY)}
 * The body must be the exact string sent on the wire ("" for GET).
 */
export function buildSignatureMessage(
  method: string,
  pathWithQuery: string,
  timestamp: number,
  nonce: string,
  body: string,
): string {
  const bodyHash = toHex(sha256(encoder.encode(body)));
  return `${method.toUpperCase()}:${pathWithQuery}:${timestamp}:${nonce}:${bodyHash}`;
}

export async function signRequest(
  privateKeyHex: string,
  publicKeyHex: string,
  method: string,
  pathWithQuery: string,
  body = "",
  now: () => number = Date.now,
): Promise<SignedHeaders> {
  const timestamp = Math.floor(now() / 1000);
  const nonce = randomUUID();
  const message = buildSignatureMessage(method, pathWithQuery, timestamp, nonce, body);
  const signature = await ed.signAsync(encoder.encode(message), normalizePrivateKey(privateKeyHex));
  return {
    "X-API-Wallet-Public-Key": publicKeyHex,
    "X-API-Wallet-Signature": toHex(signature),
    "X-API-Wallet-Timestamp": String(timestamp),
    "X-API-Wallet-Nonce": nonce,
  };
}

/** Generates a fresh API wallet key pair (raw hex), for `strike-mcp keygen`. */
export async function generateKeyPair(): Promise<{ privateKeyHex: string; publicKeyHex: string }> {
  const secret = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(secret);
  return { privateKeyHex: toHex(secret), publicKeyHex: toHex(pub) };
}
