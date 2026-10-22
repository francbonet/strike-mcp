#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateKeyPair } from "./auth.js";
import { loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

async function main() {
  const arg = process.argv[2];

  if (arg === "--version" || arg === "-v") {
    console.log(VERSION);
    return;
  }

  if (arg === "keygen") {
    const { privateKeyHex, publicKeyHex } = await generateKeyPair();
    console.log(
      [
        "New Strike API wallet key pair (Ed25519):",
        "",
        `STRIKE_API_PUBLIC_KEY=${publicKeyHex}`,
        `STRIKE_API_PRIVATE_KEY=${privateKeyHex}`,
        "",
        "1. Register the PUBLIC key at https://app.strikefinance.org/api-keys",
        "2. Keep the private key secret. API wallets can trade but cannot withdraw.",
      ].join("\n"),
    );
    return;
  }

  const config = loadConfig();
  const { server } = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error(
    `strike-mcp ${VERSION} on ${config.network} — ${config.tradingEnabled ? "trading ENABLED" : "read-only"}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
