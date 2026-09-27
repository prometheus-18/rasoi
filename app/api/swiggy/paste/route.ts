// POST { pasted } → completes the paste-back login (full URL or just the code).
// Resumes any drafts that were approved while logged out.

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { json } from "@/lib/api";
import { isOwnerRequest } from "@/lib/auth/owner";
import { completeSwiggyPaste } from "@/lib/commerce/swiggy-auth";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { resumeWaitingDrafts, retryApprovedDrafts } from "@/lib/orders/engine";
import { runCheckout } from "@/lib/orders/checkout";

export const maxDuration = 300;

const ERRORS: Record<string, string> = {
  no_code: "No code found in what you pasted. Paste the full address-bar URL.",
  no_pending_login: "No login in progress — tap the login link first.",
  login_expired: "That login attempt expired (15 min) — tap the login link again.",
};

export async function POST(req: NextRequest) {
  if (!(await isOwnerRequest(req))) return json({ error: "owner_only" }, 401);
  if (env.isDemo) return json({ error: "database_not_configured", message: "DATABASE_URL is not set on this deployment — the login cannot be saved. Add the Vercel environment variables and redeploy first." }, 503);
  const body = z.object({ pasted: z.string().min(6).max(4000) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "bad_request" }, 400);
  try {
    const { expiresAt } = await completeSwiggyPaste(body.data.pasted);
    after(async () => {
      const resumed = await resumeWaitingDrafts(runCheckout);
      await retryApprovedDrafts(runCheckout);
      if (resumed > 0) await sendOwner(`▶️ Login restored — ${resumed} waiting order(s) resumed.`);
    });
    return json({ ok: true, expiresAt: expiresAt.toISOString() });
  } catch (e) {
    const code = String((e as Error).message);
    return json({ error: code, message: ERRORS[code] ?? `Login failed (${code}). The code expires in 120 s — try again quickly.` }, 400);
  }
}
