import { signRequest } from "./auth.js";
import type { Config } from "./config.js";

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export class StrikeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Strike API ${method} ${path} failed with ${status}: ${describeError(body)}`);
    this.name = "StrikeApiError";
  }
}

function describeError(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.error, b.msg, b.code].filter((v) => typeof v === "string" && v.length > 0);
    if (parts.length) return parts.join(" | ");
  }
  return typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300) ?? "unknown error";
}

/** Builds `/path?a=1&b=2`, dropping empty values. The result is what gets signed. */
export function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class StrikeClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get hasApiWallet(): boolean {
    return Boolean(this.config.publicKeyHex && this.config.privateKeyHex);
  }

  /** Public market data: https://api.strikefinance.org/price/v2/... */
  market<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>(this.config.marketUrl, "GET", buildPath(path, query), undefined, false);
  }

  /** User/trade API. Signs whenever an API wallet is configured. */
  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>(this.config.apiUrl, "GET", buildPath(path, query), undefined, this.hasApiWallet);
  }

  post<T = unknown>(path: string, body: object): Promise<T> {
    return this.request<T>(this.config.apiUrl, "POST", path, body, true);
  }

  delete<T = unknown>(path: string, body?: object): Promise<T> {
    return this.request<T>(this.config.apiUrl, "DELETE", path, body, true);
  }

  private async request<T>(
    baseUrl: string,
    method: string,
    pathWithQuery: string,
    body: object | undefined,
    sign: boolean,
  ): Promise<T> {
    // Serialize once so the signed body hash matches the bytes on the wire.
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    if (sign) {
      if (!this.config.publicKeyHex || !this.config.privateKeyHex) {
        throw new Error(
          "This action needs a Strike API wallet. Set STRIKE_API_PUBLIC_KEY and STRIKE_API_PRIVATE_KEY " +
            "(create one at https://app.strikefinance.org/api-keys).",
        );
      }
      Object.assign(
        headers,
        await signRequest(this.config.privateKeyHex, this.config.publicKeyHex, method, pathWithQuery, bodyStr),
      );
    }

    const res = await this.fetchImpl(`${baseUrl}${pathWithQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : bodyStr,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    if (!res.ok) throw new StrikeApiError(res.status, method, pathWithQuery, parsed);
    return parsed as T;
  }
}
