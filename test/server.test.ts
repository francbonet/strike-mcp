import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as ed from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { buildSignatureMessage, generateKeyPair, normalizePrivateKey, signRequest } from "../src/auth.js";
import {
  assessPosition,
  checkOrderAgainstFilters,
  describeFunding,
  estimateMarketFill,
  summarizeBook,
} from "../src/analytics.js";
import { loadConfig } from "../src/config.js";
import { PreviewStore } from "../src/guard.js";
import { createServer } from "../src/server.js";
import { createMockStrike } from "./mock-strike.js";

async function connect(env: Record<string, string>, keys?: { publicKeyHex: string }) {
  const mock = createMockStrike(keys?.publicKeyHex);
  const config = loadConfig({ STRIKE_API_URL: "https://mock.strike", ...env });
  const { server } = createServer(config, mock.fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: any;
      content: { text: string }[];
    };
    return res;
  };
  return { client, call, mock };
}

describe("auth", () => {
  it("signs METHOD:PATH:TS:NONCE:SHA256(body) verifiably", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeyPair();
    const body = JSON.stringify({ symbol: "ADA-USD", side: "buy", type: "limit", size: "10", price: "0.5" });
    const h = await signRequest(privateKeyHex, publicKeyHex, "post", "/v2/order", body, () => 1_704_067_200_000);
    expect(h["X-API-Wallet-Timestamp"]).toBe("1704067200");
    expect(h["X-API-Wallet-Nonce"]).toMatch(/^[0-9a-f-]{36}$/);
    const msg = buildSignatureMessage("POST", "/v2/order", 1_704_067_200, h["X-API-Wallet-Nonce"], body);
    expect(msg.startsWith("POST:/v2/order:1704067200:")).toBe(true);
    const valid = await ed.verifyAsync(
      Buffer.from(h["X-API-Wallet-Signature"], "hex"),
      new TextEncoder().encode(msg),
      Buffer.from(publicKeyHex, "hex"),
    );
    expect(valid).toBe(true);
  });

  it("hashes an empty body for GET as sha256('')", () => {
    expect(buildSignatureMessage("GET", "/v2/account", 1, "n", "")).toBe(
      "GET:/v2/account:1:n:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("accepts a 64-byte expanded private key", () => {
    const seed = "11".repeat(32);
    expect(Buffer.from(normalizePrivateKey(seed + "22".repeat(32))).toString("hex")).toBe(seed);
  });
});

