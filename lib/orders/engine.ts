// Order engine: flags, spend windows, the confirm → approval flow, and the reconciler.
// Every state change is a CAS (single conditional UPDATE) via the store.

import { getProvider } from "@/lib/commerce/provider";
import { env } from "@/lib/env";
import { makeCallbackData, sendOwner } from "@/lib/notify/telegram";
import { DEFAULT_LIMITS, evaluatePolicy, istDayStart, istWeekStart, type Limits, type PolicyLine, type PolicyReason } from "@/lib/orders/policy";
import { getStore } from "@/lib/store";
import { rupeesText, type CartView, type Draft, type PaymentMethod } from "@/lib/types";

export type Flags = { paused: boolean; dryRun: boolean };

export async function getFlags(): Promise<Flags> {
  const f = await getStore().getKV<Partial<Flags>>("flags");
  return { paused: f?.paused ?? false, dryRun: f?.dryRun ?? true };
}

export async function setFlag(key: keyof Flags, value: boolean): Promise<void> {
  const f = await getFlags();
  await getStore().setKV("flags", { ...f, [key]: value });
  await getStore().audit("flag_changed", { data: { key, value } });
}

export async function getLimits(): Promise<Limits> {
  const patch = await getStore().getKV<Partial<Limits>>("limits");
  return { ...DEFAULT_LIMITS, ...(patch ?? {}) };
}

export async function setLimits(patch: Partial<Limits>): Promise<void> {
  const cur = await getStore().getKV<Partial<Limits>>("limits");
  await getStore().setKV("limits", { ...(cur ?? {}), ...patch });
  await getStore().audit("limits_changed", { data: patch });
}

export async function getOrderedNames(): Promise<Set<string>> {
  const names = await getStore().getKV<string[]>("ordered_names");
  return new Set(names ?? []);
}

export async function markOrderedNames(names: string[]): Promise<void> {
  const cur = await getOrderedNames();
  for (const n of names) cur.add(n.toLowerCase());
  await getStore().setKV("ordered_names", [...cur]);
}

export async function spendContext(now: Date): Promise<{ spentDayPaise: number; spentWeekPaise: number; ordersToday: number; codOrdersToday: number }> {
  const store = getStore();
  const day = await store.spendSince(istDayStart(now));
  const week = await store.spendSince(istWeekStart(now));
  return { spentDayPaise: day.totalPaise, spentWeekPaise: week.totalPaise, ordersToday: day.count, codOrdersToday: day.codCount };
}

/** Cart lines + their originating voice items (for per-item limits). */
export function policyLines(draft: Draft): PolicyLine[] {
  const cart = draft.cart;
  if (!cart) return [];
  return cart.items.map((ci) => {
    const m = (draft.matched ?? []).find((m) => m.chosen?.variant.spinId === ci.spinId);
    return { name: ci.name, linePaise: ci.linePaise, voice: m?.voice };
  });
}

export type ConfirmOutcome =
  | { status: "placing" }
  | { status: "awaiting_approval"; reasons: PolicyReason[] }
  | { status: "paused" }
  | { status: "blocked" }
  | { status: "resync"; cart: CartView }
  | { status: "invalid"; error: string };

/**
 * Called when the cook completes hold-to-confirm (+ undo countdown) on a cart_synced draft.
 * Policy decides: within limits → approved (checkout runs right after); otherwise → owner approval.
 */
