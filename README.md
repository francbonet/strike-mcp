<div align="center">

<a href="https://strikefinance.org"><img src="https://www.strikefinance.org/logo.png" alt="Strike Finance" width="110"></a>

# strike-mcp

**Trade [Strike Finance](https://strikefinance.org) perps by talking to your AI.**

[![MCP server](https://img.shields.io/badge/MCP-stdio%20server-26fab0?style=flat-square)](https://modelcontextprotocol.io)
[![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-26fab0?style=flat-square&logo=nodedotjs&logoColor=black)](#setup)
[![License: MIT](https://img.shields.io/badge/license-MIT-26fab0?style=flat-square)](LICENSE)
[![Strike Hackathon](https://img.shields.io/badge/Strike%20Hackathon-Oct%202026-000000?style=flat-square)](https://strikefinance.org)

[Tools](#tools) · [Safety model](#safety-model) · [Setup](#setup) · [Configuration](#configuration)

</div>

`strike-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (and any MCP-capable agent: Claude Code, Codex, Cursor…) live access to [Strike Finance](https://strikefinance.org): markets, funding, order books, your positions and their liquidation risk, and, when you opt in, order placement behind a preview-and-confirm guardrail.

Ask things like:

- _"How are my Strike positions doing?"_
- _"Which markets have the most extreme funding right now?"_
- _"How much slippage would a $5k ADA market buy take?"_
- _"Long 500 ADA at 0.21 with a stop at 0.19 and take-profit at 0.25."_

## Why

Strike already ships _skills_ that help coding assistants **write** Strike integrations. `strike-mcp` is the runtime piece: it lets an agent **use** Strike directly. Every Strike user gets an analyst and a careful trading assistant without writing code, and every agent framework that speaks MCP becomes a new entry point to Strike's order book.

Three design choices make it more than an API wrapper:

1. **Answers, not payloads.** Tools return what a trader asks about: spread in bps, USD depth within 0.5/1/2% of mid, book imbalance, funding as APR with who pays whom, distance to liquidation with an ok/watch/danger flag, what each position pays or earns in funding per day, estimated market-order fills.
2. **Read-only by default, no keys required.** Point it at any Cardano/Ethereum/Solana wallet address and it reads that account's positions and history from Strike's public endpoints. Trading tools don't even exist unless you enable them.
3. **Guardrails an agent can't skip.** Orders are two-step. `strike_preview_order` validates and prices the order and returns a single-use, short-lived `preview_id`; `strike_place_order` accepts _only_ that id, so what the user confirmed is exactly what is sent. See [Safety model](#safety-model).

## Tools

**Market data** (public, no keys)

| Tool                            | What it answers                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `strike_list_markets`           | All markets ranked by volume, 24h move, open interest or funding. Filter by category (Crypto, TradFi…).               |
| `strike_market_snapshot`        | One-call brief: price, range, volume, OI, funding (hourly/8h/APR, who pays), mark-vs-index premium, spread and depth. |
| `strike_get_orderbook`          | Top levels plus spread, USD depth bands and imbalance.                                                                |
| `strike_estimate_market_impact` | Simulates a market order by size or USD against the live book: average fill, worst price, slippage in bps.            |
| `strike_get_candles`            | OHLCV with change, range, volatility and volume stats.                                                                |
| `strike_get_recent_trades`      | Recent prints with taker buy/sell flow and the largest trade.                                                         |
| `strike_get_funding`            | Funding for one or all markets, ranked by absolute APR (carry and crowding scan).                                     |
| `strike_get_sentiment`          | Strike's own Fear & Greed index and its components.                                                                   |

**Account** (your API wallet, or any public wallet address)

| Tool                     | What it answers                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `strike_get_account`     | Balances, available margin, uPnL, margin ratio, withdrawable, per-market leverage.                                                      |
| `strike_get_positions`   | Positions with mark, notional, PnL % of margin, distance to liquidation, risk flag, funding paid/earned per day, plus portfolio totals. |
| `strike_get_open_orders` | Open and untriggered orders, including brackets and trailing stops.                                                                     |
| `strike_get_history`     | Orders, fills, funding payments, closed positions or transactions, with date filters and paging.                                        |
| `strike_get_portfolio`   | Realized PnL, volume, fees, fee tier, staked-STRIKE fee discount, account-value curve.                                                  |

**Trading** (only with `STRIKE_ENABLE_TRADING=true`)

| Tool                                               | What it does                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strike_preview_order`                             | Validates and prices any order type (limit, market, stop, stop-limit, take-profit, trailing stop), optionally with take-profit/stop-loss brackets. Sends nothing. |
| `strike_preview_close_position`                    | Reduce-only market close of all or part of a position, with fill estimate.                                                                                        |
| `strike_place_order`                               | Sends a previewed order by `preview_id`.                                                                                                                          |
| `strike_cancel_order` / `strike_cancel_all_orders` | Cancel one, or all (requires `confirm: true`).                                                                                                                    |
| `strike_set_leverage`                              | Leverage for new positions in a market.                                                                                                                           |

**Prompts:** `strike_daily_brief` (what's moving, funding extremes, sentiment, your positions) and `strike_risk_check` (stress-test positions against an adverse move).

## Safety model

`strike_preview_order` runs these checks before a `preview_id` exists:

- **Exchange rules** from `/v2/exchangeInfo`: tick size, step size, min/max quantity, min notional, market status.
- **Market fills** walked against the live book. Refused if visible liquidity can't cover the size or slippage exceeds `max_slippage_pct` (default 1%).
- **Margin**: estimated initial margin at the market's leverage vs. available balance.
- **Notional cap**: no single order above `STRIKE_MAX_ORDER_NOTIONAL_USD` (default $1,000). Reduce-only closes are exempt.
- **Direction sanity**: brackets must sit on the right side of entry; reduce-only orders must actually reduce; crossing limits and stops that would trigger immediately are flagged.
- **Position effect**: shows the position before and after.

Then `strike_place_order`:

- accepts only a `preview_id` (not order parameters), so the agent cannot alter a confirmed order;
- the id is **single-use** and **expires** (default 120 s);
- market orders are **refused if the mark moved more than 1%** since the preview.

On top of that, Strike API wallets **cannot withdraw funds**: the worst case is bounded to trading.

## Setup

Requires Node.js 20+.

```bash
git clone https://github.com/francbonet/strike-mcp.git && cd strike-mcp
npm install && npm run build
```

### Choose a mode

Every variable is optional. Set only what the mode you want needs:

| Mode                  | Variables                                          | What you get                                                                                           |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Market data           | none                                               | Market data tools only.                                                                                |
| Read-only account     | `STRIKE_WALLET_ADDRESS`                            | Plus positions, orders, history and portfolio of that wallet, from Strike's public endpoints. No keys. |
| API wallet, read-only | `STRIKE_API_PUBLIC_KEY` + `STRIKE_API_PRIVATE_KEY` | Your own account through signed requests. Still no trading tools.                                      |
| Trading               | API wallet + `STRIKE_ENABLE_TRADING=true`          | Adds the trading tools. Set `STRIKE_MAX_ORDER_NOTIONAL_USD` to lower the $1,000 per-order cap.         |

The two keys go together: set both or neither. To create an API wallet:

```bash
node dist/index.js keygen   # prints a new Ed25519 key pair
```

Register the **public** key at <https://app.strikefinance.org/api-keys>. Try trading on `STRIKE_NETWORK=testnet` first.

### Passing the variables

The server reads its configuration from its own process environment and **does not load `.env` by itself**. Either:

- **put the variables in your client's config**, as in the examples below (`env` block or `-e` flags), or
- **keep them in a `.env` file** (`cp .env.example .env`) and have Node load it with `--env-file` (Node 20.6+). Your keys then stay in that file instead of the client's config:

  ```bash
  claude mcp add strike -- node --env-file=/absolute/path/to/strike-mcp/.env /absolute/path/to/strike-mcp/dist/index.js
  ```

  In JSON configs that is `"args": ["--env-file=/absolute/path/to/strike-mcp/.env", "/absolute/path/to/strike-mcp/dist/index.js"]` with no `env` block. Use absolute paths: clients don't launch the server from the project folder.

Then register it in your client: [Claude Desktop](#claude-desktop) · [Claude Code](#claude-code) · [Codex](#codex) · [Cursor](#cursor) · [VS Code](#vs-code-github-copilot) · [Gemini CLI](#gemini-cli) · [Other clients](#other-clients)

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit config):

```json
{
  "mcpServers": {
    "strike": {
      "command": "node",
      "args": ["/absolute/path/to/strike-mcp/dist/index.js"],
      "env": {
        "STRIKE_WALLET_ADDRESS": "addr1..."
      }
    }
  }
}
```

That's read-only with no keys. For trading, replace the `env` block with:

```json
"env": {
  "STRIKE_API_PUBLIC_KEY": "…64 hex…",
  "STRIKE_API_PRIVATE_KEY": "…64 hex…",
  "STRIKE_ENABLE_TRADING": "true",
  "STRIKE_MAX_ORDER_NOTIONAL_USD": "250"
}
```

### Claude Code

Read-only:

```bash
claude mcp add strike -e STRIKE_WALLET_ADDRESS=addr1... -- node /absolute/path/to/strike-mcp/dist/index.js
```

Trading:

```bash
claude mcp add strike -e STRIKE_API_PUBLIC_KEY=... -e STRIKE_API_PRIVATE_KEY=... -e STRIKE_ENABLE_TRADING=true -e STRIKE_MAX_ORDER_NOTIONAL_USD=250 -- node /absolute/path/to/strike-mcp/dist/index.js
```

By default `claude mcp add` registers the server only for the directory you run it in (`-s local`). Add `-s user` to make it available in all your projects, or `-s project` to share it through a `.mcp.json` in the repo (don't commit API keys there). Check it with `claude mcp get strike`; the tools appear in new sessions. To change the variables, `claude mcp remove strike -s <scope>` and add it again.

### Codex

```bash
codex mcp add strike --env STRIKE_WALLET_ADDRESS=addr1... -- node /absolute/path/to/strike-mcp/dist/index.js
```

Or add it to `~/.codex/config.toml` (shared by the Codex CLI, IDE extension and app):

```toml
[mcp_servers.strike]
command = "node"
args = ["/absolute/path/to/strike-mcp/dist/index.js"]

[mcp_servers.strike.env]
STRIKE_WALLET_ADDRESS = "addr1..."
```

To keep the API wallet keys out of the file, export them in your shell and forward them with `env_vars = ["STRIKE_API_PUBLIC_KEY", "STRIKE_API_PRIVATE_KEY"]` under `[mcp_servers.strike]`.

### Cursor

Add the same `mcpServers` block as for Claude Desktop to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`. VS Code uses `servers` instead of `mcpServers` and needs `"type": "stdio"`:

```json
{
  "servers": {
    "strike": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/strike-mcp/dist/index.js"],
      "env": {
        "STRIKE_WALLET_ADDRESS": "addr1..."
      }
    }
  }
}
```

### Gemini CLI

```bash
gemini mcp add -s user -e STRIKE_WALLET_ADDRESS=addr1... strike node /absolute/path/to/strike-mcp/dist/index.js
```

### Other clients

`strike-mcp` is a stdio server: the client launches it as a subprocess and talks over stdin/stdout, so there is no port or URL. Any MCP client that can run a local server works with command `node`, argument `/absolute/path/to/strike-mcp/dist/index.js`, and the environment variables below.

Clients run the built `dist/index.js` from that path: after pulling changes, run `npm run build` and restart the client; if you move the folder, update the path.

### Configuration

| Variable                                           | Default   | Purpose                                                     |
| -------------------------------------------------- | --------- | ----------------------------------------------------------- |
| `STRIKE_NETWORK`                                   | `mainnet` | `testnet` uses `api-v2-testnet.strikefinance.org`.          |
| `STRIKE_WALLET_ADDRESS`                            | –         | Default account for read-only lookups.                      |
| `STRIKE_BLOCKCHAIN`                                | auto      | `cardano`, `ethereum` or `solana`, to skip chain detection. |
| `STRIKE_API_PUBLIC_KEY` / `STRIKE_API_PRIVATE_KEY` | –         | API wallet (Ed25519, raw hex).                              |
| `STRIKE_ENABLE_TRADING`                            | `false`   | Registers the trading tools. Requires an API wallet.        |
| `STRIKE_MAX_ORDER_NOTIONAL_USD`                    | `1000`    | Per-order notional cap.                                     |
| `STRIKE_PREVIEW_TTL_SECONDS`                       | `120`     | Preview lifetime.                                           |
| `STRIKE_API_URL` / `STRIKE_MARKET_URL`             | derived   | Override base URLs.                                         |

## How it works

```
src/
  auth.ts       Ed25519 request signing: METHOD:PATH?QUERY:TS:NONCE:SHA256(body)
  client.ts     REST client; signs the exact bytes it sends; typed API errors
  analytics.ts  Pure decimal math: book summary, fill simulation, funding, liquidation risk, order filters
  guard.ts      Single-use, expiring preview store
  tools/        market.ts, account.ts, trading.ts (MCP tool definitions)
  server.ts     MCP server, instructions and prompts
```

All money math uses `decimal.js`; prices and sizes stay strings end to end, matching the API.

Funding: Strike settles every hour and the rate served by the API is the hourly rate (the 8-hour rate ÷ 8), so APR = rate × 24 × 365.

## Tests

```bash
npm test
```

22 tests: signature format and verification, analytics math, the preview store, and end-to-end MCP sessions (in-memory transport) against a mock Strike API that **verifies every Ed25519 signature** the server sends. They cover read-only mode, keyless wallet lookups, the full preview → place flow, notional caps, bracket validation, stale-price refusal and preview reuse.

The public market endpoints were also checked against mainnet. That surfaced one difference from the published spec: `/price/v2/premiumIndex` returns `fundingRate`, not `lastFundingRate`. The server reads both.

## License

MIT
