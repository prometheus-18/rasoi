// Device PIN: asked at pairing and then once per 12 h (never per order).
// Peppered scrypt hash; atomic fail counter; 3 fails → owner alert, 5 → locked until /unlock.

import type { NextRequest, NextResponse } from "next/server";
import { hmacSign, hmacVerify, pinVerify } from "@/lib/crypto";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { getStore } from "@/lib/store";
import type { Device } from "@/lib/types";

export const PIN_COOKIE = "rasoi_pin";
const PIN_TTL_MS = 12 * 3600_000;

export type PinResult = { ok: boolean; locked: boolean; failsLeft?: number };

export async function verifyDevicePin(device: Device, pin: string): Promise<PinResult> {
  const store = getStore();
  if (device.locked) return { ok: false, locked: true };
  if (!device.pinHash || !device.pinSalt) return { ok: true, locked: false }; // demo device without PIN
  const ok = pinVerify(pin, device.pinSalt, device.pinHash);
  const { fails, locked } = await store.pinAttempt(device.id, ok);
  if (!ok) {
    if (locked) await sendOwner(`🔒 Device "${device.name}" locked after 5 wrong PINs. Send /unlock to unlock it.`);
    else if (fails === 3) await sendOwner(`⚠️ 3 wrong PIN attempts on device "${device.name}".`);
    await store.audit("pin_failed", { deviceId: device.id, data: { fails } });
  }
  return { ok, locked, failsLeft: Math.max(0, 5 - fails) };
}

function pinSecret(): string {
  return env.pinPepper ?? "rasoi-dev-pepper";
}

export function setPinCookie(res: NextResponse, deviceId: string): void {
  const exp = Date.now() + PIN_TTL_MS;
  const value = `${deviceId}.${exp}.${hmacSign(`${deviceId}.${exp}`, pinSecret())}`;
  res.cookies.set(PIN_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PIN_TTL_MS / 1000,
  });
}

/** Valid, unexpired PIN cookie for this device? Devices without a PIN always pass. */
export function pinCookieValid(req: NextRequest, device: Device): boolean {
  if (!device.pinHash) return true;
  const raw = req.cookies.get(PIN_COOKIE)?.value;
  if (!raw) return false;
  const [deviceId, expStr, sig] = raw.split(".");
  if (deviceId !== device.id) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return hmacVerify(`${deviceId}.${exp}`, sig, pinSecret());
}
