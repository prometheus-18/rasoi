// POST → match the parsed items against the catalog (pantry_map → search).

import { NextResponse, type NextRequest } from "next/server";
import { json, requireDraft } from "@/lib/api";
import { getProvider } from "@/lib/commerce/provider";
import { matchItems } from "@/lib/orders/match";
import { getStore } from "@/lib/store";

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
  const matched = await matchItems(provider, draft.items);
  await store.updateDraftFields(id, { matched });
  const updated = await store.casDraft(id, ["parsed", "matched"], { state: "matched" });
  await store.audit("matched", {
    draftId: id,
    deviceId: auth.device.id,
    data: { ms: Date.now() - t0, provider: provider.name, found: matched.filter((m) => m.status !== "not_found").length, total: matched.length },
  });
  return json({ matched, state: updated?.state ?? "matched", provider: provider.name });
}
