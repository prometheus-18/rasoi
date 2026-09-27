// Frequent tick (cron-job.org every 30 min). Auth: Bearer CRON_SECRET.
// Keeps the function warm, converts crashed 'placing' rows, reconciles unknowns, re-runs stranded
// approved drafts, and sends lazy login reminders (<24 h left, throttled 6 h).

import { NextResponse, type NextRequest } from "next/server";
import { createOwnerLink } from "@/lib/auth/owner";
import { swiggyLoginStatus } from "@/lib/commerce/swiggy-auth";
import { timingSafeEqualStr } from "@/lib/crypto";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { runCheckout } from "@/lib/orders/checkout";
import { reconcileUnknownOrders, retryApprovedDrafts } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  if (!env.cronSecret || !timingSafeEqualStr(header, `Bearer ${env.cronSecret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const store = getStore();
  await reconcileUnknownOrders();
  const expired = await store.expireStaleDrafts(new Date(Date.now() - 2 * 3600_000));
  const retried = await retryApprovedDrafts(runCheckout);

  const login = await swiggyLoginStatus();
  if (!env.isDemo && (!login.loggedIn || (login.hoursLeft ?? 0) < 24)) {
    const throttled = await store.getKV("login_reminder_sent");
    if (!throttled) {
      await store.setKV("login_reminder_sent", true, 6 * 3600_000);
      const url = await createOwnerLink("/api/swiggy/login");
      await sendOwner(
        login.loggedIn
          ? `🔑 Swiggy login expires in ${login.hoursLeft} h. Re-login when convenient (2 min):\n${url}`
          : `🔑 Swiggy login has expired — the cook cannot order. Re-login:\n${url}`,
      );
    }
  }
  return NextResponse.json({ ok: true, loginOk: login.loggedIn, expiredDrafts: expired, retriedApproved: retried });
}
