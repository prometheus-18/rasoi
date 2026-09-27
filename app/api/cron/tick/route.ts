// Frequent tick (cron-job.org every 30 min). Auth: Bearer CRON_SECRET.
// Keeps the function warm, reconciles unknowns, sends lazy login reminders (throttled 6 h).

import { NextResponse, type NextRequest } from "next/server";
import { createOwnerLink } from "@/lib/auth/owner";
import { swiggyLoginStatus } from "@/lib/commerce/swiggy-auth";
import { timingSafeEqualStr } from "@/lib/crypto";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { reconcileUnknownOrders } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  if (!env.cronSecret || !timingSafeEqualStr(header, `Bearer ${env.cronSecret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const store = getStore();
  await reconcileUnknownOrders();
  await store.expireStaleDrafts(new Date(Date.now() - 2 * 3600_000));

  const login = await swiggyLoginStatus();
  if (!env.isDemo && !login.loggedIn) {
    const throttled = await store.getKV("login_reminder_sent");
    if (!throttled) {
      await store.setKV("login_reminder_sent", true, 6 * 3600_000);
      const url = await createOwnerLink("/api/swiggy/login");
      await sendOwner(`🔑 Swiggy login has expired — the cook cannot order. Re-login:\n${url}`);
    }
  }
  return NextResponse.json({ ok: true, loginOk: login.loggedIn });
}
