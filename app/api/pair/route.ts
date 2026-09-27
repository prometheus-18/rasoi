// POST { code, pin, name? } → claims a one-time pairing code, sets the device cookie.
// POST { demo: true } works only in demo mode (no DATABASE_URL).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { json } from "@/lib/api";
import { claimDemoDevice, claimPairingCode, originOk, setDeviceCookie } from "@/lib/auth/device";
import { setPinCookie } from "@/lib/auth/pin";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";

const zBody = z.union([
  z.object({ demo: z.literal(true) }),
  z.object({ code: z.string().min(4).max(12), pin: z.string().regex(/^\d{4,6}$/), name: z.string().max(40).optional() }),
]);

export async function POST(req: NextRequest) {
  if (!originOk(req)) return json({ error: "bad_origin" }, 403);
  const body = zBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "bad_request", hi: "कोड या पिन ठीक नहीं है" }, 400);

  if ("demo" in body.data) {
    if (!env.isDemo) return json({ error: "not_demo" }, 403);
    const claimed = await claimDemoDevice();
    if (!claimed) return json({ error: "not_demo" }, 403);
    const res = json({ ok: true, name: claimed.device.name, demo: true });
    setDeviceCookie(res, claimed.token);
    return res;
  }

  const claimed = await claimPairingCode(body.data.code, body.data.pin, body.data.name);
  if (!claimed) return json({ error: "bad_code", hi: "कोड गलत या पुराना है — मालिक से नया कोड लें" }, 400);
  await sendOwner(`📱 New device paired: "${claimed.device.name}". /devices to review, /pause if this wasn't you.`);
  const res = json({ ok: true, name: claimed.device.name });
  setDeviceCookie(res, claimed.token);
  setPinCookie(res, claimed.device.id);
  return res;
}
