import { randomBytes } from "node:crypto";

export interface PendingOrder {
  id: string;
  path: "/v2/order" | "/v2/order/strategy";
  body: Record<string, unknown>;
  symbol: string;
  /** Mark price when previewed; used to refuse stale market orders. */
  markAtPreview: string | null;
  isMarket: boolean;
  summary: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

/**
 * Two-step execution: the model must preview an order (validated and priced)
 * and then place it by preview id. The id is single-use and short-lived, so
 * whatever the user confirmed is exactly what gets sent.
 */
export class PreviewStore {
  private readonly items = new Map<string, PendingOrder>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  add(p: Omit<PendingOrder, "id" | "createdAt" | "expiresAt">): PendingOrder {
    this.sweep();
    const id = `pv_${randomBytes(6).toString("hex")}`;
    const t = this.now();
    const item: PendingOrder = { ...p, id, createdAt: t, expiresAt: t + this.ttlMs };
    this.items.set(id, item);
    return item;
  }

  /** Removes and returns the preview. Throws if unknown or expired. */
  take(id: string): PendingOrder {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown or already-used preview '${id}'. Preview the order again.`);
    this.items.delete(id);
    if (this.now() > item.expiresAt) {
      throw new Error(`Preview '${id}' expired. Prices move — preview the order again and re-confirm with the user.`);
    }
    return item;
  }

  list(): PendingOrder[] {
    this.sweep();
    return [...this.items.values()];
  }

  private sweep() {
    const t = this.now();
    for (const [id, item] of this.items) if (t > item.expiresAt) this.items.delete(id);
  }
}
