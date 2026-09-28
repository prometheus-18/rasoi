// Swiggy Instamart MCP adapter.
// SAFETY PROPERTIES (enforced here, not in prompts):
//  - Tool ALLOWLIST: only the 12 tools below are callable. create_address/delete_address etc. are not.
//  - checkoutOnce() is called only by lib/orders/checkout.ts, is NEVER retried, and refuses to run
//    unless ALLOW_REAL_ORDERS=true in the Vercel Production environment.
//  - updateCart always pins the owner's PINNED_ADDRESS_ID.
//  - One MCP session per user: the Mcp-Session-Id is persisted in the DB and reused.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Address, CommerceProvider } from "@/lib/commerce/provider";
import { getSwiggyAccessToken } from "@/lib/commerce/swiggy-auth";
import { classifyFailure, CommerceError } from "@/lib/commerce/swiggy-errors";
import { env } from "@/lib/env";
import { getStore } from "@/lib/store";
import { paise, type CartLine, type CartView, type PaymentMethod, type PaymentOptions, type Product, type ProviderOrder, type RawCheckoutOutcome, type TrackInfo } from "@/lib/types";

// Live server (2026-09-28) exposes 16 tools; we allow the 11 we need. NOT allowed: create_address,
// delete_address, confirm_order, check_payment_status (UPI-only flows), report_error.
const ALLOWED_TOOLS = new Set([
  "search_products",
  "your_go_to_items",
  "get_addresses",
  "update_cart",
  "clear_cart",
  "get_cart",
  "get_payment_options",
  "checkout",
  "get_orders",
  "track_order",
  "get_delivery_status",
]);

const CALL_TIMEOUT_MS = 18_000;
const CHECKOUT_TIMEOUT_MS = 30_000;

type Payload = { ok: boolean; data: any; message?: string; raw: unknown };

type CachedConn = { client: Client; transport: StreamableHTTPClientTransport; tokenHash: string };
const g = globalThis as unknown as { __swiggyConn?: CachedConn };

async function connect(forceFresh = false): Promise<CachedConn> {
  const token = await getSwiggyAccessToken();
  const tokenHash = token.slice(-16);
  if (!forceFresh && g.__swiggyConn && g.__swiggyConn.tokenHash === tokenHash) return g.__swiggyConn;

  const store = getStore();
  const auth = await store.getSwiggyAuth();
  const transport = new StreamableHTTPClientTransport(new URL(env.swiggyMcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(!forceFresh && auth?.sessionId ? { sessionId: auth.sessionId } : {}),
  });
  const client = new Client({ name: "rasoi", version: "0.1.0" });
  await client.connect(transport);
  if (transport.sessionId && transport.sessionId !== auth?.sessionId) {
    await store.setSwiggySessionId(transport.sessionId).catch(() => {});
  }
  g.__swiggyConn = { client, transport, tokenHash };
  return g.__swiggyConn;
}

function parsePayload(r: any): Payload {
  let payload: any = r.structuredContent;
  if (payload === undefined) {
    const text = (r.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }
  const ok = !r.isError && payload?.success !== false;
  return { ok, data: payload?.data ?? payload, message: payload?.message ?? payload?.error?.message, raw: r };
}

/** One raw tools/call. Throws CommerceError (with `source`) on failure. */
async function rawCall(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<Payload> {
  if (!ALLOWED_TOOLS.has(name)) throw new CommerceError("CONFIG", `tool '${name}' is not on the allowlist`, { source: "pre-send" });
  let conn: CachedConn;
  try {
    conn = await connect();
  } catch (e) {
    if (e instanceof CommerceError) throw e; // AUTH from getSwiggyAccessToken → pre-send
    throw new CommerceError("TRANSIENT", `connect failed: ${String((e as Error)?.message ?? e)}`, { source: "pre-send" });
  }
  let r: any;
  try {
    r = await conn.client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, { timeout: timeoutMs });
  } catch (e: any) {
    g.__swiggyConn = undefined; // session may be dead; next call reconnects
    const msg = String(e?.message ?? e);
    // HTTP-level status (StreamableHTTPError.code) vs JSON-RPC code (McpError.code, negative)
    const status = e instanceof StreamableHTTPError ? e.code : typeof e?.status === "number" ? e.status : undefined;
    const code = classifyFailure(status, msg);
    throw new CommerceError(code === "UNKNOWN" ? "TRANSIENT" : code, `${name}: ${msg}`, { status, raw: String(e), source: "transport" });
  }
  const p = parsePayload(r);
  if (!p.ok) {
    const msg = p.message ?? JSON.stringify(p.data)?.slice(0, 300) ?? "tool error";
    throw new CommerceError(classifyFailure(undefined, msg), `${name}: ${msg}`, { raw: p.raw, source: "payload" });
  }
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry wrapper. reads: up to 5 attempts. cart: up to 2. checkout NEVER goes through here. */
async function call(name: string, args: Record<string, unknown>, kind: "read" | "cart"): Promise<Payload> {
  if (name === "checkout") throw new CommerceError("CONFIG", "checkout must not go through the retry wrapper");
  const maxAttempts = kind === "read" ? 5 : 2;
  let lastErr: CommerceError | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) await sleep(Math.min(400 * 2 ** attempt + Math.random() * 200, 4000));
      return await rawCall(name, args, CALL_TIMEOUT_MS);
    } catch (e) {
      lastErr = e instanceof CommerceError ? e : new CommerceError("UNKNOWN", String((e as Error)?.message ?? e));
      if (!lastErr.retryable) throw lastErr;
      if (lastErr.code === "SESSION_419") {
        try {
          await connect(true);
        } catch {
          /* next attempt reconnects */
        }
      }
    }
  }
  throw lastErr!;
}

