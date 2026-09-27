// GET → everything the cook UI needs to render this draft, including server-driven Hindi text.

import { NextResponse, type NextRequest } from "next/server";
import { json, requireDraft } from "@/lib/api";
import { getProvider } from "@/lib/commerce/provider";
import { getStore } from "@/lib/store";
import type { DraftState, TrackInfo } from "@/lib/types";

const STATE_HI: Record<DraftState, string> = {
  recorded: "सुन रहे हैं…",
  parsed: "लिस्ट बन रही है…",
  matched: "दाम देख रहे हैं…",
  cart_synced: "लिस्ट तैयार है",
  awaiting_confirm: "पक्का करें",
  awaiting_approval: "मालिक से पूछ रहे हैं…",
  approved: "ऑर्डर हो रहा है…",
  approved_waiting_login: "मालिक को भेज दिया ✓ — थोड़ा इंतज़ार",
  placing_swiggypay: "ऑर्डर हो रहा है…",
  placing_cod: "ऑर्डर हो रहा है…",
  placed: "✓ ऑर्डर हो गया",
  partially_placed: "कुछ सामान आ रहा है, कुछ नहीं आया",
  not_placed: "ऑर्डर नहीं हो पाया",
  unknown: "ऑर्डर शायद हो गया — दोबारा मत करना",
  superseded: "नई लिस्ट बन गई",
  expired: "समय निकल गया — फिर से बोलें",
  rejected: "मालिक ने मना किया",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireDraft(req, id);
  if (auth instanceof NextResponse) return auth;
  const { draft } = auth;

  // Live tracking for placed real orders, server-cached for 45 s.
  let track: TrackInfo | null = null;
  const orderIds = (draft.meta?.orderIds as string[] | undefined) ?? [];
  if (draft.state === "placed" && orderIds[0] && orderIds[0] !== "DRY-RUN") {
    const store = getStore();
    const key = `track:${orderIds[0]}`;
    track = await store.getKV<TrackInfo>(key);
    if (!track) {
      try {
        const provider = await getProvider();
        track = await provider.trackOrder(orderIds[0]);
        await store.setKV(key, track, 45_000);
      } catch {
        track = null;
      }
    }
  }

  return json({
    id: draft.id,
    state: draft.state,
    stateHi: STATE_HI[draft.state] ?? draft.state,
    error: draft.error,
    transcript: draft.transcript,
    items: draft.items,
    matched: draft.matched,
    cart: draft.cart,
    totalPaise: draft.totalPaise,
    paymentMethod: draft.paymentMethod,
    reasons: (draft.meta?.approvalReasons as { hi: string }[] | undefined)?.map((r) => r.hi) ?? [],
    swiggyMessage: (draft.meta?.swiggyMessage as string | undefined) ?? null,
    dry: Boolean(draft.meta?.dry),
    track,
    updatedAt: draft.updatedAt,
  });
}
