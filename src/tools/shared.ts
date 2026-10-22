import { z } from "zod";
import { StrikeApiError, type Query } from "../client.js";
import type { Config } from "../config.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function ok(data: unknown, note?: string): ToolResult {
  const payload = (data && typeof data === "object" && !Array.isArray(data) ? data : { result: data }) as Record<
    string,
    unknown
  >;
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text: note ? `${note}\n\n${text}` : text }],
    structuredContent: payload,
  };
}

export function fail(err: unknown): ToolResult {
  let message: string;
  if (err instanceof StrikeApiError) {
    message = err.message;
    if (err.status === 401) message += "\nHint: check the API wallet keys, that the key is active, and the system clock (±3 min).";
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wraps a handler so thrown errors come back as MCP tool errors the model can read. */
export function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export const symbolSchema = z
  .string()
  .min(1)
  .transform((s) => s.trim().toUpperCase())
  .describe("Market symbol, e.g. BTC-USD, ETH-USD, ADA-USD. Use strike_list_markets to discover symbols.");

export const accountSelectorShape = {
  wallet_address: z
    .string()
    .optional()
    .describe("Look up any public account by wallet address (Cardano, Ethereum or Solana). No keys needed."),
  account_id: z.string().uuid().optional().describe("Look up a public account by Strike account UUID."),
  sub_account_id: z
    .string()
    .uuid()
    .optional()
    .describe("One of your own subaccounts (requires the API wallet)."),
};

export interface AccountSelector {
  wallet_address?: string;
  account_id?: string;
  sub_account_id?: string;
}

/**
 * Resolves which account a read targets. Explicit selectors win; otherwise the
 * API wallet's own account; otherwise STRIKE_WALLET_ADDRESS.
 */
export function resolveAccount(sel: AccountSelector, config: Config, hasApiWallet: boolean): Query {
  if (sel.account_id) return { account_id: sel.account_id };
  if (sel.wallet_address) return { blockchain_address: sel.wallet_address };
  if (sel.sub_account_id) return { sub_account_id: sel.sub_account_id };
  if (hasApiWallet) return {};
  if (config.walletAddress) {
    return { blockchain_address: config.walletAddress, blockchain: config.blockchain };
  }
  throw new Error(
    "No account to look up. Pass wallet_address or account_id, or configure STRIKE_WALLET_ADDRESS " +
      "(read-only) or an API wallet (STRIKE_API_PUBLIC_KEY / STRIKE_API_PRIVATE_KEY).",
  );
}

export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
