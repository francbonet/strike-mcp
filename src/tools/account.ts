import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { assessPosition, type RawPosition } from "../analytics.js";
import type { StrikeClient } from "../client.js";
import type { Config } from "../config.js";
import { fetchPremium, fundingOf } from "./market.js";
import { accountSelectorShape, ok, resolveAccount, safe, symbolSchema } from "./shared.js";

export function registerAccountTools(server: McpServer, client: StrikeClient, config: Config) {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
  const who = (sel: { wallet_address?: string; account_id?: string; sub_account_id?: string }) =>
    resolveAccount(sel, config, client.hasApiWallet);

  server.registerTool(
    "strike_get_account",
    {
      title: "Account & balances",
      description:
        "Balances and margin for an account: wallet balance, available balance, unrealized PnL, margin used, " +
        "maintenance margin, margin ratio, withdrawable amount, and per-market leverage settings. " +
        "Defaults to your own account; any public account can be looked up by wallet address.",
      inputSchema: accountSelectorShape,
      annotations: readOnly,
    },
    safe(async (sel) => {
      const q = who(sel);
      const [account, balances] = await Promise.all([
        client.get<Record<string, unknown>>("/v2/account", q),
        client.get<Record<string, string>[]>("/v2/balances", q),
      ]);
      const bal = balances?.[0];
      const marginBalance = new Decimal((account.margin_balance as string) ?? "0");
      const maint = new Decimal((account.maintenance_margin as string) ?? "0");
      return ok({
        account_id: account.account_id,
        nickname: account.nickname ?? null,
        blockchain: account.blockchain || null,
        wallet_balance: account.wallet_balance,
        available_balance: account.available_balance,
        unrealized_pnl: account.unrealized_pnl,
        margin_balance: account.margin_balance,
        margin_in_use: account.total_margin,
        maintenance_margin: account.maintenance_margin,
        margin_ratio_pct: marginBalance.isZero() ? null : maint.div(marginBalance).mul(100).toFixed(2),
        max_withdrawable: bal?.maxWithdrawAmount ?? null,
        copy_trading_reserved: account.copy_reserved_balance ?? null,
        symbol_settings: account.symbol_settings ?? {},
        sub_accounts: account.sub_accounts ?? [],
        note: "margin_ratio_pct = maintenance margin / margin balance; 100% means liquidation.",
      });
    }),
  );

  server.registerTool(
    "strike_get_positions",
    {
      title: "Positions with risk",
      description:
        "Open positions enriched with live mark price, notional, PnL as % of margin, distance to liquidation, " +
        "a risk flag (ok / watch / danger), and what each position pays or earns in funding per day. " +
        "Use this for 'how are my positions', 'am I close to liquidation', 'what is funding costing me'.",
      inputSchema: {
        ...accountSelectorShape,
        symbol: symbolSchema.optional(),
        danger_pct: z.number().positive().default(5).describe("Flag 'danger' when liquidation is within this % of mark."),
        watch_pct: z.number().positive().default(15).describe("Flag 'watch' when liquidation is within this % of mark."),
      },
      annotations: readOnly,
    },
    safe(async ({ symbol, danger_pct, watch_pct, ...sel }) => {
      const q = { ...who(sel), symbol };
      const [res, premium] = await Promise.all([
        client.get<{ positions: RawPosition[] }>("/v2/positions", q),
        fetchPremium(client),
      ]);
      const bySymbol = new Map(premium.map((p) => [p.symbol, p]));
      const positions = (res?.positions ?? []).map((p) => {
        const px = bySymbol.get(p.symbol);
        return assessPosition(p, px?.markPrice ?? null, fundingOf(px), {
          danger: danger_pct,
          watch: watch_pct,
        });
      });
      const sum = (f: (p: (typeof positions)[number]) => string | null) =>
        positions.reduce((acc, p) => acc.plus(f(p) ?? "0"), new Decimal(0)).toFixed(2);
      const longs = positions.filter((p) => p.side === "long");
      const shorts = positions.filter((p) => p.side === "short");
      return ok({
        count: positions.length,
        totals: {
          gross_exposure_usd: sum((p) => p.notional_usd),
          long_exposure_usd: longs.reduce((a, p) => a.plus(p.notional_usd ?? "0"), new Decimal(0)).toFixed(2),
          short_exposure_usd: shorts.reduce((a, p) => a.plus(p.notional_usd ?? "0"), new Decimal(0)).toFixed(2),
          unrealized_pnl_usd: sum((p) => p.upnl_usd),
          funding_per_day_usd: sum((p) => p.funding_per_day_usd),
          positions_in_danger: positions.filter((p) => p.risk === "danger").map((p) => p.symbol),
          positions_to_watch: positions.filter((p) => p.risk === "watch").map((p) => p.symbol),
        },
        positions,
        note: "funding_per_day_usd > 0 means the position pays funding at the current rate; < 0 means it earns.",
      });
    }),
  );

  server.registerTool(
    "strike_get_open_orders",
    {
      title: "Open orders",
      description: "Open and untriggered orders (limits, stops, take-profits, trailing stops) for an account.",
      inputSchema: { ...accountSelectorShape, symbol: symbolSchema.optional() },
      annotations: readOnly,
    },
    safe(async ({ symbol, ...sel }) => {
      const q = who(sel);
      const query = { symbol, ...q };
      const res = await client.get<{ orders: Record<string, unknown>[]; count: number }>("/v2/openOrders", query);
      return ok({
        count: res?.count ?? res?.orders?.length ?? 0,
        orders: (res?.orders ?? []).map((o) => ({
          order_id: o.ID,
          client_order_id: o.ClientOrderID || null,
          symbol: o.Symbol,
          side: o.Side,
          type: o.Type,
          status: o.Status,
          size: o.Size,
          filled: o.Filled,
          price: o.Price,
          stop_price: o.StopPrice,
          reduce_only: o.ReduceOnly,
          post_only: o.PostOnly,
          time_in_force: o.TimeInForce,
          strategy: o.Strategy ?? null,
          trailing: o.Trailing ?? null,
          created: typeof o.CreateTimestamp === "number" ? new Date(o.CreateTimestamp).toISOString() : null,
        })),
      });
    }),
  );

  const HISTORY_PATHS = {
    orders: "/v2/history/order",
    fills: "/v2/history/fill",
    funding: "/v2/history/funding",
    positions: "/v2/history/position",
    transactions: "/v2/history/transaction",
  } as const;

  server.registerTool(
    "strike_get_history",
    {
      title: "Account history",
      description:
        "Account history: orders, fills (trades), funding payments, closed positions, or transactions " +
        "(deposits, withdrawals, transfers). Newest first. Use cursor (an id from the last row) to page back.",
      inputSchema: {
        ...accountSelectorShape,
        kind: z.enum(["orders", "fills", "funding", "positions", "transactions"]),
        symbol: symbolSchema.optional(),
        since: z.string().optional().describe("ISO date/time; only records after this."),
        until: z.string().optional().describe("ISO date/time; only records before this."),
        limit: z.number().int().min(1).max(500).default(50),
        cursor: z.number().int().optional().describe("Return records older than this id (from a previous page)."),
      },
      annotations: readOnly,
    },
    safe(async ({ kind, symbol, since, until, limit, cursor, ...sel }) => {
      const toMs = (s?: string) => {
        if (!s) return undefined;
        const t = Date.parse(s);
        if (Number.isNaN(t)) throw new Error(`Could not parse date '${s}'. Use ISO format, e.g. 2026-10-01.`);
        return t;
      };
      const cursorKey = kind === "orders" ? "fromOrderID" : kind === "positions" ? "cursor" : "fromId";
      const res = await client.get<unknown>(HISTORY_PATHS[kind], {
        ...who(sel),
        symbol,
        startTime: toMs(since),
        endTime: toMs(until),
        limit,
        [cursorKey]: cursor,
      });
      return ok({ kind, ...(res && typeof res === "object" && !Array.isArray(res) ? res : { rows: res }) });
    }),
  );

  server.registerTool(
    "strike_get_portfolio",
    {
      title: "Portfolio performance",
      description:
        "Long-run performance: realized PnL, all-time volume and fees, deposits/withdrawals, current fee tier, " +
        "staking fee discount (from staked STRIKE), 30-day volume, and a recent account-value curve.",
      inputSchema: {
        ...accountSelectorShape,
        history_points: z.number().int().min(0).max(500).default(30),
      },
      annotations: readOnly,
    },
    safe(async ({ history_points, ...sel }) => {
      const p = await client.get<Record<string, unknown>>("/v2/portfolio", who(sel));
      const history = (p.history_perp_only as unknown[][] | undefined) ?? [];
      return ok({
        account: p.account,
        capital_flows: p.capital_flows,
        all_time_volume: p.volume,
        all_time_fees: p.fees,
        all_time_maker_rebates: p.all_time_maker_rebates,
        fee_tier: p.fee_tier,
        staked_strike_for_discount: p.staking_fee_discount_staked_strike,
        staking_fee_discount_rate: p.staking_fee_discount_rate,
        referral_fee_discount_pct: p.fee_discount_rate,
        trading_enabled: p.is_trading_enabled,
        volume_last_30d: p.volume_history,
        account_value_history: history_points
          ? history.slice(-history_points).map((h) => ({
              time: new Date(Number(h[0])).toISOString(),
              account_value: h[1],
              realized_pnl: h[2],
              unrealized_pnl: h[3],
              cumulative_volume: h[4],
            }))
          : [],
      });
    }),
  );
}
