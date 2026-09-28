// POST raw audio bytes → new draft with the parsed grocery list.
// Auth: device cookie. Rate limit: 30 voice notes per device per IST day.
// On total failure the OWNER is told (forward-on-failure) before the cook is told "मालिक को बता दिया".

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { json, msg, requireDevice } from "@/lib/api";
import { cleanupAbandonedCart } from "@/lib/orders/engine";
import { sendOwner } from "@/lib/notify/telegram";
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
  if (today >= 30) return msg("rate_limited_voice", { error: "rate_limited" }, 429);

  const mime = (req.headers.get("content-type") ?? "audio/webm").split(";")[0];
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return msg("too_long", { error: "too_large" }, 413);
  if (body.byteLength < 500) return msg("nothing_heard", { error: "too_short" }, 400);

  const draft = await store.createDraft({ deviceId: auth.device.id, state: "recorded" });
  const t0 = Date.now();
  try {
    const parsed = await parseGroceryAudio(new Uint8Array(body), mime);
    if (!parsed.items.length) {
      await store.updateDraftFields(draft.id, { error: "no_items", meta: { path: parsed.path, errors: parsed.errors } });
      return msg("no_items", { error: "no_items", transcript: parsed.transcript }, 422);
    }
    const updated = await store.casDraft(draft.id, ["recorded"], {
      state: "parsed",
      transcript: parsed.transcript,
      items: parsed.items,
      meta: { model: parsed.model, path: parsed.path, degraded: parsed.degraded, parseMs: parsed.ms, totalMs: Date.now() - t0, mime, errors: parsed.errors },
    });
    await store.supersedeActiveDrafts(auth.device.id, draft.id);
    after(() => cleanupAbandonedCart());
    await store.audit("voice_parsed", {
      draftId: draft.id,
      deviceId: auth.device.id,
      data: { model: parsed.model, path: parsed.path, ms: parsed.ms, items: parsed.items.length, bytes: body.byteLength, degraded: parsed.degraded },
    });
    if (parsed.degraded && parsed.errors.some((e) => /429|quota|exhausted/i.test(e))) {
      // still worked via fallback, but the owner should know the primary quota is gone
      const throttled = await store.getKV("quota_alert_sent");
      if (!throttled) {
        await store.setKV("quota_alert_sent", true, 3 * 3600_000);
        await sendOwner(`ℹ️ Gemini quota exhausted — voice is running on the fallback (${parsed.path}). Resets ~12:30 PM IST.`);
      }
    }
    return json({ draftId: draft.id, transcript: parsed.transcript, items: updated?.items ?? parsed.items, path: parsed.path, degraded: parsed.degraded });
  } catch (e) {
    const err = e instanceof VoiceParseError ? e : new VoiceParseError([String((e as Error).message)], false);
    await store.updateDraftFields(draft.id, { error: err.message.slice(0, 300), meta: { errors: err.errors } });
    await store.audit("voice_parse_failed", { draftId: draft.id, deviceId: auth.device.id, data: { quota: err.quota, errors: err.errors } });
    await sendOwner(
      `🎤 Voice note from "${auth.device.name}" could not be understood${err.quota ? " (API quota exhausted)" : ""}. Ask the cook what they need.\n${err.errors.slice(0, 3).join("\n")}`,
    );
    return msg(err.quota ? "quota_out" : "parse_failed", { error: "parse_failed", quota: err.quota }, 502);
  }
}