// ── payload mappers (defensive: Phase 0 spike will confirm exact shapes) ─────

function mapImage(p: any): string | undefined {
  if (typeof p?.imageUrl === "string" && p.imageUrl.startsWith("http")) return p.imageUrl;
  const id = p?.imageId ?? p?.image_id ?? p?.image;
  if (typeof id === "string" && id.length > 3 && !id.startsWith("http"))
    return `https://media-assets.swiggy.com/swiggy/image/upload/${id}`;
  if (typeof id === "string" && id.startsWith("http")) return id;
  return undefined;
}

function mapProduct(p: any): Product {
  const variations = (p?.variations ?? p?.variants ?? []) as any[];
  return {
    name: String(p?.displayName ?? p?.name ?? "?"),
    brand: p?.brand ? String(p.brand) : undefined,
    // images live on the variation in the live payload
    imageUrl: mapImage(p) ?? variations.map((v) => mapImage(v)).find(Boolean),
    variants: variations.map((v) => ({
      spinId: String(v?.spinId ?? ""),
      skuId: String(v?.skuId ?? ""),
      packDesc: String(v?.quantityDescription ?? v?.packDesc ?? ""),
      pricePaise: paise(v?.price?.offerPrice ?? v?.price ?? 0),
      mrpPaise: v?.price?.mrp !== undefined ? paise(v.price.mrp) : undefined,
      inStock: Boolean(v?.isInStockAndAvailable ?? v?.inStock ?? true),
      maxQuantity: Number.isFinite(Number(v?.maxQuantity)) && Number(v.maxQuantity) > 0 ? Number(v.maxQuantity) : undefined,
    })),
  };
}

function mapCart(data: any): CartView {
  const items = ((data?.items ?? []) as any[]).map((i) => {
    const line = paise(i?.discountedFinalPrice ?? i?.finalPrice ?? i?.total ?? 0);
    const qty = Number(i?.quantity ?? 1);
    return {
      spinId: String(i?.spinId ?? ""),
      skuId: String(i?.skuId ?? ""),
      name: String(i?.itemName ?? i?.name ?? "?"),
      imageUrl: mapImage(i),
      packDesc: i?.quantityDescription ? String(i.quantityDescription) : undefined,
      quantity: qty,
      unitPaise: qty > 0 ? Math.round(line / qty) : line,
      linePaise: line,
    };
  });
  const bill = data?.billBreakdown ?? {};
  const toPay = paise(bill?.toPay?.value ?? bill?.toPay ?? data?.cartTotalAmount ?? 0);
  const itemTotal = paise(bill?.itemTotal?.value ?? bill?.itemTotal ?? 0) || items.reduce((s, i) => s + i.linePaise, 0);
  const warnings: string[] = [];
  for (const w of [data?.cartWarning, data?.addressWarning]) if (w) warnings.push(String(w));
  const stores = new Set(((data?.items ?? []) as any[]).map((i) => i?.storeId ?? i?.storeName ?? "s1"));
  return {
    items,
    toPayPaise: toPay,
    itemTotalPaise: itemTotal,
    feesPaise: Math.max(0, toPay - itemTotal),
    storeCount: Math.max(1, stores.size),
    warnings,
    removedOutOfStock: ((data?.removedOutOfStockItems ?? []) as any[]).map((x) => String(x?.itemName ?? x)),
    reducedQuantity: ((data?.reducedQuantityItems ?? []) as any[]).map((x) => String(x?.itemName ?? x)),
    selectedAddressId: data?.selectedAddressDetails?.id ? String(data.selectedAddressDetails.id) : undefined,
  };
}

