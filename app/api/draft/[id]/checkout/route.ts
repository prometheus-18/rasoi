// POST → (re)start placement of an already-approved draft. Idempotent:
// runCheckout's unique order key guarantees at most one real checkout call ever.

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { json, requireDraft } from "@/lib/api";
import { runCheckout } from "@/lib/orders/checkout";

export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireDraft(req, id);
  if (auth instanceof NextResponse) return auth;
  if (auth.draft.state !== "approved") return json({ error: "bad_state", state: auth.draft.state }, 409);
  after(() => runCheckout(id));
  return json({ status: "placing", hi: "ऑर्डर हो रहा है…" }, 202);
}
