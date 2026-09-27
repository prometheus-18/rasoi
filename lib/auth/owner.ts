// Owner auth: a 12 h session cookie minted ONLY from
//  (a) a one-time 10-minute link the Telegram bot sends (/admin, /login), or
//  (b) the ADMIN_SETUP_KEY env var during setup, before the bot exists.
// In demo mode (no database) nothing real exists, so /admin stays open.

import type { NextRequest, NextResponse } from "next/server";
import { randomToken, sha256Hex, timingSafeEqualStr } from "@/lib/crypto";
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

/** Peek without consuming (the GET renders a confirm page; only the POST consumes). */
export async function peekOwnerLink(token: string): Promise<{ next: string } | null> {
  return await getStore().getKV<{ next: string }>(`ownerlink:${sha256Hex(token)}`);
}

export async function exchangeOwnerLink(token: string): Promise<{ session: string; next: string } | null> {
  const store = getStore();
  const link = await store.takeKV<{ next: string }>(`ownerlink:${sha256Hex(token)}`);
  if (!link) return null;
  const session = await mintSession();
  const next = link.next.startsWith("/") ? link.next : "/admin";
  return { session, next };
}

/** Setup-phase login with the ADMIN_SETUP_KEY env var (constant-time compare). */
export async function exchangeSetupKey(key: string): Promise<string | null> {
  if (!env.adminSetupKey || !timingSafeEqualStr(key, env.adminSetupKey)) return null;
  return await mintSession();
}

async function mintSession(): Promise<string> {
  const session = randomToken(32);
  await getStore().setKV(`ownersess:${sha256Hex(session)}`, { at: new Date().toISOString() }, SESSION_TTL_MS);
  await getStore().audit("owner_session_created");
  return session;
}

export async function isOwnerRequest(req: NextRequest): Promise<boolean> {
  if (env.isDemo) return true; // no database → nothing sensitive can exist yet
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
