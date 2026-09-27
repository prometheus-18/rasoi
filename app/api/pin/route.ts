// POST { pin } → verifies the device PIN (needed once per 12 h before confirming orders).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { json, msg, requireDevice } from "@/lib/api";
import { setPinCookie, verifyDevicePin } from "@/lib/auth/pin";

export async function POST(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof NextResponse) return auth;
  const body = z.object({ pin: z.string().regex(/^\d{4,6}$/) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return msg("pin_format", { error: "bad_request" }, 400);

  const result = await verifyDevicePin(auth.device, body.data.pin);
  if (result.locked) return msg("device_locked_now", { error: "locked" }, 423);
  if (!result.ok) return msg("wrong_pin", { error: "wrong_pin", failsLeft: result.failsLeft }, 401, { n: result.failsLeft ?? 0 });

  const res = json({ ok: true });
  setPinCookie(res, auth.device.id);
  return res;
}