export async function confirmDraft(draft: Draft): Promise<ConfirmOutcome> {
  const store = getStore();
  if (draft.state !== "cart_synced") return { status: "invalid", error: `state ${draft.state}` };
  if (!draft.cart || draft.cart.items.length === 0) return { status: "invalid", error: "empty cart" };

  const flags = await getFlags();
  if (flags.paused) return { status: "paused" };
  if (await store.anyBlockingOrder()) return { status: "blocked" };

  // Fresh cart check: silent re-sync; ask to re-confirm only if the total moved > ₹10 / 3 %.
  const provider = await getProvider();
  let cart = draft.cart;
  try {
    const fresh = await provider.getCart();
    if (fresh.items.length > 0) {
      const drift = Math.abs(fresh.toPayPaise - cart.toPayPaise);
      const itemsChanged =
        fresh.items.length !== cart.items.length ||
        fresh.items.some((fi) => !cart.items.find((ci) => ci.spinId === fi.spinId && ci.quantity === fi.quantity));
      if (itemsChanged || drift > Math.max(1000, cart.toPayPaise * 0.03)) {
        await store.updateDraftFields(draft.id, { cart: fresh, totalPaise: fresh.toPayPaise });
        return { status: "resync", cart: fresh };
      }
      cart = fresh;
    }
  } catch {
    // cart read failed — keep the stored snapshot; the checkout pre-flight re-verifies anyway
  }

  const method: PaymentMethod = draft.paymentMethod ?? "SWIGGY_MONEY";
  const now = new Date();
  const [limits, spend, orderedBefore] = await Promise.all([getLimits(), spendContext(now), getOrderedNames()]);
  const result = evaluatePolicy({
    toPayPaise: cart.toPayPaise,
    paymentMethod: method,
    lines: policyLines({ ...draft, cart }),
    now,
    ...spend,
    orderedBefore,
    limits,
  });
  await store.audit("confirm", {
    draftId: draft.id,
    deviceId: draft.deviceId,
    data: { verdict: result.verdict, reasons: result.reasons.map((x) => x.code), toPayPaise: cart.toPayPaise },
  });

  if (result.verdict === "allow") {
    const ok = await store.casDraft(draft.id, ["cart_synced"], {
      state: "approved",
      cart,
      totalPaise: cart.toPayPaise,
      approvedTotalPaise: cart.toPayPaise,
      paymentMethod: method,
    });
    if (!ok) return { status: "invalid", error: "state changed" };
    return { status: "placing" };
  }

  const ok = await store.casDraft(draft.id, ["cart_synced"], {
    state: "awaiting_approval",
    cart,
    totalPaise: cart.toPayPaise,
    paymentMethod: method,
    meta: { ...(draft.meta ?? {}), approvalReasons: result.reasons },
  });
  if (!ok) return { status: "invalid", error: "state changed" };

  // Cart hygiene: the shared Swiggy cart is cleared while we wait; the snapshot rebuilds it later.
  try {
    await provider.clearCart();
  } catch {}
  await store.releaseLock(draft.id);
  await notifyApprovalRequest({ ...draft, cart, totalPaise: cart.toPayPaise, version: ok.version }, result.reasons);
  return { status: "awaiting_approval", reasons: result.reasons };
}

function cartItemsText(cart: CartView): string {
  return cart.items.map((i) => `• ${i.name}${i.packDesc ? ` ${i.packDesc}` : ""} ×${i.quantity} — ₹${rupeesText(i.linePaise)}`).join("\n");
}

export async function notifyApprovalRequest(draft: Draft, reasons: PolicyReason[]): Promise<void> {
  const cart = draft.cart!;
  const approve = await makeCallbackData({ action: "approve", draftId: draft.id, version: draft.version });
  const reject = await makeCallbackData({ action: "reject", draftId: draft.id, version: draft.version });
  const method = draft.paymentMethod === "COD" ? "Cash on delivery" : "Swiggy Money";
  const why = reasons.map((x) => `- ${x.en}`).join("\n");
  await sendOwner(
    `Approval needed — ₹${rupeesText(cart.toPayPaise)} (${method})\n\n${cartItemsText(cart)}\n\nHeard: "${draft.transcript ?? ""}"\n\nWhy:\n${why}\n\nButtons expire in 60 min.`,
    [[{ text: `✅ Approve ₹${rupeesText(cart.toPayPaise)}`, callback_data: approve }, { text: "❌ Reject", callback_data: reject }]],
  );
}