function mapPaymentOptions(data: any): PaymentOptions {
  return {
    swiggyMoney: data?.swiggyMoney
      ? { available: Boolean(data.swiggyMoney.available), balancePaise: data.swiggyMoney.balance !== undefined ? paise(data.swiggyMoney.balance) : undefined }
      : undefined,
    cod: data?.cod ? { available: Boolean(data.cod.available) } : undefined,
  };
}

export type SwiggyToolInfo = { names: string[]; checkoutSchema: unknown; paymentSchema: unknown; updateCartSchema: unknown; fetchedAt: string };

/** tools/list snapshot for the owner dashboard — lets us read the real checkout argument enums. */
export async function describeSwiggyTools(force = false): Promise<SwiggyToolInfo> {
  const store = getStore();
  const cached = force ? null : await store.getKV<SwiggyToolInfo>("swiggy_tools");
  if (cached) return cached;
  const conn = await connect();
  const res = await conn.client.listTools();
  const find = (n: string) => res.tools.find((t) => t.name === n)?.inputSchema ?? null;
  const info: SwiggyToolInfo = {
    names: res.tools.map((t) => t.name).sort(),
    checkoutSchema: find("checkout"),
    paymentSchema: find("get_payment_options"),
    updateCartSchema: find("update_cart"),
    fetchedAt: new Date().toISOString(),
  };
  await store.setKV("swiggy_tools", info, 24 * 3600_000);
  return info;
}

/** Payment method strings the checkout tool accepts. TODO(phase0): confirm exact values from the spike. */
const PAYMENT_METHOD_ARG: Record<PaymentMethod, string> = {
  SWIGGY_MONEY: "SwiggyPay",
  COD: "Cash",
};

export class SwiggyProvider implements CommerceProvider {
  readonly name = "swiggy" as const;

  private pinnedAddressId(): string {
    if (!env.pinnedAddressId) throw new CommerceError("CONFIG", "PINNED_ADDRESS_ID is not set");
    return env.pinnedAddressId;
  }

  async searchProducts(query: string): Promise<Product[]> {
    const p = await call("search_products", { addressId: this.pinnedAddressId(), query }, "read");
    return ((p.data?.products ?? []) as any[]).map(mapProduct);
  }

  async goToItems(): Promise<Product[]> {
    const p = await call("your_go_to_items", { addressId: this.pinnedAddressId() }, "read");
    return ((p.data?.products ?? []) as any[]).map(mapProduct);
  }

  async getAddresses(): Promise<Address[]> {
    const p = await call("get_addresses", { page: 1, pageSize: 10 }, "read");
    return ((p.data?.addresses ?? []) as any[]).map((a) => ({
      id: String(a?.id ?? ""),
      label: a?.addressTag ?? a?.addressCategory ?? undefined,
      line: a?.addressLine ? String(a.addressLine) : undefined,
      pincode: a?.pincode ? String(a.pincode) : undefined,
      lat: a?.lat !== undefined ? Number(a.lat) : undefined,
      lng: a?.lng !== undefined ? Number(a.lng) : undefined,
    }));
  }

  async updateCart(lines: CartLine[]): Promise<CartView> {
    const p = await call(
      "update_cart",
      { selectedAddressId: this.pinnedAddressId(), items: lines.map((l) => ({ spinId: l.spinId, skuId: l.skuId, quantity: l.quantity })) },
      "cart",
    );
    // one sanitized sample of the live cart shape per day, for the owner page (no address/phone fields)
    const store = getStore();
    if (!(await store.getKV("swiggy_cart_shape"))) {
      const d = p.data ?? {};
      const sample = {
        keys: Object.keys(d),
        billBreakdown: d.billBreakdown,
        itemKeys: Object.keys((d.items ?? [])[0] ?? {}),
        cartWarning: d.cartWarning ?? null,
        hasSelectedAddress: Boolean(d.selectedAddressDetails ?? d.selectedAddressId),
        at: new Date().toISOString(),
      };
      await store.setKV("swiggy_cart_shape", sample, 24 * 3600_000).catch(() => {});
    }
    return mapCart(p.data);
  }

  async getCart(): Promise<CartView> {
    const p = await call("get_cart", {}, "read");
    return mapCart(p.data);
  }

  async clearCart(): Promise<void> {
    try {
      await call("clear_cart", {}, "cart");
    } catch {
      // issue #58: clear_cart may not work — fall back to replacing with an empty cart
      await call("update_cart", { selectedAddressId: this.pinnedAddressId(), items: [] }, "cart").catch(() => {});
    }
  }

  async getPaymentOptions(): Promise<PaymentOptions> {
    const p = await call("get_payment_options", {}, "read");
    return mapPaymentOptions(p.data);
  }

