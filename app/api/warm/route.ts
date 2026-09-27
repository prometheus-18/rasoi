// GET while the cook is still talking: wakes the function + DB and reports banners.

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { json, requireDevice } from "@/lib/api";
import { getProvider } from "@/lib/commerce/provider";
import { swiggyLoginStatus } from "@/lib/commerce/swiggy-auth";
import { env } from "@/lib/env";
import { getFlags } from "@/lib/orders/engine";
import { istDayStart } from "@/lib/orders/policy";
import { getStore } from "@/lib/store";

export async function GET(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof NextResponse) return auth;
  const store = getStore();
  const [flags, login, blocked] = await Promise.all([getFlags(), swiggyLoginStatus(), store.anyBlockingOrder()]);

  // Cache today's go-to items in the background for the matcher.
  const gotoKey = `goto:${istDayStart(new Date()).toISOString().slice(0, 10)}`;
  after(async () => {
    try {
      if (!(await store.getKV(gotoKey))) {
        const provider = await getProvider();
        await store.setKV(gotoKey, await provider.goToItems(), 26 * 3600_000);
      }
    } catch {}
  });

  return json({
    ok: true,
    demo: env.isDemo,
    paused: flags.paused,
    dryRun: flags.dryRun,
    loginOk: env.isDemo || login.loggedIn,
    blocked,
  });
}
