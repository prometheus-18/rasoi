// POST raw audio bytes → new draft with the parsed grocery list.
// Auth: device cookie. Rate limit: 30 voice notes per device per IST day.

import { NextResponse, type NextRequest } from "next/server";
import { json, requireDevice } from "@/lib/api";
import { istDayStart } from "@/lib/orders/policy";
import { getStore } from "@/lib/store";
import { parseGroceryAudio, VoiceParseError } from "@/lib/voice/gemini";

export const maxDuration = 60;

const MAX_BYTES = 6 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof NextResponse) return auth;
  const store = getStore();

  const today = await store.countDraftsSince(auth.device.id, istDayStart(new Date()));
  if (today >= 30) return json({ error: "rate_limited", hi: "आज के लिए बहुत हो गया — कल फिर बोलें" }, 429);

  const mime = (req.headers.get("content-type") ?? "audio/webm").split(";")[0];
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return json({ error: "too_large", hi: "बहुत लंबा हो गया — छोटा बोलें" }, 413);
  if (body.byteLength < 500) return json({ error: "too_short", hi: "कुछ सुनाई नहीं दिया — फिर से बोलें" }, 400);

  const draft = await store.createDraft({ deviceId: auth.device.id, state: "recorded" });
  const t0 = Date.now();
  try {
    const parsed = await parseGroceryAudio(new Uint8Array(body), mime);
    if (!parsed.items.length) {
      await store.updateDraftFields(draft.id, { error: "no_items" });
      return json({ error: "no_items", hi: "सामान समझ नहीं आया — फिर से बोलें", transcript: parsed.transcript }, 422);
    }
    const updated = await store.casDraft(draft.id, ["recorded"], {
      state: "parsed",
      transcript: parsed.transcript,
      items: parsed.items,
      meta: { model: parsed.model, parseMs: parsed.ms, audioMs: Date.now() - t0, mime },
    });
    await store.supersedeActiveDrafts(auth.device.id, draft.id);
    await store.audit("voice_parsed", {
      draftId: draft.id,
      deviceId: auth.device.id,
      data: { model: parsed.model, ms: parsed.ms, items: parsed.items.length, bytes: body.byteLength },
    });
    return json({ draftId: draft.id, transcript: parsed.transcript, items: updated?.items ?? parsed.items });
  } catch (e) {
    const quota = e instanceof VoiceParseError && e.quota;
    await store.updateDraftFields(draft.id, { error: String((e as Error).message).slice(0, 300) });
    await store.audit("voice_parse_failed", { draftId: draft.id, deviceId: auth.device.id, data: { quota } });
    return json(
      { error: "parse_failed", quota, hi: quota ? "आज की सुनने की सीमा खत्म — मालिक को बता दिया" : "समझ नहीं आया — फिर से बोलें" },
      502,
    );
  }
}
