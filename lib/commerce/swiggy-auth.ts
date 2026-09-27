// Swiggy MCP OAuth 2.1: dynamic client registration + PKCE, paste-back redirect
// (http://localhost/callback is allowlisted; our Vercel URL is not until Swiggy approves it).
// The access token (5 days, no refresh token) is stored AES-256-GCM encrypted in the DB.

import { aesDecrypt, aesEncrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getStore } from "@/lib/store";
import { CommerceError } from "@/lib/commerce/swiggy-errors";

const REDIRECT_URI = "http://localhost/callback";
const LOGIN_TTL_MS = 15 * 60_000;

type PendingLogin = { verifier: string; clientId: string; state: string };

async function registerClient(): Promise<string> {
  const res = await fetch(`${env.swiggyAuthBase}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "rasoi",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: "mcp:tools",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: string };
  if (!res.ok || !body.client_id) throw new Error(`Swiggy DCR failed: HTTP ${res.status}`);
  return body.client_id;
}

/** Start a login. Several may be pending at once (owner can tap the link twice). */
export async function startSwiggyLogin(): Promise<{ authorizeUrl: string }> {
  const store = getStore();
  const verifier = randomToken(32);
  const challenge = base64UrlSha256(verifier);
  const state = randomToken(16);
  const clientId = await registerClient();
  await store.setKV(`swiggy_login:${state}`, { verifier, clientId, state } satisfies PendingLogin, LOGIN_TTL_MS);
  await store.setKV("swiggy_login_latest", state, LOGIN_TTL_MS);
  const url = new URL(`${env.swiggyAuthBase}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "mcp:tools",
  }).toString();
  await store.audit("swiggy_login_started");
  return { authorizeUrl: url.toString() };
}

function base64UrlSha256(s: string): string {
  // sha256Hex returns hex; we need base64url of the raw digest
  const hex = sha256Hex(s);
  return Buffer.from(hex, "hex").toString("base64url");
}

/** Accepts the full pasted URL or just the code (auth code is valid 120 s — be quick). */
export async function completeSwiggyPaste(pasted: string): Promise<{ expiresAt: Date }> {
  const store = getStore();
  const codeMatch = pasted.match(/[?&]code=([^&\s]+)/) ?? pasted.trim().match(/^([A-Za-z0-9_.~-]{8,})$/);
  if (!codeMatch) throw new Error("no_code");
  const code = decodeURIComponent(codeMatch[1]);
  const stateMatch = pasted.match(/[?&]state=([^&\s]+)/);
  const state = stateMatch ? decodeURIComponent(stateMatch[1]) : await store.getKV<string>("swiggy_login_latest");
  if (!state) throw new Error("no_pending_login");
  const pending = await store.takeKV<PendingLogin>(`swiggy_login:${state}`);
  if (!pending) throw new Error("login_expired");

  const res = await fetch(`${env.swiggyAuthBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: REDIRECT_URI,
      client_id: pending.clientId,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new Error(`token_exchange_failed_${res.status}`);

  const expiresAt = new Date(Date.now() + (body.expires_in ?? 432_000) * 1000);
  await store.setSwiggyAuth({
    accessTokenEnc: aesEncrypt(body.access_token),
    clientId: pending.clientId,
    expiresAt,
  });
  await store.audit("swiggy_login_completed", { data: { expiresAt: expiresAt.toISOString() } });
  return { expiresAt };
}

export async function getSwiggyAccessToken(): Promise<string> {
  const auth = await getStore().getSwiggyAuth();
  if (!auth) throw new CommerceError("AUTH", "no Swiggy login stored");
  if (auth.expiresAt.getTime() < Date.now() + 60_000) throw new CommerceError("AUTH", "Swiggy token expired");
  return aesDecrypt(auth.accessTokenEnc);
}

export async function swiggyLoginStatus(): Promise<{ loggedIn: boolean; expiresAt?: string; hoursLeft?: number }> {
  const auth = await getStore().getSwiggyAuth();
  if (!auth) return { loggedIn: false };
  const msLeft = auth.expiresAt.getTime() - Date.now();
  return { loggedIn: msLeft > 60_000, expiresAt: auth.expiresAt.toISOString(), hoursLeft: Math.max(0, Math.floor(msLeft / 3600_000)) };
}
