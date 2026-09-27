/**
 * Phase 0 spike — talks to the LIVE Swiggy Instamart MCP with the owner's real account.
 *
 * Default run is READ-ONLY + cart-only (update_cart / clear_cart touch the shared cart but place nothing).
 * A real order is placed ONLY with --place-order AND SPIKE_ALLOW_CHECKOUT=yes AND a typed confirmation,
 * and only for a cart whose total is <= SPIKE_MAX_ORDER_RUPEES (default 200). Orders cannot be cancelled.
 *
 * Usage:
 *   npx tsx scripts/spike-swiggy.ts                       # login (loopback port) + read-only checks
 *   npx tsx scripts/spike-swiggy.ts --redirect=paste      # login via http://localhost/callback + paste URL
 *   npx tsx scripts/spike-swiggy.ts --redirect=port80     # login via http://localhost/callback on port 80
 *   npx tsx scripts/spike-swiggy.ts --save-token          # keep token in .spike-token.json (gitignored, 5 days)
 *   npx tsx scripts/spike-swiggy.ts --address-id=<id>     # skip the address prompt
 *   npx tsx scripts/spike-swiggy.ts --query=onion         # search term for the cart test (default: onion)
 *   npx tsx scripts/spike-swiggy.ts --cap-probe           # push cart above ₹1000 and read cart warnings (no checkout)
 *   npx tsx scripts/spike-swiggy.ts --test-second-login   # log in again and see if the first token still works
 *   npx tsx scripts/spike-swiggy.ts --place-order --pay=SwiggyPay   # the ONE agreed real test order
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const MCP_URL = process.env.SWIGGY_MCP_URL ?? "https://mcp.swiggy.com/im";
const AUTH = process.env.SWIGGY_AUTH_BASE ?? "https://mcp.swiggy.com/auth"; // discovery metadata is broken; hard-coded
const TOKEN_FILE = ".spike-token.json";
const MAX_ORDER_RUPEES = Number(process.env.SPIKE_MAX_ORDER_RUPEES ?? 200);

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? "true");
}
const flag = (k: string) => args.get(k) === "true";
const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q);
const log = (...x: unknown[]) => console.log(...x);
const results: Record<string, unknown> = { startedAt: new Date().toISOString(), mcpUrl: MCP_URL, steps: [] as unknown[] };
const step = (name: string, data: unknown) => {
  (results.steps as unknown[]).push({ name, at: new Date().toISOString(), data });
  log(`\n=== ${name}`);
  log(typeof data === "string" ? data : JSON.stringify(data, null, 2).slice(0, 4000));
};
const save = () => {
  mkdirSync("spike-results", { recursive: true });
  const f = `spike-results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(f, JSON.stringify(results, null, 2));
  log(`\nSaved ${f} (contains address/phone — gitignored, do not share)`);
};

// ---------- OAuth 2.1 + PKCE + DCR ----------
type Token = { access_token: string; expires_at: number; client_id: string; redirect_uri: string; raw: unknown };
type RedirectMode = "loopback-port" | "port80" | "paste";

async function register(redirectUri: string): Promise<string> {
  const res = await fetch(`${AUTH}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "rasoi-spike",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: "mcp:tools",
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  step("dcr", { status: res.status, body });
  if (!res.ok || !body.client_id) throw new Error(`DCR failed: ${res.status} ${JSON.stringify(body)}`);
  return body.client_id as string;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? `start "" "${url.replace(/&/g, "^&")}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function login(mode: RedirectMode): Promise<Token> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  let redirectUri: string;
  let waitForCode: () => Promise<string>;

  if (mode === "paste") {
    redirectUri = "http://localhost/callback";
    waitForCode = async () => {
      const pasted = await ask("\nBrowser shows 'site can't be reached'. Copy the FULL address-bar URL and paste it here (120 s!):\n> ");
      const m = pasted.match(/[?&]code=([^&\s]+)/);
      const st = pasted.match(/[?&]state=([^&\s]+)/)?.[1];
      if (!m) throw new Error("no code= in pasted text");
      if (st && decodeURIComponent(st) !== state) throw new Error("state mismatch");
      return decodeURIComponent(m[1]);
    };
  } else {
    const port = mode === "port80" ? 80 : 0;
    const host = mode === "port80" ? "localhost" : "127.0.0.1";
    let resolveCode!: (c: string) => void;
    let rejectCode!: (e: Error) => void;
    const codeP = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://${host}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" }).end("<h2>Rasoi spike: login received. You can close this tab.</h2>");
      if (err || !code) rejectCode(new Error(`callback error: ${err ?? "no code"} ${u.searchParams.get("error_description") ?? ""}`));
      else if (st !== state) rejectCode(new Error("state mismatch"));
      else resolveCode(code);
    });
    await new Promise<void>((r) => server.listen(port, host, r));
    const actualPort = (server.address() as { port: number }).port;
    redirectUri = mode === "port80" ? "http://localhost/callback" : `http://127.0.0.1:${actualPort}/callback`;
    waitForCode = async () => {
      const t = setTimeout(() => rejectCode(new Error("timed out waiting for callback (5 min)")), 5 * 60_000);
      try {
        return await codeP;
      } finally {
        clearTimeout(t);
        server.close();
      }
    };
  }

  const clientId = await register(redirectUri);
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "mcp:tools",
  }).toString();
  log(`\nOpening browser for Swiggy login (phone + OTP). If it does not open, visit:\n${url}\n`);
  openBrowser(url.toString());
  const code = await waitForCode();

  const t0 = Date.now();
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId }),
  });
  const body: any = await res.json().catch(() => ({}));
  step("token", {
    status: res.status,
    ms: Date.now() - t0,
    expires_in: body.expires_in,
    has_refresh: !!body.refresh_token,
    scope: body.scope,
    keys: Object.keys(body),
  });
  if (!res.ok || !body.access_token) throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  return {
    access_token: body.access_token,
    expires_at: Date.now() + (body.expires_in ?? 432000) * 1000,
    client_id: clientId,
    redirect_uri: redirectUri,
    raw: { ...body, access_token: "<redacted>", refresh_token: body.refresh_token ? "<redacted>" : undefined },
  };
}

async function getToken(): Promise<Token> {
  if (existsSync(TOKEN_FILE) && !flag("fresh-login")) {
    const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Token;
    if (t.expires_at > Date.now() + 60_000) {
      log(`Using saved token (expires ${new Date(t.expires_at).toLocaleString()})`);
      return t;
    }
    log("Saved token expired — logging in again.");
  }
  const mode = (args.get("redirect") ?? "loopback-port") as RedirectMode;
  const t = await login(mode);
  if (flag("save-token")) {
    writeFileSync(TOKEN_FILE, JSON.stringify(t));
    log(`Token saved to ${TOKEN_FILE} (gitignored). Delete it when done.`);
  } else log("Token kept in memory only (pass --save-token to reuse it for 5 days).");
  return t;
}

// ---------- MCP ----------
type ToolResult = { ok: boolean; status?: number; data?: any; message?: string; error?: any; raw: any; ms: number };

async function connect(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "rasoi-spike", version: "0.0.1" });
  const t0 = Date.now();
  await client.connect(transport);
  step("initialize", { ms: Date.now() - t0, sessionId: transport.sessionId, protocolVersion: transport.protocolVersion });
  return { client, transport };
}

/** Raw tools/call without the SDK's cached outputSchema validation (Swiggy's payloads don't always match their declared schema). */
async function call(client: Client, name: string, a: Record<string, unknown> = {}): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const r = await client.request({ method: "tools/call", params: { name, arguments: a } }, CallToolResultSchema, { timeout: 60_000 });
    const ms = Date.now() - t0;
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
    return { ok, data: payload?.data ?? payload, message: payload?.message, error: r.isError ? payload : payload?.error, raw: r, ms };
  } catch (e: any) {
    return { ok: false, status: e?.status ?? e?.code, error: { message: String(e?.message ?? e) }, raw: String(e), ms: Date.now() - t0 };
  }
}

