import { Decimal } from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const D = (v: Decimal.Value) => new Decimal(v);
const fmt = (d: Decimal, dp = 8) => d.toDecimalPlaces(dp).toString();

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

export interface DepthSnapshot {
  bids: [string, string][];
  asks: [string, string][];
  E?: number;
}

export interface BookSummary {
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  spread: string | null;
  spread_bps: string | null;
  /** Liquidity resting within N% of mid, per side, in USD. */
  depth_usd: Record<string, { bids: string; asks: string }>;
  /** (bid_usd - ask_usd) / (bid_usd + ask_usd) within 1% of mid. +1 = all bids. */
  imbalance_1pct: string | null;
  levels: { bids: number; asks: number };
}

export function summarizeBook(book: DepthSnapshot, bands: number[] = [0.5, 1, 2]): BookSummary {
  const bestBid = book.bids[0] ? D(book.bids[0][0]) : null;
  const bestAsk = book.asks[0] ? D(book.asks[0][0]) : null;
  const mid = bestBid && bestAsk ? bestBid.plus(bestAsk).div(2) : (bestBid ?? bestAsk);

  const depth_usd: BookSummary["depth_usd"] = {};
  let imbalance: string | null = null;
  if (mid) {
    for (const pct of bands) {
      const lo = mid.mul(1 - pct / 100);
      const hi = mid.mul(1 + pct / 100);
      const bidUsd = book.bids
        .filter(([p]) => D(p).gte(lo))
        .reduce((acc, [p, q]) => acc.plus(D(p).mul(q)), D(0));
      const askUsd = book.asks
        .filter(([p]) => D(p).lte(hi))
        .reduce((acc, [p, q]) => acc.plus(D(p).mul(q)), D(0));
      depth_usd[`${pct}%`] = { bids: fmt(bidUsd, 2), asks: fmt(askUsd, 2) };
      if (pct === 1) {
        const total = bidUsd.plus(askUsd);
        imbalance = total.isZero() ? null : fmt(bidUsd.minus(askUsd).div(total), 4);
      }
    }
  }

  const spread = bestBid && bestAsk ? bestAsk.minus(bestBid) : null;
  return {
    best_bid: bestBid?.toString() ?? null,
    best_ask: bestAsk?.toString() ?? null,
    mid: mid ? fmt(mid) : null,
    spread: spread?.toString() ?? null,
    spread_bps: spread && mid && !mid.isZero() ? fmt(spread.div(mid).mul(10_000), 2) : null,
    depth_usd,
    imbalance_1pct: imbalance,
    levels: { bids: book.bids.length, asks: book.asks.length },
  };
}

export interface FillEstimate {
  side: "buy" | "sell";
  requested_size: string;
  fillable_size: string;
  fully_fillable: boolean;
  avg_price: string | null;
  worst_price: string | null;
  notional_usd: string;
  slippage_bps_vs_mid: string | null;
  levels_consumed: number;
}

/** Walks the visible book to estimate a market order's average fill. */
export function estimateMarketFill(book: DepthSnapshot, side: "buy" | "sell", size: Decimal.Value): FillEstimate {
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = D(size);
  let filled = D(0);
  let cost = D(0);
  let worst: Decimal | null = null;
  let consumed = 0;
  for (const [p, q] of levels) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, D(q));
    filled = filled.plus(take);
    cost = cost.plus(take.mul(p));
    remaining = remaining.minus(take);
    worst = D(p);
    consumed++;
  }
  const summary = summarizeBook(book);
  const avg = filled.gt(0) ? cost.div(filled) : null;
  const mid = summary.mid ? D(summary.mid) : null;
  const slippage =
    avg && mid && !mid.isZero()
      ? (side === "buy" ? avg.minus(mid) : mid.minus(avg)).div(mid).mul(10_000)
      : null;
  return {
    side,
    requested_size: D(size).toString(),
    fillable_size: filled.toString(),
    fully_fillable: remaining.lte(0),
    avg_price: avg ? fmt(avg) : null,
    worst_price: worst?.toString() ?? null,
    notional_usd: fmt(cost, 2),
    slippage_bps_vs_mid: slippage ? fmt(slippage, 2) : null,
    levels_consumed: consumed,
  };
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export interface FundingView {
  rate_per_hour: string;
  rate_per_hour_pct: string;
  rate_8h_pct: string;
  apr_pct: string;
  payer: "longs pay shorts" | "shorts pay longs" | "neutral";
  /** Cost (+) or income (-) per $10k of long exposure per day. */
  long_cost_per_10k_per_day_usd: string;
}

/**
 * Strike pays funding hourly; the rate applied each hour is the 8h rate / 8.
 * We treat the API's funding rate as the per-hour rate that hits positions.
 */
