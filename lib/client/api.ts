"use client";

// Fetch helper for the cook UI. On an unpaired device it tries demo auto-pairing once
// (works only when the server runs without a database), else sends the cook to /pair.

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(data?.hi ?? data?.error ?? `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

let pairingTried = false;

/** Ensure this device is paired; auto-pairs in demo mode. Returns warm info or redirects. */
export async function ensureReady(): Promise<any | null> {
  try {
    return await api("/api/warm");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && !pairingTried) {
      pairingTried = true;
      try {
        await api("/api/pair", { method: "POST", body: JSON.stringify({ demo: true }) });
        return await api("/api/warm");
      } catch {
        window.location.href = "/pair";
        return null;
      }
    }
    if (e instanceof ApiError && e.status === 401) {
      window.location.href = "/pair";
      return null;
    }
    throw e;
  }
}