describe("analytics", () => {
  const book = {
    bids: [["99", "1"], ["98", "2"]] as [string, string][],
    asks: [["101", "1"], ["102", "2"]] as [string, string][],
  };

  it("summarizes spread and imbalance", () => {
    const s = summarizeBook(book);
    expect(s.mid).toBe("100");
    expect(s.spread_bps).toBe("200");
    expect(s.depth_usd["2%"]).toEqual({ bids: "295", asks: "305" });
  });

  it("walks the book for market fills", () => {
    const f = estimateMarketFill(book, "buy", "2");
    expect(f.avg_price).toBe("101.5");
    expect(f.fully_fillable).toBe(true);
    expect(f.slippage_bps_vs_mid).toBe("150");
    expect(estimateMarketFill(book, "sell", "10").fully_fillable).toBe(false);
  });

  it("annualizes hourly funding", () => {
    const f = describeFunding("0.0001");
    expect(f.apr_pct).toBe("87.6");
    expect(f.payer).toBe("longs pay shorts");
    expect(describeFunding("-0.00001").payer).toBe("shorts pay longs");
  });

  it("flags positions near liquidation and signs funding by side", () => {
    const base = { symbol: "X", entry_price: "100", leverage: 10, margin_mode: "cross", upnl: "0" };
    const long = assessPosition({ ...base, size: "1", liquidation_price: "96" }, "100", "0.0001");
    expect(long.distance_to_liquidation_pct).toBe("4");
    expect(long.risk).toBe("danger");
    expect(Number(long.funding_per_day_usd)).toBeGreaterThan(0);
    const short = assessPosition({ ...base, size: "-1", liquidation_price: "110" }, "100", "0.0001");
    expect(short.risk).toBe("watch");
    expect(Number(short.funding_per_day_usd)).toBeLessThan(0);
  });

  it("checks tick, step and min notional", () => {
    const info = {
      symbol: "ADA-USD",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.0001", minPrice: "0.0001", maxPrice: "1000" },
        { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    };
    expect(checkOrderAgainstFilters(info, { type: "limit", size: "10", price: "0.65" }, null).errors).toEqual([]);
    const bad = checkOrderAgainstFilters(info, { type: "limit", size: "2.5", price: "0.65005" }, null).errors;
    expect(bad.join(" ")).toMatch(/step size/);
    expect(bad.join(" ")).toMatch(/tick size/);
    expect(bad.join(" ")).toMatch(/below the market minimum/);
  });
});

describe("preview store", () => {
  it("is single-use and expires", () => {
    let t = 0;
    const store = new PreviewStore(1000, () => t);
    const p = store.add({ path: "/v2/order", body: {}, symbol: "X", markAtPreview: null, isMarket: false, summary: {} });
    expect(store.take(p.id).id).toBe(p.id);
    expect(() => store.take(p.id)).toThrow(/already-used/);
    const q = store.add({ path: "/v2/order", body: {}, symbol: "X", markAtPreview: null, isMarket: false, summary: {} });
    t = 2000;
    expect(() => store.take(q.id)).toThrow(/expired/);
  });
});

describe("MCP server (read-only)", () => {
  it("exposes only read tools without trading enabled", async () => {
    const { client } = await connect({ STRIKE_WALLET_ADDRESS: "addr1test" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("strike_market_snapshot");
    expect(names).toContain("strike_get_positions");
    expect(names).not.toContain("strike_place_order");
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("strike_daily_brief");
  });

  it("ranks markets and hides inactive ones", async () => {
    const { call } = await connect({});
    const res = await call("strike_list_markets", { sort_by: "abs_change" });
    expect(res.structuredContent.markets.map((m: any) => m.symbol)).toEqual(["ADA-USD", "BTC-USD"]);
    expect(res.structuredContent.markets[0].funding_apr_pct).toBe("10.95");
  });

  it("builds a market snapshot", async () => {
    const { call } = await connect({});
    const res = await call("strike_market_snapshot", { symbol: "ada-usd" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.symbol).toBe("ADA-USD");
    expect(res.structuredContent.funding.payer).toBe("longs pay shorts");
    expect(res.structuredContent.order_book.spread_bps).toBe("15.38");
  });

  it("reads positions for a public wallet with no keys and flags risk", async () => {
    const { call, mock } = await connect({ STRIKE_WALLET_ADDRESS: "addr1test" });
    const res = await call("strike_get_positions");
    expect(res.isError).toBeFalsy();
    const pos = res.structuredContent.positions[0];
    expect(pos.distance_to_liquidation_pct).toBe("4.62");
    expect(pos.risk).toBe("danger");
    expect(res.structuredContent.totals.positions_in_danger).toEqual(["ADA-USD"]);
    const posCall = mock.state.calls.find((c) => c.url.includes("/v2/positions"))!;
    expect(posCall.url).toContain("blockchain_address=addr1test");
    expect(posCall.headers["X-API-Wallet-Signature"]).toBeUndefined();
  });

  it("explains how to pick an account when none is configured", async () => {
    const { call } = await connect({});
    const res = await call("strike_get_account");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/wallet_address/);
  });

  it("summarizes candles", async () => {
    const { call } = await connect({});
    const res = await call("strike_get_candles", { symbol: "ADA-USD", limit: 10, include_candles: 2 });
    expect(res.structuredContent.stats.candles).toBe(10);
    expect(res.structuredContent.candles).toHaveLength(2);
  });
});

describe("MCP server (trading)", () => {
  async function tradingSetup(extra: Record<string, string> = {}) {
    const keys = await generateKeyPair();
    const ctx = await connect(
      {
        STRIKE_API_PUBLIC_KEY: keys.publicKeyHex,
        STRIKE_API_PRIVATE_KEY: keys.privateKeyHex,
        STRIKE_ENABLE_TRADING: "true",
        ...extra,
      },
      keys,
    );
    return ctx;
  }

  it("refuses to enable trading without keys", () => {
    expect(() => loadConfig({ STRIKE_ENABLE_TRADING: "true" })).toThrow(/API wallet/);
  });

  it("previews then places exactly the previewed order, signed", async () => {
    const { call, mock } = await tradingSetup();
    const pv = await call("strike_preview_order", {
      symbol: "ADA-USD",
      side: "buy",
      type: "limit",
      size: "500",
      price: "0.6400",
      take_profit: { trigger_price: "0.7000" },
      stop_loss: { trigger_price: "0.6000" },
    });
    expect(pv.isError).toBeFalsy();
    expect(pv.structuredContent.ok).toBe(true);
    expect(pv.structuredContent.summary.estimated_notional_usd).toBe("320.00");
    expect(pv.structuredContent.summary.position_after_if_filled).toBe("1500");
    expect(mock.state.calls.some((c) => c.method === "POST")).toBe(false);

    const placed = await call("strike_place_order", { preview_id: pv.structuredContent.preview_id });
    expect(placed.isError).toBeFalsy();
    const post = mock.state.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://mock.strike/v2/order/strategy");
    expect(JSON.parse(post.body!)).toEqual(pv.structuredContent.request.body);
    expect(JSON.parse(post.body!).tp_order.type).toBe("take_profit");
    expect(mock.state.signatureFailures).toBe(0);

    const again = await call("strike_place_order", { preview_id: pv.structuredContent.preview_id });
    expect(again.isError).toBe(true);
  });

  it("blocks orders over the notional cap and bad brackets", async () => {
    const { call } = await tradingSetup({ STRIKE_MAX_ORDER_NOTIONAL_USD: "100" });
    const big = await call("strike_preview_order", { symbol: "ADA-USD", side: "buy", type: "limit", size: "500", price: "0.64" });
    expect(big.structuredContent.ok).toBe(false);
    expect(big.structuredContent.errors.join(" ")).toMatch(/safety cap/);
    const bracket = await call("strike_preview_order", {
      symbol: "ADA-USD", side: "buy", type: "limit", size: "50", price: "0.64",
      stop_loss: { trigger_price: "0.70" },
    });
    expect(bracket.structuredContent.errors.join(" ")).toMatch(/Stop-loss .* must be below/);
  });

  it("sizes by USD notional and floors to the step size", async () => {
    const { call } = await tradingSetup();
    const pv = await call("strike_preview_order", { symbol: "ADA-USD", side: "sell", type: "limit", notional_usd: 100, price: "0.6600" });
    expect(pv.structuredContent.request.body.size).toBe("151");
  });

  it("closes a position with a reduce-only market order and refuses stale prices", async () => {
    const { call, mock } = await tradingSetup();
    const pv = await call("strike_preview_close_position", { symbol: "ADA-USD", fraction: 0.5 });
    expect(pv.structuredContent.ok).toBe(true);
    expect(pv.structuredContent.request.body).toMatchObject({ side: "sell", type: "market", size: "500", reduce_only: true });
    expect(pv.structuredContent.summary.position_after_if_filled).toBe("500");

    mock.state.mark = "0.6700"; // +3% since preview
    const res = await call("strike_place_order", { preview_id: pv.structuredContent.preview_id });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/moved 3\.08%/);
  });

  it("rejects reduce-only orders that would increase exposure", async () => {
    const { call } = await tradingSetup();
    const pv = await call("strike_preview_order", { symbol: "ADA-USD", side: "buy", type: "market", size: "10", reduce_only: true });
    expect(pv.structuredContent.errors.join(" ")).toMatch(/would increase/);
  });

  it("requires explicit confirmation to cancel everything", async () => {
    const { call } = await tradingSetup();
    const res = await call("strike_cancel_all_orders", {});
    expect(res.isError).toBe(true);
  });
});
