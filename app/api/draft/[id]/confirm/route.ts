// POST → cook finished hold-to-confirm (+ undo countdown). Policy decides:
// within limits → checkout starts in the background; otherwise → owner approval on Telegram.

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { json, requireDraft } from "@/lib/api";
import { pinCookieValid } from "@/lib/auth/pin";
import { confirmDraft } from "@/lib/orders/engine";
import { runCheckout } from "@/lib/orders/checkout";
import { istDayStart } from "@/lib/orders/policy";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireDraft(req, id);
  if (auth instanceof NextResponse) return auth;
  if (!pinCookieValid(req, auth.device)) return json({ error: "pin_required", hi: "पहले पिन डालें" }, 401);

  const store = getStore();
  const confirmsToday = await store.countAudit("confirm", auth.device.id, istDayStart(new Date()));
  if (confirmsToday >= 10) return json({ error: "rate_limited", hi: "आज के ऑर्डर पूरे हो गए" }, 429);

  const outcome = await confirmDraft(auth.draft);
  switch (outcome.status) {
    case "placing":
      after(() => runCheckout(id));
      return json({ status: "placing", hi: "ऑर्डर हो रहा है…" }, 202);
    case "awaiting_approval":
      return json({ status: "awaiting_approval", hi: "मालिक से पूछ रहे हैं…", reasons: outcome.reasons }, 202);
    case "paused":
      return json({ status: "paused", hi: "अभी रुका हुआ है — मालिक से पूछें" }, 409);
    case "blocked":
      return json({ status: "blocked", hi: "पिछला ऑर्डर पक्का नहीं हुआ — मालिक को बता दिया" }, 409);
    case "resync":
      return json({ status: "resync", hi: "दाम बदल गए — फिर से देख लें", cart: outcome.cart }, 409);
    default:
      return json({ status: "invalid", error: outcome.error }, 409);
  }
}