export function describeFunding(ratePerHour: Decimal.Value): FundingView {
  const r = D(ratePerHour);
  return {
    rate_per_hour: r.toString(),
    rate_per_hour_pct: fmt(r.mul(100), 6),
    rate_8h_pct: fmt(r.mul(8 * 100), 6),
    apr_pct: fmt(r.mul(24 * 365 * 100), 2),
    payer: r.gt(0) ? "longs pay shorts" : r.lt(0) ? "shorts pay longs" : "neutral",
    long_cost_per_10k_per_day_usd: fmt(r.mul(24).mul(10_000), 4),
  };
}

// ---------------------------------------------------------------------------
// Position risk
// ---------------------------------------------------------------------------

export interface RawPosition {
  symbol: string;
  size: string;
  entry_price: string;
  leverage: number;
  margin_mode: string;
  upnl: string;
  liquidation_price: string;
  maintenance_margin?: string;
  accumulated_funding_fees?: string;
  iso_balance?: string;
}

export type RiskLevel = "ok" | "watch" | "danger";

export interface PositionRisk {
  symbol: string;
  side: "long" | "short" | "flat";
  size: string;
  entry_price: string;
  mark_price: string | null;
  notional_usd: string | null;
  leverage: number;
  margin_mode: string;
  upnl_usd: string;
  upnl_pct_of_margin: string | null;
  liquidation_price: string;
  distance_to_liquidation_pct: string | null;
  risk: RiskLevel;
  accumulated_funding_fees: string | null;
  funding: FundingView | null;
  /** Funding this position pays (+) or earns (-) per day at the current rate. */
  funding_per_day_usd: string | null;
}

export function assessPosition(
  pos: RawPosition,
  markPrice: string | null,
  fundingRatePerHour: string | null,
  thresholds = { danger: 5, watch: 15 },
): PositionRisk {
  const size = D(pos.size);
  const side = size.gt(0) ? "long" : size.lt(0) ? "short" : "flat";
  const mark = markPrice ? D(markPrice) : null;
  const notional = mark ? mark.mul(size.abs()) : null;
  const liq = D(pos.liquidation_price || "0");

  let distance: Decimal | null = null;
  if (mark && !mark.isZero() && liq.gt(0)) {
    distance = side === "long" ? mark.minus(liq).div(mark).mul(100) : liq.minus(mark).div(mark).mul(100);
  }

  let risk: RiskLevel = "ok";
  if (distance !== null) {
    if (distance.lte(thresholds.danger)) risk = "danger";
    else if (distance.lte(thresholds.watch)) risk = "watch";
  }

  const initialMargin = notional && pos.leverage > 0 ? notional.div(pos.leverage) : null;
  const upnl = D(pos.upnl || "0");
  const fundingPerDay =
    fundingRatePerHour && notional ? D(fundingRatePerHour).mul(24).mul(notional).mul(size.gt(0) ? 1 : -1) : null;

  return {
    symbol: pos.symbol,
    side,
    size: pos.size,
    entry_price: pos.entry_price,
    mark_price: mark?.toString() ?? null,
    notional_usd: notional ? fmt(notional, 2) : null,
    leverage: pos.leverage,
    margin_mode: pos.margin_mode,
    upnl_usd: fmt(upnl, 2),
    upnl_pct_of_margin: initialMargin && !initialMargin.isZero() ? fmt(upnl.div(initialMargin).mul(100), 2) : null,
    liquidation_price: pos.liquidation_price,
    distance_to_liquidation_pct: distance ? fmt(distance, 2) : null,
    risk,
    accumulated_funding_fees: pos.accumulated_funding_fees ?? null,
    funding: fundingRatePerHour ? describeFunding(fundingRatePerHour) : null,
    funding_per_day_usd: fundingPerDay ? fmt(fundingPerDay, 4) : null,
  };
}

// ---------------------------------------------------------------------------
// Order validation against exchange filters
// ---------------------------------------------------------------------------

export interface SymbolFilter {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  notional?: string;
}

export interface SymbolInfo {
  symbol: string;
  status?: string;
  filters?: SymbolFilter[];
  orderType?: string[];
}

export interface OrderCheck {
  errors: string[];
  warnings: string[];
}

function isMultiple(value: Decimal, step: string | undefined): boolean {
  if (!step) return true;
  const s = D(step);
  if (s.isZero()) return true;
  return value.mod(s).isZero();
}

