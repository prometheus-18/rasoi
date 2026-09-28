/**
 * Owner utility: clear the Swiggy Instamart cart on the account and release the app's cart lease.
 * Uses the login stored (encrypted) in the database. No other mutation.
 *   npx tsx scripts/clear-cart.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvLocal } from "./lib/env-local";

loadEnvLocal();
const { neon } = await import("@neondatabase/serverless");
const { aesDecrypt } = await import("../lib/crypto");
const { env } = await import("../lib/env");

const sql = neon(process.env.DATABASE_URL!);
const rows = (await sql.query("select access_token_enc from swiggy_auth where id = 1")) as { access_token_enc: string }[];
if (!rows[0]) throw new Error("no swiggy login stored");
const token = aesDecrypt(rows[0].access_token_enc);

const transport = new StreamableHTTPClientTransport(new URL(env.swiggyMcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "rasoi-clear-cart", version: "0.1.0" });
await client.connect(transport);
const r: any = await client.request({ method: "tools/call", params: { name: "clear_cart", arguments: {} } }, CallToolResultSchema, { timeout: 30_000 });
const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
console.log("clear_cart:", r.isError ? "ERROR" : "ok", text.slice(0, 200));
const c: any = await client.request({ method: "tools/call", params: { name: "get_cart", arguments: {} } }, CallToolResultSchema, { timeout: 30_000 });
const ct = (c.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
let items = "?";
try { const j = JSON.parse(ct); items = String((j.data ?? j).items?.length ?? 0); } catch {}
console.log("cart items now:", items);
await client.close();

// park any leftover editing drafts and free the lease so the app is clean for the next order
const parked = await sql.query("update drafts set state='superseded', updated_at=now() where state in ('matched','cart_synced') returning id");
await sql.query("update commerce_lock set draft_id=null, holder=null, acquired_at=null where id=1");
console.log("editing drafts parked:", parked.length, "| cart lease released");
