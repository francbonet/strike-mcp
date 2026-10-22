import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  candleStats,
  describeFunding,
  estimateMarketFill,
  parseKlines,
  summarizeBook,
  type DepthSnapshot,
} from "../analytics.js";
import type { StrikeClient } from "../client.js";
import { asArray, ok, safe, symbolSchema } from "./shared.js";

export interface MarketStatsRow {
  symbol: string;
  category?: string;
  subCategory?: string;
  status?: string;
  active?: boolean;
  marketStats?: {
    volume24h?: string;
    priceChangePercentage24h?: string;
    low24h?: string;
    high24h?: string;
    lastPrice?: string;
    markPrice?: string;
    indexPrice?: string;
    fundingRate?: string;
    nextFundingRate?: number;
    openInterest?: string;
  };
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  /** Live API field. */
  fundingRate?: string;
  /** Field name in the published OpenAPI spec; kept as a fallback. */
  lastFundingRate?: string;
  nextFundingTime: number;
}

/** Hourly funding rate; the live API and the docs disagree on the field name. */
export function fundingOf(p: PremiumIndex | undefined): string | null {
  return p?.fundingRate ?? p?.lastFundingRate ?? null;
}

export async function fetchMarketStats(client: StrikeClient, symbol?: string): Promise<MarketStatsRow[]> {
  const res = await client.market<{ data?: MarketStatsRow | MarketStatsRow[] }>("/v2/marketStats", { symbol });
  return asArray(res?.data);
}

export async function fetchPremium(client: StrikeClient, symbol?: string): Promise<PremiumIndex[]> {
  return asArray(await client.market<PremiumIndex | PremiumIndex[]>("/v2/premiumIndex", { symbol }));
}

export async function fetchDepth(client: StrikeClient, symbol: string, limit = 100): Promise<DepthSnapshot> {
  return client.market<DepthSnapshot>("/v2/depth", { symbol, limit });
}

function compactMarket(m: MarketStatsRow) {
  const s = m.marketStats ?? {};
  return {
    symbol: m.symbol,
    category: [m.category, m.subCategory].filter(Boolean).join("/") || null,
    status: m.status ?? null,
    last_price: s.lastPrice ?? null,
    mark_price: s.markPrice ?? null,
    change_24h_pct: s.priceChangePercentage24h ?? null,
    high_24h: s.high24h ?? null,
    low_24h: s.low24h ?? null,
    volume_24h_usd: s.volume24h ?? null,
    open_interest_usd: s.openInterest ?? null,
    funding_apr_pct: s.fundingRate ? describeFunding(s.fundingRate).apr_pct : null,
    next_funding: s.nextFundingRate ? new Date(s.nextFundingRate).toISOString() : null,
  };
}

const num = (v: string | null | undefined) => (v ? Number(v) : Number.NEGATIVE_INFINITY);

