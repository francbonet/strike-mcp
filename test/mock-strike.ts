import * as ed from "@noble/ed25519";
import { buildSignatureMessage } from "../src/auth.js";

/** Minimal in-process Strike API mock built from the shapes in the official OpenAPI specs. */
export interface MockState {
  mark: string;
  calls: { method: string; url: string; headers: Record<string, string>; body?: string }[];
  positions: Record<string, unknown>[];
  signatureFailures: number;
}

export function createMockStrike(publicKeyHex?: string) {
  const state: MockState = {
    mark: "0.6500",
    calls: [],
    signatureFailures: 0,
    positions: [
      {
        id: 1,
        symbol: "ADA-USD",
        margin_mode: "cross",
        leverage: 5,
        size: "1000",
        entry_price: "0.6000",
        iso_balance: "0",
        accumulated_funding_fees: "-1.20",
        create_timestamp: 1792000000000,
        update_timestamp: 1792000000000,
        upnl: "50.00",
        maintenance_margin: "6.5",
        bankruptcy_price: "0.48",
        liquidation_price: "0.6200",
      },
    ],
  };

  const book = () => {
    const m = Number(state.mark);
    const bids: [string, string][] = [];
    const asks: [string, string][] = [];
    for (let i = 1; i <= 50; i++) {
      bids.push([(m - i * 0.0005).toFixed(4), "2000"]);
      asks.push([(m + i * 0.0005).toFixed(4), "2000"]);
    }
    return { lastUpdateId: 1, E: 1792000000000, T: 1792000000000, bids, asks };
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  async function verify(method: string, pathWithQuery: string, headers: Record<string, string>, body: string) {
    if (!publicKeyHex) return false;
    const sig = headers["X-API-Wallet-Signature"];
    const ts = Number(headers["X-API-Wallet-Timestamp"]);
    const nonce = headers["X-API-Wallet-Nonce"];
    if (!sig || !nonce || headers["X-API-Wallet-Public-Key"] !== publicKeyHex) return false;
    const msg = buildSignatureMessage(method, pathWithQuery, ts, nonce, body);
    return ed.verifyAsync(Buffer.from(sig, "hex"), new TextEncoder().encode(msg), Buffer.from(publicKeyHex, "hex"));
  }

  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : undefined;
    state.calls.push({ method, url: input, headers, body });
    const symbol = url.searchParams.get("symbol");

    // ---- public market data (/price prefix) ----
    if (url.pathname.startsWith("/price/")) {
      const p = url.pathname.slice("/price".length);
      switch (p) {
        case "/v2/marketStats": {
          const rows = [
            { symbol: "ADA-USD", category: "Crypto", subCategory: "", status: "ACTIVE", active: true,
              marketStats: { volume24h: "5000000", priceChangePercentage24h: "4.2", low24h: "0.62", high24h: "0.66",
                lastPrice: state.mark, markPrice: state.mark, indexPrice: "0.6495", fundingRate: "0.0000125",
                nextFundingRate: 1792440000000, openInterest: "1200000" } },
            { symbol: "BTC-USD", category: "Crypto", subCategory: "", status: "ACTIVE", active: true,
              marketStats: { volume24h: "90000000", priceChangePercentage24h: "-1.1", lastPrice: "77117.6",
                markPrice: "77100", fundingRate: "-0.00002", openInterest: "1644224" } },
            { symbol: "XAU-USD", category: "TradFi", subCategory: "Commodity", status: "BREAK", active: false,
              marketStats: { volume24h: "10", priceChangePercentage24h: "0", lastPrice: "2400" } },
          ];
          return json({ status: "OK", data: symbol ? rows.filter((r) => r.symbol === symbol) : rows });
        }
        case "/v2/premiumIndex": {
          const rows = [
            { symbol: "ADA-USD", markPrice: state.mark, indexPrice: "0.6495", fundingRate: "0.0000125",
              nextFundingTime: 1792440000000 },
            { symbol: "BTC-USD", markPrice: "77100", indexPrice: "77110", fundingRate: "-0.00002",
              nextFundingTime: 1792440000000 },
          ];
          return json(symbol ? rows.find((r) => r.symbol === symbol) : rows);
        }
        case "/v2/depth":
          return json(book());
        case "/v2/exchangeInfo":
          return json({
            symbols: [
              { symbol: "ADA-USD", status: "trading", orderType: ["LIMIT", "MARKET", "STOP", "STOP_LIMIT", "TAKE_PROFIT",
                "TAKE_PROFIT_LIMIT", "TRAILING_STOP_MARKET"],
                filters: [
                  { filterType: "PRICE_FILTER", minPrice: "0.0001", maxPrice: "1000", tickSize: "0.0001" },
                  { filterType: "LOT_SIZE", minQty: "1", maxQty: "10000000", stepSize: "1" },
                  { filterType: "MARKET_LOT_SIZE", minQty: "1", maxQty: "1000000", stepSize: "1" },
                  { filterType: "MIN_NOTIONAL", notional: "5" },
                ] },
            ],
          });
        case "/v2/klines":
          return json(
            Array.from({ length: Number(url.searchParams.get("limit") ?? 10) }, (_, i) => [
              1792000000000 + i * 3_600_000, "0.60", "0.62", "0.59", (0.6 + i * 0.001).toFixed(4), "1000",
              1792000000000 + (i + 1) * 3_600_000 - 1, "600", 12, "500", "300", "0",
            ]),
          );
        case "/v2/trades":
          return json([
            { id: 2, price: "0.65", qty: "100", quoteQty: "65", time: 1792000001000, isBuyerMaker: false },
            { id: 1, price: "0.649", qty: "50", quoteQty: "32.45", time: 1792000000000, isBuyerMaker: true },
          ]);
        case "/v2/fearGreed":
          return json({ status: "OK", data: { value: 62, classification: "Greed" } });
      }
      return json({ code: "NOT_FOUND" }, 404);
    }

    // ---- user / trade API ----
    const pathWithQuery = url.pathname + url.search;
    const signed = Boolean(headers["X-API-Wallet-Signature"]);
    if (signed && !(await verify(method, pathWithQuery, headers, body ?? ""))) {
      state.signatureFailures++;
      return json({ error: "authentication failed" }, 401);
    }
    const isPublicLookup = url.searchParams.has("blockchain_address") || url.searchParams.has("account_id");
    const authed = signed || isPublicLookup;

    switch (`${method} ${url.pathname}`) {
      case "GET /v2/account":
        if (!authed) return json({ error: "account_id not found in auth context" }, 401);
        return json({ account_id: "8b1f3c1e-0000-4000-8000-000000000001", blockchain: "cardano",
          blockchain_address: "addr1test", wallet_balance: "500", available_balance: "300", unrealized_pnl: "50",
          margin_balance: "550", total_margin: "130", position_initial_margin: "130", maintenance_margin: "6.5",
          copy_reserved_balance: "0", sub_accounts: [], symbol_settings: { "ADA-USD": { margin_mode: "cross",
          leverage: 5, allow_pre_trade: false } } });
      case "GET /v2/balances":
        return json([{ asset: "USD", walletBalance: "500", maxWithdrawAmount: "300" }]);
      case "GET /v2/positions":
        if (!authed) return json({ error: "unauthorized" }, 401);
        return json({ positions: state.positions.filter((p) => !symbol || p.symbol === symbol),
          count: state.positions.length });
      case "GET /v2/symbols":
        if (!signed) return json({ error: "account_id not found in auth context" }, 401);
        return json({ default_leverage: 10, default_margin_mode: "cross",
          symbol_settings: { "ADA-USD": { margin_mode: "cross", leverage: 5 } } });
      case "GET /v2/openOrders":
        return json({ orders: [{ ID: 42, Symbol: "ADA-USD", Side: "sell", Type: "take_profit", Status: "untriggered",
          Size: "1000", Filled: "0", Price: "0", StopPrice: "0.80", ReduceOnly: true }], count: 1 });
      case "POST /v2/order":
      case "POST /v2/order/strategy": {
        const b = JSON.parse(body ?? "{}");
        return json({ client_order_id: b.client_order_id, account_id: "acc", symbol: b.symbol, sequence_id: 99,
          message_id: "m1" }, 201);
      }
      case "DELETE /v2/order/cancel":
        return json({ order_id: JSON.parse(body!).order_id, symbol: "ADA-USD", sequence_id: 100 });
    }
    return json({ error: `mock: no route for ${method} ${url.pathname}` }, 404);
  };

  return { state, fetchImpl };
}