const rupees = (v: unknown) => Number(String(v ?? "").replace(/[^\d.]/g, "")) || 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maskPhone = (p: unknown) => String(p ?? "").replace(/\d(?=\d{4})/g, "*");

async function main() {
  log("Rasoi — Swiggy Instamart MCP spike. Read-only unless --place-order.\n");
  const token = await getToken();
  const { client, transport } = await connect(token.access_token);

  // 1. tools/list
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  step("tools/list", { count: names.length, names });

  // 2. addresses
  const addr = await call(client, "get_addresses", { page: 1, pageSize: 10 });
  const addresses: any[] = addr.data?.addresses ?? [];
  step("get_addresses", {
    ok: addr.ok,
    ms: addr.ms,
    count: addresses.length,
    addresses: addresses.map((x) => ({ id: x.id, tag: x.addressTag, category: x.addressCategory, addressLine: x.addressLine, phone: maskPhone(x.phoneNumber) })),
    error: addr.error,
  });
  if (!addresses.length) {
    save();
    throw new Error("no addresses — add the home address in the Swiggy app first");
  }
  let addressId = args.get("address-id");
  if (!addressId) {
    addresses.forEach((x, i) => log(`  [${i}] ${x.addressTag ?? x.addressCategory ?? ""} — ${x.addressLine} (id ${x.id})`));
    const i = Number(await ask("Pick the HOME address number: "));
    addressId = addresses[i]?.id;
  }
  if (!addressId) throw new Error("no address chosen");
  results.addressId = addressId;

  // 3. go-to items
  const goto = await call(client, "your_go_to_items", { addressId });
  const gotoProducts: any[] = goto.data?.products ?? [];
  step("your_go_to_items", {
    ok: goto.ok,
    ms: goto.ms,
    count: gotoProducts.length,
    sample: gotoProducts.slice(0, 15).map((p) => ({
      name: p.displayName,
      brand: p.brand,
      variants: (p.variations ?? []).map((v: any) => `${v.quantityDescription} ₹${v.price?.offerPrice}${v.isInStockAndAvailable ? "" : " (OOS)"}`),
    })),
    error: goto.error,
  });

  // 4. search
  const query = args.get("query") ?? "onion";
  const search = await call(client, "search_products", { addressId, query });
  const products: any[] = search.data?.products ?? [];
  step(`search_products(${query})`, {
    ok: search.ok,
    ms: search.ms,
    count: products.length,
    top: products.slice(0, 6).map((p) => ({
      name: p.displayName,
      brand: p.brand,
      inStock: p.inStock,
      variants: (p.variations ?? []).map((v: any) => ({ spinId: v.spinId, skuId: v.skuId, qty: v.quantityDescription, price: v.price?.offerPrice, mrp: v.price?.mrp, ok: v.isInStockAndAvailable })),
    })),
    error: search.error,
  });

  // 5. existing cart (owner's app cart — will be replaced)
  const cart0 = await call(client, "get_cart");
  step("get_cart (before)", {
    ok: cart0.ok,
    ms: cart0.ms,
    cartAbsent: cart0.data?.cartAbsent,
    items: (cart0.data?.items ?? []).map((i: any) => `${i.itemName} x${i.quantity}`),
    toPay: cart0.data?.billBreakdown?.toPay,
    selectedAddressId: cart0.data?.selectedAddressDetails?.id,
    warning: cart0.data?.cartWarning ?? cart0.data?.addressWarning,
    error: cart0.error,
  });
  if ((cart0.data?.items ?? []).length) {
    const yn = await ask("Your Swiggy app cart is NOT empty. The next step REPLACES it. Continue? (yes/no) ");
    if (yn.trim() !== "yes") {
      save();
      await client.close();
      rl.close();
      return;
    }
  }

  // 6. pick the first in-stock variation of the first in-stock product
  const pick = (() => {
    for (const p of products) for (const v of p.variations ?? []) if (v.isInStockAndAvailable) return { product: p.displayName, spinId: v.spinId, skuId: v.skuId, qty: v.quantityDescription, price: v.price?.offerPrice };
    return null;
  })();
  if (!pick) {
    step("cart test", "no in-stock variation found — skipping cart tests");
  } else {
    const up = await call(client, "update_cart", { selectedAddressId: addressId, items: [{ spinId: pick.spinId, skuId: pick.skuId, quantity: 1 }] });
    step("update_cart", {
      ok: up.ok,
      ms: up.ms,
      pick,
      items: (up.data?.items ?? []).map((i: any) => `${i.itemName} x${i.quantity} ₹${i.discountedFinalPrice}`),
      toPay: up.data?.billBreakdown?.toPay,
      bill: up.data?.billBreakdown?.lineItems,
      removed: up.data?.removedOutOfStockItems,
      reduced: up.data?.reducedQuantityItems,
      warning: up.data?.cartWarning,
      message: up.message,
      error: up.error,
    });

    const cart1 = await call(client, "get_cart");
    step("get_cart (after update)", {
      ok: cart1.ok,
      ms: cart1.ms,
      cartId: cart1.data?.cartId,
      selectedAddressId: cart1.data?.selectedAddressDetails?.id,
      addressMatchesPinned: cart1.data?.selectedAddressDetails?.id === addressId,
      toPay: cart1.data?.billBreakdown?.toPay,
      bill: cart1.data?.billBreakdown?.lineItems,
      warning: cart1.data?.cartWarning ?? cart1.data?.addressWarning,
      availablePaymentMethods: cart1.data?.availablePaymentMethods,
      paymentOptionsKeys: cart1.data?.paymentOptions ? Object.keys(cart1.data.paymentOptions) : null,
      error: cart1.error,
    });

    // 7. payment options (the key question: is swiggyMoney offered?)
    const pay = await call(client, "get_payment_options");
    step("get_payment_options", {
      ok: pay.ok,
      ms: pay.ms,
      swiggyMoney: pay.data?.swiggyMoney,
      cod: pay.data?.cod,
      paymentAmount: pay.data?.paymentAmount,
      placeOrderToolName: pay.data?.placeOrderToolName,
      allMethods: (pay.data?.allMethods ?? []).map((m: any) => ({ id: m.id, name: m.displayName, group: m.groupName, kind: m.kind, enabled: m.enabled })),
      error: pay.error,
    });

    // 8. optional cap probe (no checkout): raise quantity until > ₹1000, read cart warnings
    if (flag("cap-probe")) {
      const unit = Number(pick.price) || 1;
      const qty = Math.min(Math.ceil(1100 / unit), 20);
      const probe = await call(client, "update_cart", { selectedAddressId: addressId, items: [{ spinId: pick.spinId, skuId: pick.skuId, quantity: qty }] });
      step(`cap-probe update_cart qty=${qty}`, { ok: probe.ok, ms: probe.ms, toPay: probe.data?.billBreakdown?.toPay, reduced: probe.data?.reducedQuantityItems, warning: probe.data?.cartWarning, message: probe.message, error: probe.error });
      const payProbe = await call(client, "get_payment_options");
      step("cap-probe get_payment_options", { ok: payProbe.ok, swiggyMoney: payProbe.data?.swiggyMoney, cod: payProbe.data?.cod, paymentAmount: payProbe.data?.paymentAmount, error: payProbe.error });
      await call(client, "update_cart", { selectedAddressId: addressId, items: [{ spinId: pick.spinId, skuId: pick.skuId, quantity: 1 }] });
    }

    // 9. THE ONE REAL ORDER (opt-in, triple-gated)
    if (flag("place-order")) {
      const method = args.get("pay") ?? "SwiggyPay";
      const cartNow = await call(client, "get_cart");
      const total = rupees(cartNow.data?.billBreakdown?.toPay?.value ?? cartNow.data?.cartTotalAmount);
      const offered = method === "SwiggyPay" ? !!pay.data?.swiggyMoney?.available : method === "COD" || method === "Cash" ? !!pay.data?.cod?.available : false;
      step("checkout pre-flight", { method, total, offered, maxAllowed: MAX_ORDER_RUPEES, items: (cartNow.data?.items ?? []).map((i: any) => `${i.itemName} x${i.quantity}`), address: cartNow.data?.selectedAddress });
      if (process.env.SPIKE_ALLOW_CHECKOUT !== "yes") log("SPIKE_ALLOW_CHECKOUT is not 'yes' — not placing an order.");
      else if (!offered) log(`${method} is not offered for this cart — not placing an order.`);
      else if (!(total > 0 && total <= MAX_ORDER_RUPEES)) log(`Total ₹${total} outside 1..${MAX_ORDER_RUPEES} — not placing an order.`);
      else if (cartNow.data?.selectedAddressDetails?.id !== addressId) log("Cart address != chosen address — not placing an order.");
      else {
        const typed = await ask(`\nThis places a REAL, NON-CANCELLABLE order of ₹${total} via ${method}. Type exactly PLACE ORDER to continue: `);
        if (typed.trim() !== "PLACE ORDER") log("Aborted.");
        else {
          const t0 = Date.now();
          const co = await call(client, "checkout", { addressId, paymentMethod: method });
          step("checkout (RAW — never retried)", { ok: co.ok, ms: co.ms, data: co.data, message: co.message, error: co.error, raw: co.raw });
          // reconciliation timing: when does the order show up, and under which orderType?
          for (const wait of [3000, 10000, 30000]) {
            await sleep(wait);
            const seen: Record<string, unknown> = {};
            for (const ot of ["INSTAMART", "DASH", undefined]) {
              const o = await call(client, "get_orders", ot ? { count: 5, orderType: ot } : { count: 5 });
              seen[ot ?? "default"] = {
                ok: o.ok,
                orders: (o.data?.orders ?? []).slice(0, 3).map((x: any) => ({ orderId: x.orderId, createdAt: x.createdAt, status: x.status, type: x.orderType, total: x.totalAmount, pay: x.paymentMethod, payStatus: x.paymentStatus })),
                error: o.error,
              };
            }
            const c = await call(client, "get_cart");
            step(`get_orders +${Math.floor((Date.now() - t0) / 1000)}s`, { seen, cartAfterCheckout: { cartAbsent: c.data?.cartAbsent, items: (c.data?.items ?? []).length } });
          }
          const oid = co.data?.orderId ?? co.data?.orders?.[0]?.orderId;
          if (oid) {
            const tr = await call(client, "track_order", { orderId: oid });
            step("track_order", { ok: tr.ok, ms: tr.ms, data: tr.data, error: tr.error });
            if (names.includes("get_order_details")) {
              const d = await call(client, "get_order_details", { orderId: oid });
              step("get_order_details", { ok: d.ok, data: d.data, error: d.error });
            }
          }
        }
      }
    }

    // 10. clear_cart — does it work? (issue #58)
    const clr = await call(client, "clear_cart");
    const cart2 = await call(client, "get_cart");
    step("clear_cart", { ok: clr.ok, ms: clr.ms, data: clr.data, error: clr.error, cartAfter: { cartAbsent: cart2.data?.cartAbsent, reason: cart2.data?.cartAbsentReason, items: (cart2.data?.items ?? []).length } });
    if ((cart2.data?.items ?? []).length) {
      const emp = await call(client, "update_cart", { selectedAddressId: addressId, items: [] });
      step("update_cart(items=[]) fallback", { ok: emp.ok, itemsAfter: (emp.data?.items ?? []).length, error: emp.error });
    }
  }

  // 11. order history: which orderType returns Instamart orders?
  for (const ot of ["INSTAMART", "DASH", undefined]) {
    const o = await call(client, "get_orders", ot ? { count: 10, orderType: ot } : { count: 10 });
    step(`get_orders orderType=${ot ?? "(default)"}`, {
      ok: o.ok,
      ms: o.ms,
      count: (o.data?.orders ?? []).length,
      sample: (o.data?.orders ?? []).slice(0, 5).map((x: any) => ({ orderId: x.orderId, createdAt: x.createdAt, type: x.orderType, status: x.status, total: x.totalAmount, pay: x.paymentMethod, store: x.storeName, items: (x.items ?? []).length })),
      error: o.error,
    });
  }

  // 12. session reuse: reconnect with the same session id (no new initialize) — does Swiggy accept it?
  try {
    const t2 = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } }, sessionId: transport.sessionId });
    const c2 = new Client({ name: "rasoi-spike-2", version: "0.0.1" });
    await c2.connect(t2);
    const a2 = await call(c2, "get_addresses", { page: 1, pageSize: 1 });
    step("session reuse", { reusedSessionId: t2.sessionId === transport.sessionId, sessionId: t2.sessionId, callOk: a2.ok, ms: a2.ms, error: a2.error });
    await c2.close();
  } catch (e: any) {
    step("session reuse", { failed: String(e?.message ?? e) });
  }

  // 13. does a second login revoke the first token?
  if (flag("test-second-login")) {
    log("\nLogging in a SECOND time (new client) to see whether the first token survives...");
    const t2 = await login((args.get("redirect") ?? "loopback-port") as RedirectMode);
    const again = await call(client, "get_addresses", { page: 1, pageSize: 1 });
    step("first token after second login", { ok: again.ok, status: again.status, error: again.error });
    const { client: c3 } = await connect(t2.access_token);
    const b = await call(c3, "get_addresses", { page: 1, pageSize: 1 });
    step("second token", { ok: b.ok, error: b.error });
    await c3.close();
  }

  await client.close();
  rl.close();
  save();
  log("\nDone. Next: paste the summary lines (tools count, swiggyMoney/cod, clear_cart, get_orders type) back into the chat.");
}

main().catch((e) => {
  console.error("\nSPIKE FAILED:", e?.message ?? e);
  try {
    save();
  } catch {}
  rl.close();
  process.exit(1);
});