export function registerMarketTools(server: McpServer, client: StrikeClient) {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "strike_list_markets",
    {
      title: "List Strike markets",
      description:
        "Lists every Strike perpetual market with price, 24h change, volume, open interest and funding (as APR). " +
        "Use it to discover symbols or rank markets (top movers, most traded, highest funding).",
      inputSchema: {
        sort_by: z
          .enum(["volume", "change", "abs_change", "funding", "abs_funding", "open_interest", "symbol"])
          .default("volume")
          .describe("Ranking. abs_* sort by magnitude, useful for 'biggest movers' or funding extremes."),
        category: z.string().optional().describe("Filter by category, e.g. Crypto, TradFi, FX, Equity."),
        limit: z.number().int().min(1).max(200).default(50),
        include_inactive: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    safe(async ({ sort_by, category, limit, include_inactive }) => {
      let rows = (await fetchMarketStats(client)).map(compactMarket);
      if (!include_inactive) rows = rows.filter((r) => !r.status || r.status === "ACTIVE");
      if (category) {
        const c = category.toLowerCase();
        rows = rows.filter((r) => r.category?.toLowerCase().includes(c));
      }
      const key: Record<string, (r: (typeof rows)[number]) => number> = {
        volume: (r) => num(r.volume_24h_usd),
        change: (r) => num(r.change_24h_pct),
        abs_change: (r) => Math.abs(num(r.change_24h_pct)),
        funding: (r) => num(r.funding_apr_pct),
        abs_funding: (r) => Math.abs(num(r.funding_apr_pct)),
        open_interest: (r) => num(r.open_interest_usd),
      };
      if (sort_by === "symbol") rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
      else rows.sort((a, b) => key[sort_by](b) - key[sort_by](a));
      return ok({ count: rows.length, sorted_by: sort_by, markets: rows.slice(0, limit) });
    }),
  );

  server.registerTool(
    "strike_market_snapshot",
    {
      title: "Market snapshot",
      description:
        "One-call brief for a single market: price, 24h range and change, volume, open interest, " +
        "funding (hourly, 8h, APR and who pays), mark vs index premium, spread and order-book depth/imbalance.",
      inputSchema: { symbol: symbolSchema },
      annotations: readOnly,
    },
    safe(async ({ symbol }) => {
      const [stats, premium, book] = await Promise.all([
        fetchMarketStats(client, symbol),
        fetchPremium(client, symbol),
        fetchDepth(client, symbol, 200),
      ]);
      const market = stats[0];
      if (!market) throw new Error(`Unknown market ${symbol}. Use strike_list_markets to see valid symbols.`);
      const p = premium[0];
      const premiumPct =
        p?.markPrice && p?.indexPrice && Number(p.indexPrice) !== 0
          ? new Decimal(p.markPrice).div(p.indexPrice).minus(1).mul(100).toDecimalPlaces(4).toString()
          : null;
      const fundingRate = fundingOf(p) ?? market.marketStats?.fundingRate;
      return ok({
        ...compactMarket(market),
        index_price: p?.indexPrice ?? market.marketStats?.indexPrice ?? null,
        mark_premium_vs_index_pct: premiumPct,
        funding: fundingRate ? describeFunding(fundingRate) : null,
        next_funding_time: p?.nextFundingTime ? new Date(p.nextFundingTime).toISOString() : null,
        order_book: summarizeBook(book),
      });
    }),
  );

  server.registerTool(
    "strike_get_orderbook",
    {
      title: "Order book",
      description:
        "Order book for a market: top price levels per side plus a summary (best bid/ask, spread in bps, " +
        "USD depth within 0.5/1/2% of mid, and bid/ask imbalance).",
      inputSchema: {
        symbol: symbolSchema,
        levels: z.number().int().min(1).max(100).default(10).describe("Levels per side to return."),
      },
      annotations: readOnly,
    },
    safe(async ({ symbol, levels }) => {
      const book = await fetchDepth(client, symbol, 500);
      return ok({
        symbol,
        snapshot_time: book.E ? new Date(book.E).toISOString() : null,
        summary: summarizeBook(book),
        bids: book.bids.slice(0, levels),
        asks: book.asks.slice(0, levels),
      });
    }),
  );

  server.registerTool(
    "strike_estimate_market_impact",
    {
      title: "Estimate market impact",
      description:
        "Simulates a market order against the live book without placing anything: average fill price, " +
        "worst price, slippage vs mid in bps, and whether visible liquidity covers it. Give size or notional_usd.",
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(["buy", "sell"]),
        size: z.string().optional().describe("Size in base asset, e.g. '0.5'."),
        notional_usd: z.number().positive().optional().describe("Alternative to size: USD amount to trade."),
      },
      annotations: readOnly,
    },
    safe(async ({ symbol, side, size, notional_usd }) => {
      if (!size && !notional_usd) throw new Error("Provide size or notional_usd.");
      const book = await fetchDepth(client, symbol, 1000);
      let baseSize = size;
      if (!baseSize) {
        const mid = summarizeBook(book).mid;
        if (!mid) throw new Error(`The ${symbol} book is empty.`);
        baseSize = new Decimal(notional_usd!).div(mid).toDecimalPlaces(8).toString();
      }
      return ok({ symbol, ...estimateMarketFill(book, side, baseSize) });
    }),
  );

  server.registerTool(
    "strike_get_candles",
    {
      title: "Candles",
      description:
        "OHLCV candles for a market plus summary stats (change, range, close-to-close volatility, volume). " +
        "Use for trend questions like 'how has ADA moved this week'.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"])
          .default("1h"),
        limit: z.number().int().min(2).max(1500).default(48).describe("Number of candles (most recent)."),
        price_type: z.enum(["last", "mark", "index"]).default("last"),
        include_candles: z
          .number()
          .int()
          .min(0)
          .max(500)
          .default(24)
          .describe("How many of the most recent candles to include in the output (stats always use all)."),
      },
      annotations: readOnly,
    },
    safe(async ({ symbol, interval, limit, price_type, include_candles }) => {
      const raw = await client.market<unknown[][]>("/v2/klines", { symbol, interval, limit, priceType: price_type });
      const candles = parseKlines(raw ?? []);
      return ok({
        symbol,
        interval,
        price_type,
        stats: candleStats(candles),
        candles: include_candles ? candles.slice(-include_candles) : [],
      });
    }),
  );

  server.registerTool(
    "strike_get_recent_trades",
    {
      title: "Recent trades",
      description:
        "Most recent public trades in a market with a taker-flow summary (buy vs sell volume, largest trade).",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().min(1).max(1000).default(200),
        include_trades: z.number().int().min(0).max(100).default(20),
      },
      annotations: readOnly,
    },
    safe(async ({ symbol, limit, include_trades }) => {
      type Trade = { id: number; price: string; qty: string; quoteQty: string; time: number; isBuyerMaker: boolean };
      const trades = (await client.market<Trade[]>("/v2/trades", { symbol, limit })) ?? [];
      let buyUsd = new Decimal(0);
      let sellUsd = new Decimal(0);
      let largest: Trade | null = null;
      for (const t of trades) {
        // isBuyerMaker = the seller was the aggressor.
        if (t.isBuyerMaker) sellUsd = sellUsd.plus(t.quoteQty);
        else buyUsd = buyUsd.plus(t.quoteQty);
        if (!largest || Number(t.quoteQty) > Number(largest.quoteQty)) largest = t;
      }
      const total = buyUsd.plus(sellUsd);
      return ok({
        symbol,
        count: trades.length,
        window:
          trades.length > 0
            ? {
                from: new Date(trades[trades.length - 1].time).toISOString(),
                to: new Date(trades[0].time).toISOString(),
              }
            : null,
        taker_buy_usd: buyUsd.toFixed(2),
        taker_sell_usd: sellUsd.toFixed(2),
        taker_buy_ratio: total.isZero() ? null : buyUsd.div(total).toFixed(4),
        largest_trade: largest
          ? {
              price: largest.price,
              qty: largest.qty,
              usd: largest.quoteQty,
              side: largest.isBuyerMaker ? "sell" : "buy",
              time: new Date(largest.time).toISOString(),
            }
          : null,
        trades: trades.slice(0, include_trades).map((t) => ({
          price: t.price,
          qty: t.qty,
          usd: t.quoteQty,
          side: t.isBuyerMaker ? "sell" : "buy",
          time: new Date(t.time).toISOString(),
        })),
      });
    }),
  );

  server.registerTool(
    "strike_get_funding",
    {
      title: "Funding rates",
      description:
        "Current funding for one market or all, with hourly/8h/APR rates and who pays. Without a symbol, " +
        "markets are ranked by absolute APR to surface carry opportunities and crowded trades.",
      inputSchema: {
        symbol: symbolSchema.optional(),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: readOnly,
    },
    safe(async ({ symbol, limit }) => {
      const rows = (await fetchPremium(client, symbol))
        .filter((p) => fundingOf(p) !== null)
        .map((p) => ({
          symbol: p.symbol,
          mark_price: p.markPrice,
          index_price: p.indexPrice,
          next_funding_time: p.nextFundingTime ? new Date(p.nextFundingTime).toISOString() : null,
          ...describeFunding(fundingOf(p)!),
        }))
        .sort((a, b) => Math.abs(Number(b.apr_pct)) - Math.abs(Number(a.apr_pct)));
      return ok({
        note: "Strike settles funding every hour. Positive = longs pay shorts.",
        markets: rows.slice(0, limit),
      });
    }),
  );

  server.registerTool(
    "strike_get_sentiment",
    {
      title: "Market sentiment",
      description:
        "Strike's Fear & Greed index (0 extreme fear to 100 extreme greed) computed from the exchange's own " +
        "24h tape, with momentum/breadth/volatility components. Display-only, not a risk input.",
      inputSchema: {},
      annotations: readOnly,
    },
    safe(async () => {
      const res = await client.market<{ data?: unknown }>("/v2/fearGreed");
      return ok((res?.data ?? res) as object);
    }),
  );
}
