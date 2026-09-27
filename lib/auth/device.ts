// Cook-device auth: HttpOnly cookie whose SHA-256 hash lives in the DB.
// Pairing: owner generates a one-time 6-digit code (10 min TTL) via the bot or /admin;
// the cook's phone claims it once and sets a PIN.

import type { NextRequest, NextResponse } from "next/server";
import { pinHash, randomDigits, randomToken, sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getStore } from "@/lib/store";
import type { Device } from "@/lib/types";

export const DEVICE_COOKIE = "rasoi_device";
const PAIR_TTL_MS = 10 * 60_000;

export async function getDeviceFromRequest(req: NextRequest): Promise<Device | null> {
  const token = req.cookies.get(DEVICE_COOKIE)?.value;
  if (!token) return null;
  const store = getStore();
  const device = await store.getDeviceByTokenHash(sha256Hex(token));
  if (device) void store.touchDevice(device.id).catch(() => {});
  return device;
}

/** Same-origin check for state-changing cook routes (CSRF hardening on top of SameSite). */
export function originOk(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches may omit Origin
  const host = req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function createPairingCode(name: string): Promise<string> {
  const code = randomDigits(6);
  await getStore().setKV(`pair:${sha256Hex(code)}`, { name }, PAIR_TTL_MS);
  return code;
}

export async function claimPairingCode(code: string, pin: string, name?: string): Promise<{ device: Device; token: string } | null> {
  const store = getStore();
  const pending = await store.takeKV<{ name: string }>(`pair:${sha256Hex(code.trim())}`);
  if (!pending) return null;
  const token = randomToken(32);
  const pinSalt = randomToken(8);
  const device = await store.createDevice({
    name: name?.trim() || pending.name || "cook",
    tokenHash: sha256Hex(token),
    pinHash: pin ? pinHash(pin, pinSalt) : undefined,
    pinSalt: pin ? pinSalt : undefined,
  });
  await store.audit("device_paired", { deviceId: device.id, data: { name: device.name } });
  return { device, token };
}

/** Demo mode only: auto-pair without a code (nothing real can happen without a DB anyway). */
export async function claimDemoDevice(): Promise<{ device: Device; token: string } | null> {
  if (!env.isDemo) return null;
  const store = getStore();
  const token = randomToken(32);
  const device = await store.createDevice({ name: "डेमो", tokenHash: sha256Hex(token) });
  return { device, token };
}

export function setDeviceCookie(res: NextResponse, token: string): void {
  res.cookies.set(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 400 * 24 * 3600,
  });
}
