// GET → everything the /admin page shows. Owner-only.
// Includes the Swiggy address list (owner-facing only) so PINNED_ADDRESS_ID can be picked.

import { NextResponse, type NextRequest } from "next/server";
import { json } from "@/lib/api";
import { isOwnerRequest } from "@/lib/auth/owner";
import { getProvider, type Address } from "@/lib/commerce/provider";
import { swiggyLoginStatus } from "@/lib/commerce/swiggy-auth";
import { env, setupStatus } from "@/lib/env";
import { getFlags, getLimits, spendContext } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";

export async function GET(req: NextRequest) {
  if (!(await isOwnerRequest(req))) return json({ error: "owner_only" }, 401);
  const store = getStore();
  const now = new Date();
  const [flags, limits, spend, login, devices, orders, unknowns] = await Promise.all([
    getFlags(),
    getLimits(),
    spendContext(now),
    swiggyLoginStatus(),
    store.listDevices(),
    store.recentOrders(10),
    store.unknownOrders(),
  ]);

  let addresses: (Address & { pinned: boolean })[] = [];
  let addressError: string | null = null;
  let tools: unknown = null;
  if (login.loggedIn) {
    try {
      const provider = await getProvider();
      if (provider.name === "swiggy") {
        addresses = (await provider.getAddresses()).map((a) => ({ ...a, pinned: a.id === env.pinnedAddressId }));
        const { describeSwiggyTools } = await import("@/lib/commerce/swiggy");
        tools = await describeSwiggyTools().catch(() => null);
        const shape = await store.getKV("swiggy_cart_shape");
        if (tools && shape) tools = { ...(tools as object), cartShape: shape };
      }
    } catch (e) {
      addressError = String((e as Error).message).slice(0, 200);
    }
  }

  return json({
    setup: setupStatus(),
    appUrl: env.appUrl,
    flags,
    limits,
    spend,
    login,
    pinnedAddressId: env.pinnedAddressId ?? null,
    addresses,
    addressError,
    tools,
    devices: devices.map((d) => ({ id: d.id, name: d.name, locked: d.locked, revoked: d.revoked, lastSeen: d.lastSeen, createdAt: d.createdAt })),
    orders: orders.map((o) => ({ id: o.id, state: o.state, totalPaise: o.totalPaise, paymentMethod: o.paymentMethod, createdAt: o.createdAt, swiggyOrderIds: o.swiggyOrderIds })),
    unknownCount: unknowns.length,
  });
}
