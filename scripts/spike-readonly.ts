/**
 * Phase 0 read-only spike using the login already stored (encrypted) in the database.
 * Reads ONLY: tools/list (all schemas), get_addresses, your_go_to_items, search_products, get_cart, get_orders.
 * Never calls update_cart / clear_cart / checkout / confirm_order. Output → spike-results/ (gitignored).
 *
 *   npx tsx scripts/spike-readonly.ts [--query=onion]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvLocal } from "./lib/env-local";

loadEnvLocal();
const { neon } = await import("@neondatabase/serverless");
const { aesDecrypt } = await import("../lib/crypto");
const { env } = await import("../lib/env");

const query = process.argv.find((a) => a.startsWith("--query="))?.slice(8) ?? "onion";
const out: Record<string, unknown> = { at: new Date().toISOString() };
const mask = (s: unknown) => String(s ?? "").replace(/\d(?=\d{4})/g, "*");
const log = (...x: unknown[]) => console.log(...x);

const sql = neon(process.env.DATABASE_URL!);
const rows = (await sql.query("select access_token_enc, session_id, expires_at from swiggy_auth where id = 1")) as { access_token_enc: string; session_id: string | null; expires_at: string }[];
if (!rows[0]) throw new Error("no swiggy_auth row — log in on /login first");
const token = aesDecrypt(rows[0].access_token_enc);
log("login expires:", rows[0].expires_at, "| stored session:", rows[0].session_id ? "yes" : "no");

const transport = new StreamableHTTPClientTransport(new URL(env.swiggyMcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "rasoi-spike-readonly", version: "0.1.0" });
await client.connect(transport);
log("connected, session:", transport.sessionId ? "new" : "none");

async function call(name: string, args: Record<string, unknown> = {}) {
  const t0 = Date.now();
  try {
    const r: any = await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, { timeout: 60_000 });
    let payload: any = r.structuredContent;
    if (payload === undefined) {
      const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      try { payload = JSON.parse(text); } catch { payload = { text }; }
    }
    return { ok: !r.isError && payload?.success !== false, ms: Date.now() - t0, payload, isError: r.isError };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

// 1. tools/list — everything, with descriptions
const tools = await client.listTools();
out.tools = tools.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: (t as any).outputSchema }));
log("\n=== tools:", tools.tools.map((t) => t.name).sort().join(", "));
for (const t of tools.tools.filter((t) => /checkout|confirm_order|check_payment|get_payment|get_cart|report_error/.test(t.name))) {
  log(`\n--- ${t.name}\n${t.description}\ninput: ${JSON.stringify(t.inputSchema)}`);
}

// 2. addresses (raw keys matter for the fingerprint)
const addr = await call("get_addresses", { page: 1, pageSize: 10 });
out.get_addresses = addr;
const list: any[] = addr.payload?.data?.addresses ?? addr.payload?.addresses ?? [];
log("\n=== get_addresses:", addr.ok, addr.ms + "ms", "count", list.length, "| top-level keys:", Object.keys(addr.payload ?? {}).join(","));
if (list[0]) log("address keys:", Object.keys(list[0]).join(", "));
for (const a of list) log(`  ${a.addressTag ?? a.annotation ?? a.label ?? "?"} | id ${String(a.id).slice(0, 8)}… | pincode=${a.pincode ?? a.postalCode ?? a.zip ?? "?"} lat=${a.lat ?? a.latitude ?? "?"} lng=${a.lng ?? a.longitude ?? "?"} | phone ${mask(a.phoneNumber ?? a.mobile)}`);
const pinned = list.find((a) => a.id === env.pinnedAddressId);
log("pinned address present:", Boolean(pinned), pinned ? `→ ${pinned.addressTag ?? pinned.annotation ?? ""} ${String(pinned.addressLine ?? pinned.address ?? "").slice(0, 60)}` : "");

// 3. go-to items
const goto = await call("your_go_to_items", { addressId: env.pinnedAddressId });
out.your_go_to_items = goto;
const gp: any[] = goto.payload?.data?.products ?? goto.payload?.products ?? [];
log("\n=== your_go_to_items:", goto.ok, goto.ms + "ms", "count", gp.length, "| keys:", Object.keys(goto.payload?.data ?? goto.payload ?? {}).join(","));
if (gp[0]) log("product keys:", Object.keys(gp[0]).join(", "), "| variation keys:", Object.keys((gp[0].variations ?? gp[0].variants ?? [{}])[0] ?? {}).join(", "));
for (const p of gp.slice(0, 5)) log(`  ${p.displayName ?? p.name} | ${(p.variations ?? p.variants ?? []).map((v: any) => `${v.quantityDescription ?? v.packDesc} ₹${v.price?.offerPrice ?? v.price}`).join(" / ")}`);

// 4. search
const search = await call("search_products", { addressId: env.pinnedAddressId, query });
out.search_products = search;
const sp: any[] = search.payload?.data?.products ?? search.payload?.products ?? [];
log(`\n=== search_products(${query}):`, search.ok, search.ms + "ms", "count", sp.length, search.error ?? "");
for (const p of sp.slice(0, 5)) log(`  ${p.displayName ?? p.name} | img=${p.imageUrl ? "url" : p.imageId ? "imageId" : Object.keys(p).filter((k) => /image|img/i.test(k)).join("/") || "none"} | ${(p.variations ?? p.variants ?? []).map((v: any) => `${v.quantityDescription ?? v.packDesc} ₹${v.price?.offerPrice ?? v.price} ${v.isInStockAndAvailable === false ? "(OOS)" : ""}`).join(" / ")}`);
if (sp[0]) log("search product keys:", Object.keys(sp[0]).join(", "));

// 5. cart (read) + orders (read)
const cart = await call("get_cart", {});
out.get_cart = cart;
log("\n=== get_cart:", cart.ok, cart.ms + "ms", "| keys:", Object.keys(cart.payload?.data ?? cart.payload ?? {}).join(","), "| items:", (cart.payload?.data?.items ?? []).length, cart.error ?? "");
const orders = await call("get_orders", { count: 5 });
out.get_orders = orders;
const ol: any[] = orders.payload?.data?.orders ?? orders.payload?.orders ?? [];
log("\n=== get_orders:", orders.ok, orders.ms + "ms", "count", ol.length, "| keys:", ol[0] ? Object.keys(ol[0]).join(",") : "-", orders.error ?? "");
for (const o of ol.slice(0, 3)) log(`  ${o.orderId ?? o.id} | ${o.createdAt ?? o.orderTime ?? ""} | ${o.status ?? o.orderStatus} | ₹${o.totalAmount ?? o.total} | ${o.paymentMethod ?? ""}`);

await client.close();
mkdirSync("spike-results", { recursive: true });
const f = `spike-results/readonly-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(f, JSON.stringify(out, null, 2));
log(`\nsaved ${f} (contains address/phone — gitignored)`);
