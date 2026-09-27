// GET → everything the cook UI needs to render this draft, with server-driven text in both languages.

import { NextResponse, type NextRequest } from "next/server";
import { json, requireDraft } from "@/lib/api";
import { getProvider } from "@/lib/commerce/provider";
import { resolveMsg, STATE_MSG } from "@/lib/i18n";
import { getStore } from "@/lib/store";
import type { TrackInfo } from "@/lib/types";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireDraft(req, id);
  if (auth instanceof NextResponse) return auth;
  const { draft } = auth;

  // Live tracking for placed real orders, server-cached for 45 s.
  // Only status + ETA leave the server: the raw track_order payload carries the address/phone.
  let track: { status?: string; etaMinutes?: number } | null = null;
  const orderIds = (draft.meta?.orderIds as string[] | undefined) ?? [];
  if (draft.state === "placed" && orderIds[0] && orderIds[0] !== "DRY-RUN") {
    const store = getStore();
    const key = `track:${orderIds[0]}`;
    let full = await store.getKV<TrackInfo>(key);
    if (!full) {
      try {
        const provider = await getProvider();
        full = await provider.trackOrder(orderIds[0]);
        await store.setKV(key, full, 45_000);
      } catch {
        full = null;
      }
    }
    if (full) track = { status: full.status, etaMinutes: full.etaMinutes };
  }

  const stateMsg = STATE_MSG[draft.state] ?? { hi: draft.state, en: draft.state };
  const errorMsg = resolveMsg(draft.error);
  const reasons = ((draft.meta?.approvalReasons as { hi: string; en: string }[] | undefined) ?? []).map((r) => ({ hi: r.hi, en: r.en }));

  return json({
    id: draft.id,
    state: draft.state,
    stateHi: stateMsg.hi,
    stateEn: stateMsg.en,
    error: draft.error,
    errorHi: errorMsg?.hi ?? null,
    errorEn: errorMsg?.en ?? null,
    transcript: draft.transcript,
    items: draft.items,
    matched: draft.matched,
    cart: draft.cart,
    totalPaise: draft.totalPaise,
    paymentMethod: draft.paymentMethod,
    reasons,
    swiggyMessage: (draft.meta?.swiggyMessage as string | undefined) ?? null,
    dry: Boolean(draft.meta?.dry),
    track,
    version: draft.version,
    updatedAt: draft.updatedAt,
  });
}
