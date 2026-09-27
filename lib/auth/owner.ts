// Owner auth: a 12 h session cookie minted ONLY from a one-time 10-minute link
// that the Telegram bot sends on /admin (or /login). Until Telegram is configured
// there is nothing sensitive behind /admin, so it stays open for setup.

import type { NextRequest, NextResponse } from "next/server";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getStore } from "@/lib/store";

export const OWNER_COOKIE = "rasoi_owner";
const LINK_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 12 * 3600_000;

/** One-time link the bot sends. `next` must be a same-app path. */
export async function createOwnerLink(next = "/admin"): Promise<string> {
  const token = randomToken(24);
  await getStore().setKV(`ownerlink:${sha256Hex(token)}`, { next }, LINK_TTL_MS);
  return `${env.appUrl}/api/admin/session?t=${token}`;
}

export async function exchangeOwnerLink(token: string): Promise<{ session: string; next: string } | null> {
  const store = getStore();
  const link = await store.takeKV<{ next: string }>(`ownerlink:${sha256Hex(token)}`);
  if (!link) return null;
  const session = randomToken(32);
  await store.setKV(`ownersess:${sha256Hex(session)}`, { at: new Date().toISOString() }, SESSION_TTL_MS);
  await store.audit("owner_session_created");
  const next = link.next.startsWith("/") ? link.next : "/admin";
  return { session, next };
}

export async function isOwnerRequest(req: NextRequest): Promise<boolean> {
  // Setup phase: no Telegram bot yet → no way to mint a link → allow (nothing sensitive exists yet).
  if (!env.telegramConfigured) return true;
  const session = req.cookies.get(OWNER_COOKIE)?.value;
  if (!session) return false;
  return (await getStore().getKV(`ownersess:${sha256Hex(session)}`)) !== null;
}

export function setOwnerCookie(res: NextResponse, session: string): void {
  res.cookies.set(OWNER_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}
