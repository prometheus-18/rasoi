// POST { code, pin, name? } → claims a one-time pairing code, sets the device cookie.
// POST { demo: true } works only in demo mode (no DATABASE_URL).
// Brute-force guard: 10 wrong codes (global, per IST day) lock pairing for an hour; owner alerted at 3.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { json, msg } from "@/lib/api";
import { claimDemoDevice, claimPairingCode, originOk, setDeviceCookie } from "@/lib/auth/device";
import { setPinCookie } from "@/lib/auth/pin";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { getStore } from "@/lib/store";

const zBody = z.union([
  z.object({ demo: z.literal(true) }),
  z.object({ code: z.string().min(4).max(12), pin: z.string().regex(/^\d{4,6}$/), name: z.string().max(40).optional() }),
]);

const MAX_FAILS = 10;
const LOCK_MS = 60 * 60_000;

export async function POST(req: NextRequest) {
  if (!originOk(req)) return json({ error: "bad_origin" }, 403);
  const body = zBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return msg("code_or_pin_bad", { error: "bad_request" }, 400);
  const store = getStore();

  if ("demo" in body.data) {
    if (!env.isDemo) return json({ error: "not_demo" }, 403);
    const claimed = await claimDemoDevice();
    if (!claimed) return json({ error: "not_demo" }, 403);
    const res = json({ ok: true, name: claimed.device.name, demo: true });
    setDeviceCookie(res, claimed.token);
    return res;
  }

  if (await store.getKV("pair_locked")) return msg("pair_locked", { error: "locked" }, 429);

  const claimed = await claimPairingCode(body.data.code, body.data.pin, body.data.name);
  if (!claimed) {
    const fails = ((await store.getKV<number>("pair_fails")) ?? 0) + 1;
    await store.setKV("pair_fails", fails, LOCK_MS);
    await store.audit("pair_failed", { data: { fails } });
    if (fails === 3) await sendOwner("⚠️ 3 wrong pairing codes were entered. If that is not you or the cook, /pause.");
    if (fails >= MAX_FAILS) {
      await store.setKV("pair_locked", true, LOCK_MS);
      await sendOwner("🔒 Pairing locked for 1 hour after 10 wrong codes.");
    }
    return msg("bad_code", { error: "bad_code" }, 400);
  }
  await store.deleteKV("pair_fails");
  await sendOwner(`📱 New device paired: "${claimed.device.name}". /devices to review, /pause if this wasn't you.`);
  const res = json({ ok: true, name: claimed.device.name });
  setDeviceCookie(res, claimed.token);
  setPinCookie(res, claimed.device.id);
  return res;
}
