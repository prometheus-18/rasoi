// Small helpers shared by route handlers. Auth table (docs/PLAN.md):
//  cook routes  → device cookie + draft ownership + same-origin check
//  owner routes → owner session cookie (see lib/auth/owner.ts)
//  telegram     → secret header;  cron → CRON_SECRET bearer

import { NextResponse, type NextRequest } from "next/server";
import { getDeviceFromRequest, originOk } from "@/lib/auth/device";
import { getStore } from "@/lib/store";
import type { Device, Draft } from "@/lib/types";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

export type DeviceAuth = { device: Device };

export async function requireDevice(req: NextRequest): Promise<DeviceAuth | NextResponse> {
  if (req.method !== "GET" && !originOk(req)) return json({ error: "bad_origin" }, 403);
  const device = await getDeviceFromRequest(req);
  if (!device) return json({ error: "unpaired" }, 401);
  if (device.locked) return json({ error: "locked", hi: "फ़ोन लॉक है — मालिक से खुलवाएं" }, 423);
  return { device };
}

export type DraftAuth = { device: Device; draft: Draft };

export async function requireDraft(req: NextRequest, draftId: string): Promise<DraftAuth | NextResponse> {
  const auth = await requireDevice(req);
  if (auth instanceof NextResponse) return auth;
  const draft = await getStore().getDraft(draftId);
  if (!draft || draft.deviceId !== auth.device.id) return json({ error: "not_found" }, 404);
  return { device: auth.device, draft };
}
