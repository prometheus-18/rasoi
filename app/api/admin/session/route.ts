// Owner session minting.
//  GET  ?t=<token>  → tiny confirm page (a bare GET must NOT consume the one-time link:
//                     Telegram's link-preview crawler and AV scanners fetch URLs).
//  POST t=<token>   → consumes the link, sets the 12 h cookie, redirects onward.
//  POST key=<ADMIN_SETUP_KEY> → same, for the setup phase before the bot exists.

import { NextResponse, type NextRequest } from "next/server";
import { exchangeOwnerLink, exchangeSetupKey, peekOwnerLink, setOwnerCookie } from "@/lib/auth/owner";
import { env } from "@/lib/env";

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Rasoi — owner</title>
<style>body{font-family:system-ui,sans-serif;background:#fff8ee;color:#2a1e17;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:420px;padding:32px;text-align:center}button{background:#e85d26;color:#fff;border:0;border-radius:16px;padding:16px 28px;font-size:20px;font-weight:700;width:100%}input{width:100%;box-sizing:border-box;padding:14px;font-size:18px;border:2px solid #f0e3d0;border-radius:12px;margin:12px 0}p{color:#8a7a6d}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get("t");
  if (t) {
    const link = await peekOwnerLink(t);
    if (!link) return page(`<h1>Link expired</h1><p>Send <b>/admin</b> (or <b>/login</b>) to the Telegram bot again for a fresh link.</p>`);
    return page(
      `<h1>Rasoi</h1><p>Open the owner dashboard on this device for 12 hours?</p><form method="post"><input type="hidden" name="t" value="${t.replace(/[^A-Za-z0-9_-]/g, "")}"><button type="submit">Continue →</button></form>`,
    );
  }
  if (env.adminSetupKey) {
    return page(`<h1>Rasoi setup</h1><p>Enter the ADMIN_SETUP_KEY from your environment.</p><form method="post"><input name="key" type="password" autocomplete="off" placeholder="setup key"><input type="hidden" name="next" value="/admin"><button type="submit">Continue →</button></form>`);
  }
  return page(`<h1>Rasoi</h1><p>Send <b>/admin</b> to the Telegram bot to get a login link.</p><p>Still setting up? Add <b>ADMIN_SETUP_KEY</b> (and <b>DATABASE_URL</b>) to the Vercel environment variables and redeploy, then reload this page.</p>`);
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const t = form?.get("t");
  const key = form?.get("key");
  if (typeof t === "string" && t) {
    const result = await exchangeOwnerLink(t);
    if (!result) return page(`<h1>Link expired</h1><p>Send <b>/admin</b> to the Telegram bot again.</p>`);
    const res = NextResponse.redirect(`${env.appUrl}${result.next}`, 303);
    setOwnerCookie(res, result.session);
    return res;
  }
  if (typeof key === "string" && key) {
    const session = await exchangeSetupKey(key);
    if (!session) return page(`<h1>Wrong key</h1><p><a href="/api/admin/session">Try again</a></p>`);
    const nextRaw = form?.get("next");
    const next = typeof nextRaw === "string" && /^\/[a-z0-9/_-]*$/i.test(nextRaw) ? nextRaw : "/admin";
    const res = NextResponse.redirect(`${env.appUrl}${next}`, 303);
    setOwnerCookie(res, session);
    return res;
  }
  return page(`<h1>Missing token</h1>`);
}
