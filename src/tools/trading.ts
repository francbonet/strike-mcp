import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Decimal } from "decimal.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  checkOrderAgainstFilters,
  estimateMarketFill,
  floorToStep,
  summarizeBook,
  type FillEstimate,
  type RawPosition,
  type SymbolInfo,
} from "../analytics.js";
import type { StrikeClient } from "../client.js";
import type { Config } from "../config.js";
import { PreviewStore } from "../guard.js";
import { fetchDepth, fetchPremium } from "./market.js";
import { ok, safe, symbolSchema } from "./shared.js";

const ORDER_TYPES = [
  "limit",
  "market",
  "stop",
  "stop_limit",
  "take_profit",
  "take_profit_limit",
  "trailing_stop_market",
] as const;
type OrderType = (typeof ORDER_TYPES)[number];

/** Market drift (vs. preview) above which a market order must be re-previewed. */
const MAX_MARKET_DRIFT_PCT = 1;
const EXCHANGE_INFO_TTL_MS = 5 * 60_000;

const D = (v: Decimal.Value) => new Decimal(v);

export interface OrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  size?: string;
  notional_usd?: number;
  price?: string;
  stop_price?: string;
  time_in_force?: "GTC" | "IOC" | "FOK";
  post_only?: boolean;
  reduce_only?: boolean;
  max_slippage_pct?: number;
  callback_rate_pct?: number;
  activation_price?: string;
  take_profit?: { trigger_price: string; limit_price?: string };
  stop_loss?: { trigger_price: string; limit_price?: string };
  sub_account_id?: string;
}

interface SymbolSettings {
  default_leverage?: number;
  symbol_settings?: Record<string, { leverage: number; margin_mode: string }>;
}

export class OrderPlanner {
  private exchangeInfo: { at: number; symbols: Map<string, SymbolInfo> } | null = null;

