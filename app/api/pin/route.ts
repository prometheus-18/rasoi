// POST { pin } → verifies the device PIN (needed once per 12 h before confirming orders).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { json, requireDevice } from "@/lib/api";
import { setPinCookie, verifyDevicePin } from "@/lib/auth/pin";

export async function POST(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof NextResponse) return auth;
  const body = z.object({ pin: z.string().regex(/^\d{4,6}$/) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "bad_request", hi: "पिन 4 अंकों का है" }, 400);

  const result = await verifyDevicePin(auth.device, body.data.pin);
  if (result.locked) return json({ error: "locked", hi: "फ़ोन लॉक हो गया — मालिक से खुलवाएं" }, 423);
  if (!result.ok) return json({ error: "wrong_pin", hi: `पिन गलत है (${result.failsLeft} मौके बचे)`, failsLeft: result.failsLeft }, 401);

  const res = json({ ok: true });
  setPinCookie(res, auth.device.id);
  return res;
}
