import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StrikeClient, type FetchLike } from "./client.js";
import type { Config } from "./config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMarketTools } from "./tools/market.js";
import { registerTradingTools } from "./tools/trading.js";

export const VERSION = "0.1.0";

export function createServer(config: Config, fetchImpl?: FetchLike) {
  const client = new StrikeClient(config, fetchImpl);
  const mode = config.tradingEnabled ? "trading enabled" : client.hasApiWallet ? "read-only (API wallet)" : "read-only";

  const server = new McpServer(
    { name: "strike-mcp", version: VERSION },
    {
      instructions: [
        `Strike Finance perpetuals exchange (${config.network}, ${mode}).`,
        "Prices and sizes are decimal strings; markets are symbols like BTC-USD or ADA-USD.",
        "Funding settles hourly; positive funding means longs pay shorts.",
        config.tradingEnabled
          ? "Orders are two-step: strike_preview_order (or strike_preview_close_position) first, show the user the " +
            "summary and warnings, and call strike_place_order only after they explicitly confirm. Never place " +
            "orders the user did not ask for."
          : "Trading tools are disabled; this server can only read market and account data.",
      ].join(" "),
    },
  );

  registerMarketTools(server, client);
  registerAccountTools(server, client, config);
  if (config.tradingEnabled) registerTradingTools(server, client, config);

  server.registerPrompt(
    "strike_daily_brief",
    {
      title: "Strike daily brief",
      description: "Market overview plus a health check of your positions.",
      argsSchema: { focus: z.string().optional().describe("Optional markets to focus on, e.g. 'ADA-USD, BTC-USD'.") },
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Give me a concise Strike Finance brief. " +
              "1) strike_list_markets sorted by volume and by abs_change: what is moving. " +
              "2) strike_get_funding: the most extreme funding and what it implies about positioning. " +
              "3) strike_get_sentiment. " +
              `4) ${focus ? `strike_market_snapshot for ${focus}. ` : ""}` +
              "5) strike_get_positions and strike_get_account: flag anything in 'watch' or 'danger', and what funding " +
              "costs or earns per day. Keep it short, lead with what needs attention.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "strike_risk_check",
    {
      title: "Strike risk check",
      description: "Stress-test open positions against a price move.",
      argsSchema: { move_pct: z.string().default("10").describe("Adverse move to test, in %.") },
    },
    ({ move_pct }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Using strike_get_positions and strike_get_account, tell me which positions would be liquidated or ` +
              `come within 5% of liquidation after an adverse ${move_pct}% move in each market, the resulting PnL, ` +
              "and the cheapest way to de-risk (add margin, reduce size, or add a stop). Don't place any orders.",
          },
        },
      ],
    }),
  );

  return { server, client };
}
