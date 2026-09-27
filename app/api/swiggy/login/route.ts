// GET → starts a fresh PKCE login and redirects to Swiggy's authorize page.
// Owner-only. The owner reaches this via a one-time session link from the bot (/login).

import { NextResponse, type NextRequest } from "next/server";
import { json } from "@/lib/api";
import { isOwnerRequest } from "@/lib/auth/owner";
import { startSwiggyLogin } from "@/lib/commerce/swiggy-auth";

export async function GET(req: NextRequest) {
  if (!(await isOwnerRequest(req))) return json({ error: "owner_only", hint: "send /login to the Telegram bot for a fresh link" }, 401);
  try {
    const { authorizeUrl } = await startSwiggyLogin();
    return NextResponse.redirect(authorizeUrl, 302);
  } catch (e) {
    return json({ error: "login_start_failed", detail: String((e as Error).message) }, 502);
  }
}