  constructor(
    private readonly client: StrikeClient,
    private readonly config: Config,
    readonly previews: PreviewStore,
  ) {}

  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    if (!this.exchangeInfo || Date.now() - this.exchangeInfo.at > EXCHANGE_INFO_TTL_MS) {
      const res = await this.client.market<{ symbols: SymbolInfo[] }>("/v2/exchangeInfo");
      this.exchangeInfo = { at: Date.now(), symbols: new Map((res.symbols ?? []).map((s) => [s.symbol, s])) };
    }
    const info = this.exchangeInfo.symbols.get(symbol);
    if (!info) throw new Error(`Unknown market ${symbol}. Use strike_list_markets to see valid symbols.`);
    return info;
  }

  async preview(input: OrderInput) {
    const { symbol, side } = input;
    const sub = input.sub_account_id ? { sub_account_id: input.sub_account_id } : {};
    const [info, book, premium, settings, account, positions] = await Promise.all([
      this.symbolInfo(symbol),
      fetchDepth(this.client, symbol, 1000),
      fetchPremium(this.client, symbol),
      this.client.get<SymbolSettings>("/v2/symbols", sub).catch(() => null),
      this.client.get<{ available_balance?: string }>("/v2/account", sub).catch(() => null),
      this.client.get<{ positions: RawPosition[] }>("/v2/positions", { symbol, ...sub }).catch(() => null),
    ]);

    const errors: string[] = [];
    const warnings: string[] = [];
    const mark = premium[0]?.markPrice ?? null;
    const bookSummary = summarizeBook(book);
    const lot = info.filters?.find((f) => f.filterType === (input.type === "market" ? "MARKET_LOT_SIZE" : "LOT_SIZE"))
      ?? info.filters?.find((f) => f.filterType === "LOT_SIZE");

    // --- Required fields per type -------------------------------------------------
    const needsPrice = ["limit", "stop_limit", "take_profit_limit"].includes(input.type);
    const needsStop = ["stop", "stop_limit", "take_profit", "take_profit_limit"].includes(input.type);
    if (needsPrice && !input.price) errors.push(`A ${input.type} order needs a price.`);
    if (needsStop && !input.stop_price) errors.push(`A ${input.type} order needs a stop_price (trigger).`);
    if (input.type === "trailing_stop_market" && input.callback_rate_pct === undefined)
      errors.push("A trailing_stop_market order needs callback_rate_pct (0.1 to 5).");
    if ((input.take_profit || input.stop_loss) && !["limit", "market"].includes(input.type))
      errors.push("Take-profit / stop-loss brackets can only be attached to limit or market entries.");

    // --- Reference price & size ---------------------------------------------------
    const referencePrice =
      input.price ?? input.stop_price ?? input.activation_price ?? mark ?? bookSummary.mid ?? null;
    let size = input.size;
    if (!size && input.notional_usd !== undefined) {
      if (!referencePrice) throw new Error(`No price available for ${symbol} to convert notional into size.`);
      const raw = D(input.notional_usd).div(referencePrice);
      size = lot?.stepSize ? floorToStep(raw, lot.stepSize) : raw.toDecimalPlaces(8).toString();
    }

    const currentPosition = positions?.positions?.find((p) => p.symbol === symbol);
    const currentSize = D(currentPosition?.size ?? "0");
    if (!size) throw new Error("Provide size (base asset) or notional_usd.");

    // --- Market fill estimate -----------------------------------------------------
    let fill: FillEstimate | null = null;
    if (input.type === "market") {
      fill = estimateMarketFill(book, side, size);
      if (!fill.fully_fillable) {
        errors.push(
          `Visible liquidity only covers ${fill.fillable_size} of ${size} ${symbol}. Reduce size or use a limit order.`,
        );
      }
      const slip = fill.slippage_bps_vs_mid ? Number(fill.slippage_bps_vs_mid) : 0;
      const maxSlipBps = (input.max_slippage_pct ?? 1) * 100;
      if (slip > maxSlipBps) {
        errors.push(`Estimated slippage ${slip} bps exceeds the ${maxSlipBps} bps limit (max_slippage_pct).`);
      } else if (slip > 50) {
        warnings.push(`Estimated slippage is ${slip} bps.`);
      }
    }

    const execPrice = fill?.avg_price ?? referencePrice;
    const notionalUsd = execPrice ? D(size).mul(execPrice) : null;

    // --- Exchange filters ---------------------------------------------------------
    const filterCheck = checkOrderAgainstFilters(
      info,
      { type: input.type, size, price: input.price, stop_price: input.stop_price },
      execPrice,
    );
    errors.push(...filterCheck.errors);
    warnings.push(...filterCheck.warnings);

    // --- Directional sanity -------------------------------------------------------
    if (input.type === "limit" && input.price) {
      const crosses =
        side === "buy"
          ? bookSummary.best_ask && D(input.price).gte(bookSummary.best_ask)
          : bookSummary.best_bid && D(input.price).lte(bookSummary.best_bid);
      if (crosses) {
        if (input.post_only) errors.push("Post-only limit would cross the book and be rejected.");
        else warnings.push("This limit price crosses the book: it will fill immediately as a taker.");
      }
      if (mark) {
        const away = D(input.price).div(mark).minus(1).mul(100).abs();
        if (away.gt(10)) warnings.push(`Limit price is ${away.toFixed(1)}% away from the mark price (${mark}).`);
      }
    }
    if (input.stop_price && mark && ["stop", "stop_limit", "take_profit", "take_profit_limit"].includes(input.type)) {
      const above = D(input.stop_price).gt(mark);
      // Stops fire on adverse moves, take-profits on favourable ones, relative to the side of THIS order.
      const isStop = input.type.startsWith("stop");
      const expectAbove = isStop ? side === "buy" : side === "sell";
      if (above !== expectAbove) {
        warnings.push(
          `Trigger ${input.stop_price} is ${above ? "above" : "below"} the mark (${mark}); a ${side} ${input.type} ` +
            `usually triggers ${expectAbove ? "above" : "below"} it, so it may trigger immediately.`,
        );
      }
    }
    if (input.take_profit || input.stop_loss) {
      const entry = D(execPrice ?? "0");
      const long = side === "buy";
      if (input.take_profit) {
        const tp = D(input.take_profit.trigger_price);
        if (long ? tp.lte(entry) : tp.gte(entry))
          errors.push(`Take-profit ${tp} must be ${long ? "above" : "below"} the entry (~${entry.toDecimalPlaces(4)}).`);
      }
      if (input.stop_loss) {
        const sl = D(input.stop_loss.trigger_price);
        if (long ? sl.gte(entry) : sl.lte(entry))
          errors.push(`Stop-loss ${sl} must be ${long ? "below" : "above"} the entry (~${entry.toDecimalPlaces(4)}).`);
      }
    }

    // --- Position effect ----------------------------------------------------------
    const signed = side === "buy" ? D(size) : D(size).neg();
    const reducing = !currentSize.isZero() && currentSize.isPositive() !== signed.isPositive();
    if (input.reduce_only) {
      if (currentSize.isZero()) errors.push(`Reduce-only order but there is no open ${symbol} position.`);
      else if (!reducing) errors.push(`Reduce-only ${side} would increase the current ${symbol} position.`);
      else if (D(size).gt(currentSize.abs()))
        warnings.push(`Size exceeds the open position (${currentSize.abs()}); only the position will be closed.`);
    }

    // --- Risk limits --------------------------------------------------------------
    const leverage =
      settings?.symbol_settings?.[symbol]?.leverage ?? settings?.default_leverage ?? null;
    const initialMargin = notionalUsd && leverage ? notionalUsd.div(leverage) : null;
    const available = account?.available_balance ? D(account.available_balance) : null;
    if (!input.reduce_only && notionalUsd && notionalUsd.gt(this.config.maxOrderNotionalUsd)) {
      errors.push(
        `Order notional ${notionalUsd.toFixed(2)} USD exceeds the server's safety cap of ` +
          `${this.config.maxOrderNotionalUsd} USD (STRIKE_MAX_ORDER_NOTIONAL_USD).`,
      );
    }
    if (!input.reduce_only && !reducing && initialMargin && available && initialMargin.gt(available)) {
      errors.push(
        `Needs ~${initialMargin.toFixed(2)} USD initial margin at ${leverage}x but only ${available.toFixed(2)} USD is available.`,
      );
    }

    // --- Build the exact request --------------------------------------------------
    const clientOrderId = `smcp-${randomBytes(5).toString("hex")}`;
    const base: Record<string, unknown> = {
      client_order_id: clientOrderId,
      symbol,
      side,
      type: input.type,
      size,
      ...(input.price && { price: input.price }),
      ...(input.stop_price && { stop_price: input.stop_price }),
      ...(input.time_in_force && { time_in_force: input.time_in_force }),
      ...(input.post_only && { post_only: true }),
      ...(input.reduce_only && { reduce_only: true }),
      ...(input.type === "market" &&
        input.max_slippage_pct !== undefined && { slippage: D(input.max_slippage_pct).div(100).toString() }),
      ...(input.callback_rate_pct !== undefined && { callback_rate: String(input.callback_rate_pct) }),
      ...(input.activation_price && { activation_price: input.activation_price }),
      ...sub,
    };

    let path: "/v2/order" | "/v2/order/strategy" = "/v2/order";
    let body = base;
    if (input.take_profit || input.stop_loss) {
      path = "/v2/order/strategy";
      const leg = (kind: "tp" | "sl", l: { trigger_price: string; limit_price?: string }) => ({
        client_order_id: `${clientOrderId}-${kind}`,
        type:
          kind === "tp" ? (l.limit_price ? "take_profit_limit" : "take_profit") : l.limit_price ? "stop_limit" : "stop",
        size,
        stop_price: l.trigger_price,
        ...(l.limit_price && { price: l.limit_price }),
        working_type: "mark_price",
      });
      body = {
        ...base,
        strategy_id: `${clientOrderId}-strat`,
        ...(input.take_profit && { tp_order: leg("tp", input.take_profit) }),
        ...(input.stop_loss && { sl_order: leg("sl", input.stop_loss) }),
      };
    }

    const summary = {
      market: symbol,
      action: `${side.toUpperCase()} ${size} ${symbol} (${input.type}${input.reduce_only ? ", reduce-only" : ""})`,
      price: input.price ?? null,
      trigger: input.stop_price ?? null,
      estimated_fill: fill,
      estimated_notional_usd: notionalUsd?.toFixed(2) ?? null,
      mark_price: mark,
      leverage: leverage ? `${leverage}x` : "account default (unknown)",
      estimated_initial_margin_usd: initialMargin?.toFixed(2) ?? null,
      available_balance_usd: available?.toFixed(2) ?? null,
      position_before: currentSize.toString(),
      position_after_if_filled: input.reduce_only && reducing && D(size).gt(currentSize.abs())
        ? "0"
        : currentSize.plus(signed).toString(),
      take_profit: input.take_profit ?? null,
      stop_loss: input.stop_loss ?? null,
    };

    if (errors.length) {
      return { ok: false as const, errors, warnings, summary };
    }

    const pending = this.previews.add({
      path,
      body,
      symbol,
      markAtPreview: mark,
      isMarket: input.type === "market",
      summary,
    });
    return {
      ok: true as const,
      preview_id: pending.id,
      expires_at: new Date(pending.expiresAt).toISOString(),
      network: this.config.network,
      summary,
      warnings,
      request: { path, body },
    };
  }

  async execute(previewId: string) {
    const p = this.previews.take(previewId);
    if (p.isMarket && p.markAtPreview) {
      const now = (await fetchPremium(this.client, p.symbol))[0]?.markPrice;
      if (now) {
        const drift = D(now).div(p.markAtPreview).minus(1).mul(100).abs();
        if (drift.gt(MAX_MARKET_DRIFT_PCT)) {
          throw new Error(
            `${p.symbol} mark moved ${drift.toFixed(2)}% since the preview (${p.markAtPreview} → ${now}). ` +
              "Preview again and re-confirm with the user.",
          );
        }
      }
    }
    const response = await this.client.post<Record<string, unknown>>(p.path, p.body);
    return { placed: p.summary.action, network: this.config.network, request: { path: p.path, body: p.body }, response };
  }
}

