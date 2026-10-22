export type Network = "mainnet" | "testnet";

export interface Config {
  network: Network;
  /** Base URL for authenticated/user/trade endpoints, e.g. https://api.strikefinance.org */
  apiUrl: string;
  /** Base URL for public market data, e.g. https://api.strikefinance.org/price */
  marketUrl: string;
  publicKeyHex?: string;
  privateKeyHex?: string;
  /** Default wallet for read-only lookups when no API wallet is configured. */
  walletAddress?: string;
  blockchain?: "cardano" | "ethereum" | "solana";
  /** Trading tools are only registered when this is true. */
  tradingEnabled: boolean;
  /** Hard cap on the notional (USD) of any single order the server will place. */
  maxOrderNotionalUsd: number;
  /** How long an order preview stays valid before it must be re-previewed. */
  previewTtlMs: number;
}

const DEFAULT_URLS: Record<Network, string> = {
  mainnet: "https://api.strikefinance.org",
  testnet: "https://api-v2-testnet.strikefinance.org",
};

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network: Network = env.STRIKE_NETWORK === "testnet" ? "testnet" : "mainnet";
  const apiUrl = trimSlash(env.STRIKE_API_URL ?? DEFAULT_URLS[network]);
  const marketUrl = trimSlash(env.STRIKE_MARKET_URL ?? `${apiUrl}/price`);

  const publicKeyHex = env.STRIKE_API_PUBLIC_KEY?.trim() || undefined;
  const privateKeyHex = env.STRIKE_API_PRIVATE_KEY?.trim() || undefined;
  if (Boolean(publicKeyHex) !== Boolean(privateKeyHex)) {
    throw new Error("Set both STRIKE_API_PUBLIC_KEY and STRIKE_API_PRIVATE_KEY, or neither.");
  }
  if (publicKeyHex && !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    throw new Error("STRIKE_API_PUBLIC_KEY must be 64 hex characters (raw Ed25519 public key).");
  }
  if (privateKeyHex && !/^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(privateKeyHex)) {
    throw new Error("STRIKE_API_PRIVATE_KEY must be 64 or 128 hex characters.");
  }

  const blockchain = env.STRIKE_BLOCKCHAIN as Config["blockchain"];
  if (blockchain && !["cardano", "ethereum", "solana"].includes(blockchain)) {
    throw new Error("STRIKE_BLOCKCHAIN must be cardano, ethereum or solana.");
  }

  const tradingEnabled = env.STRIKE_ENABLE_TRADING === "true";
  if (tradingEnabled && !publicKeyHex) {
    throw new Error("STRIKE_ENABLE_TRADING=true requires an API wallet (STRIKE_API_PUBLIC_KEY / STRIKE_API_PRIVATE_KEY).");
  }

  const maxOrderNotionalUsd = Number(env.STRIKE_MAX_ORDER_NOTIONAL_USD ?? "1000");
  if (!Number.isFinite(maxOrderNotionalUsd) || maxOrderNotionalUsd <= 0) {
    throw new Error("STRIKE_MAX_ORDER_NOTIONAL_USD must be a positive number.");
  }

  return {
    network,
    apiUrl,
    marketUrl,
    publicKeyHex: publicKeyHex?.toLowerCase(),
    privateKeyHex: privateKeyHex?.toLowerCase(),
    walletAddress: env.STRIKE_WALLET_ADDRESS?.trim() || undefined,
    blockchain,
    tradingEnabled,
    maxOrderNotionalUsd,
    previewTtlMs: Number(env.STRIKE_PREVIEW_TTL_SECONDS ?? "120") * 1000,
  };
}