  /**
   * THE one checkout call. No retry wrapper, no second attempt, ever.
   * A timeout or ambiguous response returns kind:"unknown" — the caller must reconcile,
   * never re-call.
   */
  async checkoutOnce(args: { addressId: string; paymentMethod: PaymentMethod }): Promise<RawCheckoutOutcome> {
    if (!env.allowRealOrders) {
      throw new CommerceError("CONFIG", "ALLOW_REAL_ORDERS is not enabled in this environment — refusing real checkout");
    }
    const method = PAYMENT_METHOD_ARG[args.paymentMethod];
    if (!method) throw new CommerceError("CONFIG", `unsupported payment method ${args.paymentMethod}`);
    try {
      const p = await rawCall("checkout", { addressId: args.addressId, paymentMethod: method }, CHECKOUT_TIMEOUT_MS);
      const orderIds: string[] = [];
      const d = p.data;
      if (d?.orderId) orderIds.push(String(d.orderId));
      for (const o of (d?.orders ?? []) as any[]) if (o?.orderId) orderIds.push(String(o.orderId));
      return { kind: "placed", orderIds: [...new Set(orderIds)], message: p.message, raw: p.raw };
    } catch (e) {
      const err = e instanceof CommerceError ? e : new CommerceError("UNKNOWN", String((e as Error)?.message ?? e), { source: "transport" });
      // Definite = provably not placed: nothing was sent, Swiggy answered with a failure payload
      // (HTTP 200, success:false), or the HTTP layer rejected the request outright (4xx).
      // Everything else — timeout, 5xx, connection drop, parse error — is UNKNOWN and must be reconciled.
      const rejected4xx = err.source === "transport" && err.status !== undefined && err.status >= 400 && err.status < 500;
      if (err.source === "pre-send" || err.source === "payload" || rejected4xx) {
        return { kind: "failed_definite", message: err.message, code: err.code, raw: err.raw };
      }
      return { kind: "unknown", message: err.message, raw: err.raw };
    }
  }

  async getOrders(count = 10): Promise<ProviderOrder[]> {
    // Default orderType is "DASH"; the account has no Instamart history yet, so also try "INSTAMART" and merge.
    const seen = new Map<string, any>();
    for (const args of [{ count }, { count, orderType: "INSTAMART" }]) {
      try {
        const p = await call("get_orders", args, "read");
        for (const o of (p.data?.orders ?? []) as any[]) {
          const id = String(o?.orderId ?? o?.id ?? "");
          if (id && !seen.has(id)) seen.set(id, o);
        }
      } catch (e) {
        if (seen.size) break;
        throw e;
      }
    }
    return [...seen.values()].map((o) => ({
      orderId: String(o?.orderId ?? ""),
      createdAt: o?.createdAt ? String(o.createdAt) : undefined,
      status: o?.status ? String(o.status) : undefined,
      totalPaise: o?.totalAmount !== undefined ? paise(o.totalAmount) : undefined,
      paymentMethod: o?.paymentMethod ? String(o.paymentMethod) : undefined,
      items: ((o?.items ?? []) as any[]).map((i) => ({ name: String(i?.name ?? i?.itemName ?? "?"), quantity: Number(i?.quantity ?? 1) })),
    }));
  }

  /** No get_order_details tool exists on the live server — look the order up in history instead. */
  async getOrderDetails(orderId: string): Promise<unknown> {
    const orders = await this.getOrders(20);
    return orders.find((o) => o.orderId === orderId) ?? null;
  }

  /**
   * track_order requires lat/lng (which Swiggy addresses do not expose); get_delivery_status needs only
   * orderId + addressId and returns an absolute deliveryBy epoch. Use it first, fall back to track_order
   * when PINNED_ADDRESS_LATLNG is configured.
   */
  async trackOrder(orderId: string): Promise<TrackInfo> {
    try {
      const p = await call("get_delivery_status", { orderId, addressId: this.pinnedAddressId() }, "read");
      const d = p.data ?? {};
      const by = Number(d.deliveryBy ?? d.deliveryByEpoch ?? d.eta);
      const byMs = Number.isFinite(by) ? (by > 1e12 ? by : by * 1000) : NaN;
      const etaMinutes = Number.isFinite(byMs) ? Math.max(0, Math.round((byMs - Date.now()) / 60_000)) : undefined;
      return { status: d.status ? String(d.status) : etaMinutes === 0 ? "DELIVERED" : "ARRIVING", etaMinutes, message: p.message, raw: d };
    } catch (e) {
      const ll = env.pinnedAddressLatLng;
      if (!ll) throw e;
      const p = await call("track_order", { orderId, lat: ll.lat, lng: ll.lng }, "read");
      const d = p.data;
      return {
        status: d?.status ? String(d.status) : undefined,
        etaMinutes: d?.etaMinutes !== undefined ? Number(d.etaMinutes) : d?.eta !== undefined ? Number(d.eta) : undefined,
        message: p.message,
        raw: d,
      };
    }
  }
}
