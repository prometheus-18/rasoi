// GET → everything the /admin page shows. Owner-only (open during setup, see lib/auth/owner.ts).

import { NextResponse, type NextRequest } from "next/server";
import { json } from "@/lib/api";
import { isOwnerRequest } from "@/lib/auth/owner";
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
  return json({
    setup: setupStatus(),
    appUrl: env.appUrl,
    flags,
    limits,
    spend,
    login,
    devices: devices.map((d) => ({ id: d.id, name: d.name, locked: d.locked, revoked: d.revoked, lastSeen: d.lastSeen, createdAt: d.createdAt })),
    orders: orders.map((o) => ({ id: o.id, state: o.state, totalPaise: o.totalPaise, paymentMethod: o.paymentMethod, createdAt: o.createdAt, swiggyOrderIds: o.swiggyOrderIds })),
    unknownCount: unknowns.length,
  });
}