export function checkOrderAgainstFilters(
  info: SymbolInfo,
  order: { type: string; size: string; price?: string; stop_price?: string },
  referencePrice: string | null,
): OrderCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const filters = Object.fromEntries((info.filters ?? []).map((f) => [f.filterType, f]));
  const size = D(order.size);

  if (info.status && !["trading", "TRADING", "ACTIVE"].includes(info.status)) {
    errors.push(`Market ${info.symbol} is not trading (status: ${info.status}).`);
  }
  if (size.lte(0)) errors.push("Size must be positive.");

  const lot = order.type === "market" ? (filters.MARKET_LOT_SIZE ?? filters.LOT_SIZE) : filters.LOT_SIZE;
  if (lot) {
    if (lot.minQty && size.lt(lot.minQty)) errors.push(`Size ${size} is below the minimum ${lot.minQty}.`);
    if (lot.maxQty && D(lot.maxQty).gt(0) && size.gt(lot.maxQty))
      errors.push(`Size ${size} is above the maximum ${lot.maxQty}.`);
    if (!isMultiple(size, lot.stepSize)) errors.push(`Size ${size} is not a multiple of the step size ${lot.stepSize}.`);
  }

  const pf = filters.PRICE_FILTER;
  for (const [label, raw] of [
    ["Price", order.price],
    ["Stop price", order.stop_price],
  ] as const) {
    if (!raw) continue;
    const p = D(raw);
    if (p.lte(0)) errors.push(`${label} must be positive.`);
    if (pf) {
      if (pf.minPrice && D(pf.minPrice).gt(0) && p.lt(pf.minPrice))
        errors.push(`${label} ${p} is below the minimum ${pf.minPrice}.`);
      if (pf.maxPrice && D(pf.maxPrice).gt(0) && p.gt(pf.maxPrice))
        errors.push(`${label} ${p} is above the maximum ${pf.maxPrice}.`);
      if (!isMultiple(p, pf.tickSize)) errors.push(`${label} ${p} is not a multiple of the tick size ${pf.tickSize}.`);
    }
  }

  const minNotional = filters.MIN_NOTIONAL?.notional;
  const px = order.price ?? referencePrice;
  if (minNotional && px && size.mul(px).lt(minNotional)) {
    errors.push(`Order notional ${fmt(size.mul(px), 2)} USD is below the market minimum ${minNotional} USD.`);
  }
  return { errors, warnings };
}

/** Rounds a value down to a multiple of `step` (for size suggestions). */
export function floorToStep(value: Decimal.Value, step: string): string {
  const s = D(step);
  if (s.isZero()) return D(value).toString();
  return D(value).div(s).floor().mul(s).toString();
}

export function notional(size: Decimal.Value, price: Decimal.Value): string {
  return fmt(D(size).mul(price), 2);
}

// ---------------------------------------------------------------------------
// Klines
// ---------------------------------------------------------------------------

export interface Candle {
  open_time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quote_volume: string;
  trades: number;
}

export function parseKlines(raw: unknown[][]): Candle[] {
  return raw.map((k) => ({
    open_time: new Date(Number(k[0])).toISOString(),
    open: String(k[1]),
    high: String(k[2]),
    low: String(k[3]),
    close: String(k[4]),
    volume: String(k[5]),
    quote_volume: String(k[7]),
    trades: Number(k[8]),
  }));
}

export interface CandleStats {
  candles: number;
  first_open: string | null;
  last_close: string | null;
  change_pct: string | null;
  high: string | null;
  low: string | null;
  /** Std-dev of close-to-close returns, in %, per candle. */
  volatility_pct_per_candle: string | null;
  total_quote_volume: string;
}

export function candleStats(candles: Candle[]): CandleStats {
  if (!candles.length) {
    return {
      candles: 0,
      first_open: null,
      last_close: null,
      change_pct: null,
      high: null,
      low: null,
      volatility_pct_per_candle: null,
      total_quote_volume: "0",
    };
  }
  const first = D(candles[0].open);
  const last = D(candles[candles.length - 1].close);
  const high = Decimal.max(...candles.map((c) => D(c.high)));
  const low = Decimal.min(...candles.map((c) => D(c.low)));
  const returns: Decimal[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = D(candles[i - 1].close);
    if (!prev.isZero()) returns.push(D(candles[i].close).div(prev).minus(1));
  }
  let vol: Decimal | null = null;
  if (returns.length > 1) {
    const mean = returns.reduce((a, b) => a.plus(b), D(0)).div(returns.length);
    const variance = returns.reduce((a, r) => a.plus(r.minus(mean).pow(2)), D(0)).div(returns.length - 1);
    vol = variance.sqrt().mul(100);
  }
  return {
    candles: candles.length,
    first_open: first.toString(),
    last_close: last.toString(),
    change_pct: first.isZero() ? null : fmt(last.div(first).minus(1).mul(100), 2),
    high: high.toString(),
    low: low.toString(),
    volatility_pct_per_candle: vol ? fmt(vol, 4) : null,
    total_quote_volume: fmt(
      candles.reduce((a, c) => a.plus(D(c.quote_volume || "0")), D(0)),
      2,
    ),
  };
}
