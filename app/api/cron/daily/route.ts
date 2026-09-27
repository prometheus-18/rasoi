// Daily cron (08:00 IST via vercel.json). Auth: Bearer CRON_SECRET (Vercel sends it automatically).

import { NextResponse, type NextRequest } from "next/server";
import { swiggyLoginStatus } from "@/lib/commerce/swiggy-auth";
import { timingSafeEqualStr } from "@/lib/crypto";
import { env } from "@/lib/env";
import { createOwnerLink } from "@/lib/auth/owner";
import { sendOwner } from "@/lib/notify/telegram";
import { runCheckout } from "@/lib/orders/checkout";
import { getLimits, reconcileUnknownOrders, retryApprovedDrafts, spendContext } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  return Boolean(env.cronSecret) && timingSafeEqualStr(header, `Bearer ${env.cronSecret}`);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();

  const expired = await store.expireStaleDrafts(new Date(Date.now() - 2 * 3600_000));
  await reconcileUnknownOrders();
  await retryApprovedDrafts(runCheckout);

  const login = await swiggyLoginStatus();
  if (!env.isDemo && (!login.loggedIn || (login.hoursLeft ?? 0) < 48)) {
    const url = await createOwnerLink("/api/swiggy/login");
    await sendOwner(
      `🔑 Swiggy login ${login.loggedIn ? `expires in ${login.hoursLeft} h` : "has EXPIRED"}. Re-login (2 min):\n${url}\nOpen in Chrome, then paste the final URL back here.`,
    );
  }

  const [limits, spend] = await Promise.all([getLimits(), spendContext(new Date())]);
  const unknowns = await store.unknownOrders();
  if (unknowns.length) await sendOwner(`⚠️ ${unknowns.length} order(s) still in UNKNOWN state — /resolve.`);

  return NextResponse.json({
    ok: true,
    expiredDrafts: expired,
    loginHoursLeft: login.hoursLeft ?? 0,
    spentTodayPaise: spend.spentDayPaise,
    dayLimitPaise: limits.perDayPaise,
    unknowns: unknowns.length,
  });
}
