// POST → cook finished hold-to-confirm (+ undo countdown). Policy decides:
// within limits → checkout starts in the background; otherwise → owner approval on Telegram.

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { json, msg, requireDraft } from "@/lib/api";
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
  if (!pinCookieValid(req, auth.device)) return msg("pin_required", { error: "pin_required" }, 401);

  const store = getStore();
  const confirmsToday = await store.countAudit("confirm", auth.device.id, istDayStart(new Date()));
  if (confirmsToday >= 10) return msg("rate_limited_confirm", { error: "rate_limited" }, 429);

  const outcome = await confirmDraft(auth.draft);
  switch (outcome.status) {
    case "placing":
      after(() => runCheckout(id));
      return msg("placing", { status: "placing" }, 202);
    case "awaiting_approval":
      return msg("asking_owner", { status: "awaiting_approval", reasons: outcome.reasons }, 202);
    case "paused":
      return msg("paused", { status: "paused" }, 409);
    case "blocked":
      return msg("blocked", { status: "blocked" }, 409);
    case "resync":
      return msg("prices_changed", { status: "resync", cart: outcome.cart }, 409);
    default:
      return json({ status: "invalid", error: outcome.error, hi: outcome.hi, en: outcome.en }, 409);
  }
}
