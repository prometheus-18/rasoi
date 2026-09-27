// POST { lines } → sync the live cart (pinned address), return the priced cart view.
// Takes the global cart lease (holder 'cart'). Refused while a checkout holds the exclusive lease,
// and the draft write is conditional on the state still being editable, so a late request can
// never clobber an approved snapshot.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { json, requireDraft } from "@/lib/api";
import { getProvider } from "@/lib/commerce/provider";
import { getStore } from "@/lib/store";
import type { DraftState, MatchedItem, PaymentMethod } from "@/lib/types";

export const maxDuration = 60;

const EDITABLE: DraftState[] = ["matched", "cart_synced"];

const zBody = z.object({
  lines: z.array(z.object({ spinId: z.string().min(1), skuId: z.string(), quantity: z.number().int().min(1).max(20) })).max(40),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireDraft(req, id);
  if (auth instanceof NextResponse) return auth;
  const { draft } = auth;
  if (!EDITABLE.includes(draft.state)) return json({ error: "bad_state", state: draft.state }, 409);

  const body = zBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "bad_request" }, 400);
  if (!body.data.lines.length) return json({ error: "empty", hi: "कुछ भी चुना नहीं है" }, 400);

  const store = getStore();
  if (!(await store.acquireLock(id, 10 * 60_000, "cart")))
    return json({ error: "busy", hi: "कोई और ऑर्डर चल रहा है — थोड़ी देर रुकें" }, 409);

  // Fresh read right before mutating the shared Swiggy cart: the confirm may have landed meanwhile.
  const fresh = await store.getDraft(id);
  if (!fresh || !EDITABLE.includes(fresh.state)) return json({ error: "bad_state", state: fresh?.state }, 409);

  const provider = await getProvider();
  try {
    const cart = await provider.updateCart(body.data.lines);
    const pay = cart.paymentOptions ?? (await provider.getPaymentOptions().catch(() => undefined));
    const paymentMethod: PaymentMethod = pay?.swiggyMoney?.available ? "SWIGGY_MONEY" : "COD";
    const view = { ...cart, paymentOptions: pay };

    // If the cook tapped a candidate, remember the choice on the matched rows.
    const matched = (fresh.matched ?? []).map((m: MatchedItem) => {
      if (m.chosen) return m;
      const line = body.data.lines.find((l) => m.candidates?.some((c) => c.variant.spinId === l.spinId));
      if (!line) return m;
      const pick = m.candidates!.find((c) => c.variant.spinId === line.spinId)!;
      return { ...m, status: "matched" as const, chosen: pick, quantity: line.quantity };
    });

    // Single conditional UPDATE: fields + state together, only while still editable.
    const saved = await store.casDraft(id, EDITABLE, { state: "cart_synced", cart: view, totalPaise: view.toPayPaise, paymentMethod, matched });
    if (!saved) {
      // the draft moved on (confirmed) while we were syncing — do not report this cart as current
      return json({ error: "bad_state", state: "changed", hi: "लिस्ट पक्की हो चुकी है" }, 409);
    }
    return json({ cart: view, paymentMethod, version: saved.version });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    await store.audit("cart_sync_failed", { draftId: id, data: { msg } });
    return json({ error: "cart_failed", hi: "दुकान से जवाब नहीं मिला — फिर कोशिश करें", detail: msg.slice(0, 200) }, 502);
  }
}