export function registerTradingTools(server: McpServer, client: StrikeClient, config: Config) {
  const planner = new OrderPlanner(client, config, new PreviewStore(config.previewTtlMs));
  const PREVIEW_NOTE =
    "Nothing has been sent. Show the summary and warnings to the user and only call strike_place_order " +
    "with this preview_id after they explicitly confirm.";

  const bracketLeg = z
    .object({
      trigger_price: z.string().describe("Price that triggers the leg (mark price)."),
      limit_price: z.string().optional().describe("Optional limit price; omit for a market exit."),
    })
    .optional();

  server.registerTool(
    "strike_preview_order",
    {
      title: "Preview an order (step 1 of 2)",
      description:
        "Validates and prices an order WITHOUT sending it: checks tick/step/min-notional rules, simulates market " +
        "fills against the book, checks margin and the server's notional safety cap, and shows the position before " +
        "and after. Supports take-profit / stop-loss brackets. Returns a short-lived preview_id. " +
        "Always show the summary to the user and get explicit confirmation before strike_place_order.",
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(["buy", "sell"]).describe("buy = long / close short, sell = short / close long."),
        type: z.enum(ORDER_TYPES).default("limit"),
        size: z.string().optional().describe("Size in base asset, e.g. '100' ADA. Or use notional_usd."),
        notional_usd: z.number().positive().optional().describe("Size the order by USD value instead of base size."),
        price: z.string().optional().describe("Limit price (limit, stop_limit, take_profit_limit)."),
        stop_price: z.string().optional().describe("Trigger price for stop / take-profit orders."),
        time_in_force: z.enum(["GTC", "IOC", "FOK"]).optional(),
        post_only: z.boolean().optional(),
        reduce_only: z.boolean().optional(),
        max_slippage_pct: z
          .number()
          .positive()
          .max(10)
          .optional()
          .describe("Market orders: refuse if estimated slippage exceeds this % (default 1)."),
        callback_rate_pct: z.number().min(0.1).max(5).optional().describe("Trailing stop distance in %."),
        activation_price: z.string().optional().describe("Trailing stop activation price."),
        take_profit: bracketLeg.describe("Attach a take-profit to a limit/market entry."),
        stop_loss: bracketLeg.describe("Attach a stop-loss to a limit/market entry."),
        sub_account_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (input) => {
      const result = await planner.preview(input as OrderInput);
      return ok(result, result.ok ? PREVIEW_NOTE : "Order rejected by pre-trade checks. Nothing was sent.");
    }),
  );

  server.registerTool(
    "strike_preview_close_position",
    {
      title: "Preview closing a position (step 1 of 2)",
      description:
        "Builds a reduce-only market order that closes all or part of an open position, with fill and slippage " +
        "estimates. Returns a preview_id for strike_place_order after the user confirms.",
      inputSchema: {
        symbol: symbolSchema,
        fraction: z.number().gt(0).max(1).default(1).describe("Portion to close: 1 = all, 0.5 = half."),
        max_slippage_pct: z.number().positive().max(10).default(1),
        sub_account_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ symbol, fraction, max_slippage_pct, sub_account_id }) => {
      const sub = sub_account_id ? { sub_account_id } : {};
      const [res, info] = await Promise.all([
        client.get<{ positions: RawPosition[] }>("/v2/positions", { symbol, ...sub }),
        planner.symbolInfo(symbol),
      ]);
      const pos = res?.positions?.find((p) => p.symbol === symbol);
      if (!pos || D(pos.size).isZero()) throw new Error(`No open ${symbol} position.`);
      const step = (info.filters?.find((f) => f.filterType === "MARKET_LOT_SIZE") ??
        info.filters?.find((f) => f.filterType === "LOT_SIZE"))?.stepSize;
      const abs = D(pos.size).abs();
      const size = fraction === 1 || !step ? abs.mul(fraction).toString() : floorToStep(abs.mul(fraction), step);
      const result = await planner.preview({
        symbol,
        side: D(pos.size).isPositive() ? "sell" : "buy",
        type: "market",
        size,
        reduce_only: true,
        max_slippage_pct,
        sub_account_id,
      });
      return ok(result, result.ok ? PREVIEW_NOTE : "Close rejected by pre-trade checks. Nothing was sent.");
    }),
  );

  server.registerTool(
    "strike_place_order",
    {
      title: "Place a previewed order (step 2 of 2)",
      description:
        "Sends an order previously validated by strike_preview_order / strike_preview_close_position. Only call " +
        "this after the user explicitly confirmed that exact preview. Previews are single-use and expire; market " +
        "orders are refused if the price moved more than 1% since the preview.",
      inputSchema: { preview_id: z.string().startsWith("pv_") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ preview_id }) => {
      const res = await planner.execute(preview_id);
      return ok(
        res,
        "Order submitted to the matching engine (processing is asynchronous). Check strike_get_open_orders or " +
          "strike_get_positions to confirm the result.",
      );
    }),
  );

  server.registerTool(
    "strike_cancel_order",
    {
      title: "Cancel an order",
      description: "Cancels one open order by order_id (from strike_get_open_orders).",
      inputSchema: {
        symbol: symbolSchema,
        order_id: z.number().int(),
        sub_account_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ symbol, order_id, sub_account_id }) =>
      ok(await client.delete("/v2/order/cancel", { order_id, symbol, ...(sub_account_id && { sub_account_id }) })),
    ),
  );

  server.registerTool(
    "strike_cancel_all_orders",
    {
      title: "Cancel all orders",
      description:
        "Cancels every open order, or every order in one market. Stops and take-profits protecting positions are " +
        "cancelled too, so confirm with the user first and pass confirm: true.",
      inputSchema: {
        symbol: symbolSchema.optional(),
        confirm: z.literal(true).describe("Must be true; set only after the user confirmed."),
        sub_account_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ symbol, sub_account_id }) =>
      ok(
        await client.delete("/v2/order/cancel-all", {
          ...(symbol && { symbol }),
          ...(sub_account_id && { sub_account_id }),
        }),
      ),
    ),
  );

  server.registerTool(
    "strike_set_leverage",
    {
      title: "Set leverage",
      description:
        "Sets leverage for a market. Applies to new positions only; existing positions keep their leverage. " +
        "Confirm with the user first.",
      inputSchema: {
        symbol: symbolSchema,
        leverage: z.number().int().min(1).max(125),
        sub_account_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ symbol, leverage, sub_account_id }) =>
      ok(await client.post("/v2/leverage", { symbol, leverage, ...(sub_account_id && { sub_account_id }) })),
    ),
  );

  return planner;
}