/** Owner tapped Approve. Version must match what was shown. Returns the next step. */
export async function approveDraft(draftId: string, version?: number): Promise<"checkout" | "waiting_login" | "stale" | "gone"> {
  const store = getStore();
  const draft = await store.getDraft(draftId);
  if (!draft || draft.state !== "awaiting_approval") return "gone";
  if (version !== undefined && draft.version !== version) return "stale";

  const auth = await store.getSwiggyAuth();
  const loginOk = env.isDemo || (auth && auth.expiresAt.getTime() > Date.now() + 60_000);
  const ok = await store.casDraft(draftId, ["awaiting_approval"], {
    state: loginOk ? "approved" : "approved_waiting_login",
    approvedTotalPaise: draft.totalPaise ?? draft.cart?.toPayPaise ?? 0,
  });
  if (!ok) return "gone";
  await store.audit("approved", { draftId });
  return loginOk ? "checkout" : "waiting_login";
}

export async function rejectDraft(draftId: string): Promise<boolean> {
  const ok = await getStore().casDraft(draftId, ["awaiting_approval"], { state: "rejected", error: "मालिक ने मना किया" });
  if (ok) await getStore().audit("rejected", { draftId });
  return Boolean(ok);
}

/** After a successful re-login: release any drafts that were approved while logged out. */
export async function resumeWaitingDrafts(runCheckout: (draftId: string) => Promise<void>): Promise<number> {
  const store = getStore();
  let n = 0;
  const waiting = (await store.getKV<string[]>("waiting_login_drafts")) ?? [];
  for (const id of waiting) {
    const ok = await store.casDraft(id, ["approved_waiting_login"], { state: "approved" });
    if (ok) {
      n++;
      await runCheckout(id);
    }
  }
  await store.deleteKV("waiting_login_drafts");
  return n;
}

export async function trackWaitingDraft(draftId: string): Promise<void> {
  const store = getStore();
  const waiting = (await store.getKV<string[]>("waiting_login_drafts")) ?? [];
  if (!waiting.includes(draftId)) await store.setKV("waiting_login_drafts", [...waiting, draftId]);
}

/**
 * Reconcile unknown orders against get_orders: match by total (±₹1) and time window.
 * Runs after a checkout timeout and from cron. An unmatched unknown keeps blocking checkouts.
 */
export async function reconcileUnknownOrders(): Promise<void> {
  const store = getStore();
  const unknowns = await store.unknownOrders();
  if (!unknowns.length) return;
  const provider = await getProvider();
  let providerOrders: Awaited<ReturnType<typeof provider.getOrders>> = [];
  try {
    providerOrders = await provider.getOrders(20);
  } catch (e) {
    console.error("reconcile: get_orders failed", String(e));
    return;
  }
  for (const u of unknowns) {
    const from = u.createdAt.getTime() - 2 * 60_000;
    const to = u.createdAt.getTime() + 15 * 60_000;
    const match = providerOrders.find((o) => {
      if (o.totalPaise === undefined) return false;
      if (Math.abs(o.totalPaise - u.totalPaise) > 100) return false;
      if (!o.createdAt) return true; // total matches, no timestamp — accept
      const ts = Date.parse(o.createdAt);
      return Number.isNaN(ts) ? true : ts >= from && ts <= to;
    });
    if (match) {
      await store.updateOrder(u.id, { state: "placed", swiggyOrderIds: [match.orderId], placedAt: new Date() });
      await store.casDraft(u.draftId, ["unknown"], { state: "placed" });
      await store.audit("unknown_reconciled_placed", { draftId: u.draftId, data: { orderId: match.orderId } });
      await sendOwner(`✅ Resolved: the ₹${rupeesText(u.totalPaise)} order DID go through (order ${match.orderId}). New orders are unblocked.`);
    }
  }
}

/** Owner /resolve: manually settle an unknown order. */
export async function resolveUnknown(orderId: string, placed: boolean): Promise<void> {
  const store = getStore();
  const u = (await store.unknownOrders()).find((o) => o.id === orderId);
  if (!u) return;
  await store.updateOrder(u.id, { state: placed ? "placed" : "not_placed", ...(placed ? { placedAt: new Date() } : {}) });
  await store.casDraft(u.draftId, ["unknown"], { state: placed ? "placed" : "not_placed" });
  await store.audit("unknown_resolved_manually", { draftId: u.draftId, data: { placed } });
}
