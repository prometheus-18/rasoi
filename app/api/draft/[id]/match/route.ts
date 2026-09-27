// POST → match the parsed items against the catalog (pantry_map → search).
// A Swiggy outage / expired login is NOT "not found": the draft is parked, the owner gets the
// list on Telegram, and the cook sees "मालिक को भेज दिया ✓" (never a dead end).

import { NextResponse, type NextRequest } from "next/server";
import { json, msg, requireDraft } from "@/lib/api";
import { getProvider } from "@/lib/commerce/provider";
import { CommerceError } from "@/lib/commerce/swiggy-errors";
import { sendOwner } from "@/lib/notify/telegram";
import { matchItems } from "@/lib/orders/match";
import { getStore } from "@/lib/store";
import { qtyTextHi } from "@/lib/voice/units";

export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireDraft(req, id);
  if (auth instanceof NextResponse) return auth;
  const { draft } = auth;
  if (!["parsed", "matched"].includes(draft.state)) return json({ error: "bad_state", state: draft.state }, 409);
  if (!draft.items?.length) return json({ error: "no_items" }, 409);

  const store = getStore();
  const t0 = Date.now();
  const provider = await getProvider();
  try {
    const matched = await matchItems(provider, draft.items);
    await store.updateDraftFields(id, { matched }, ["parsed", "matched"]);
    const updated = await store.casDraft(id, ["parsed", "matched"], { state: "matched" });
    await store.audit("matched", {
      draftId: id,
      deviceId: auth.device.id,
      data: { ms: Date.now() - t0, provider: provider.name, found: matched.filter((m) => m.status !== "not_found").length, total: matched.length },
    });
    return json({ matched, state: updated?.state ?? "matched", provider: provider.name });
  } catch (e) {
    const code = e instanceof CommerceError ? e.code : "UNKNOWN";
    const loginNeeded = code === "AUTH";
    const list = draft.items.map((i) => `• ${i.name_hi} (${i.search_en}) ${qtyTextHi(i)}`).join("\n");
    await store.updateDraftFields(id, { error: loginNeeded ? "login_needed" : "swiggy_down", meta: { ...(draft.meta ?? {}), forwardedToOwner: true } }, ["parsed", "matched"]);
    await store.audit("match_forwarded", { draftId: id, deviceId: auth.device.id, data: { code } });
    await sendOwner(
      `${loginNeeded ? "🔑 Swiggy login has expired" : "⚠️ Swiggy is not responding"} — the cook's list could not be priced. Here it is:\n${list}\n\nHeard: "${draft.transcript ?? ""}"\n${loginNeeded ? "Send /login to fix it." : "Try again in a few minutes."}`,
    );
    return msg("forwarded", { error: loginNeeded ? "login_needed" : "swiggy_down" }, 502);
  }
}
