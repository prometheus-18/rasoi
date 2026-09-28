// Order engine: flags, spend windows, the confirm → approval flow, sweepers and the reconciler.
// Every state change is a CAS (single conditional UPDATE) via the store.

import { getProvider } from "@/lib/commerce/provider";
import { env } from "@/lib/env";
import { MSG } from "@/lib/i18n";
import { makeCallbackData, sendOwner } from "@/lib/notify/telegram";
import { DEFAULT_LIMITS, evaluatePolicy, istDayStart, istWeekStart, type Limits, type PolicyLine, type PolicyReason } from "@/lib/orders/policy";
import { getStore } from "@/lib/store";
import { rupeesText, type CartView, type Draft, type DraftState, type PaymentMethod } from "@/lib/types";

export type Flags = { paused: boolean; dryRun: boolean };

const MIN_ORDER_PAISE = 99_00;
/** A 'placing' order row older than this means the function died mid-checkout. */
export const STALE_PLACING_MS = 10 * 60_000;

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

export type SpendContext = { spentDayPaise: number; spentWeekPaise: number; ordersToday: number; codOrdersToday: number };

/** Conservative spend: placing + placed + partially_placed + unknown order rows all count. */
export async function spendContext(now: Date): Promise<SpendContext> {
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
  | { status: "invalid"; error: string; hi?: string; en?: string };

/**
 * Called when the cook completes hold-to-confirm (+ undo countdown) on a cart_synced draft.
 * Policy decides: within limits → approved (checkout runs right after); otherwise → owner approval.
 */
export async function confirmDraft(draft: Draft): Promise<ConfirmOutcome> {
  const store = getStore();
  if (draft.state !== "cart_synced") return { status: "invalid", error: `state ${draft.state}` };
  if (!draft.cart || draft.cart.items.length === 0) return { status: "invalid", error: "empty cart", ...MSG.nothing_chosen };

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
        // conditional write: only while still cart_synced, so nothing post-approval is ever clobbered
        await store.updateDraftFields(draft.id, { cart: fresh, totalPaise: fresh.toPayPaise }, ["cart_synced"]);
        return { status: "resync", cart: fresh };
      }
      cart = fresh;
    }
  } catch {
    // cart read failed — keep the stored snapshot; the checkout pre-flight re-verifies anyway
  }

  const itemTotal = cart.itemTotalPaise ?? cart.items.reduce((s, i) => s + i.linePaise, 0);
  if (itemTotal < MIN_ORDER_PAISE) return { status: "invalid", error: "below_min_order", ...MSG.below_min };
  if (cart.toPayPaise <= 0) return { status: "invalid", error: "zero_total", ...MSG.zero_total };

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
    `Approval needed — ₹${rupeesText(cart.toPayPaise)} (${method})\n\n${cartItemsText(cart)}\n\nHeard: "${draft.transcript ?? ""}"\n\nWhy:\n${why}\n\nButtons expire in 60 min. Keep the Swiggy app CLOSED until this order completes (Swiggy warns of session conflicts).`,
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
  const ok = await getStore().casDraft(draftId, ["awaiting_approval"], { state: "rejected", error: "err_rejected" });
  if (ok) await getStore().audit("rejected", { draftId });
  return Boolean(ok);
}

/**
 * After a successful re-login: release drafts that were approved while logged out.
 * Query-based (no side list), so nothing can be lost between park and resume.
 */
export async function resumeWaitingDrafts(runCheckout: (draftId: string) => Promise<void>): Promise<number> {
  const store = getStore();
  let n = 0;
  for (const d of await store.listDraftsByState(["approved_waiting_login"])) {
    if (await store.casDraft(d.id, ["approved_waiting_login"], { state: "approved" })) {
      n++;
      await runCheckout(d.id);
    }
  }
  return n;
}

/**
 * Sweeper: any draft still 'approved' (paused at the time, blocked by an unknown order, lock
 * contention, or a crash before the placing CAS) gets another runCheckout. Idempotent — the
 * order key guarantees at most one real attempt. Called from /resume, /resolve, login and cron.
 */
export async function retryApprovedDrafts(runCheckout: (draftId: string) => Promise<void>): Promise<number> {
  const store = getStore();
  let n = 0;
  for (const d of await store.listDraftsByState(["approved"])) {
    n++;
    await runCheckout(d.id);
  }
  return n;
}

/**
 * Re-check ONLY the spend-window rules for a draft about to be placed. Item-level rules were
 * already accepted at approval; but a concurrent order may have consumed the day/week budget
 * since. `ownOrderPaise`/`ownIsCod` exclude the caller's own freshly inserted 'placing' row.
 */
export async function spendGuard(draft: Draft, ownOrderPaise: number, ownIsCod: boolean): Promise<PolicyReason[]> {
  const now = new Date();
  const [limits, spend, orderedBefore] = await Promise.all([getLimits(), spendContext(now), getOrderedNames()]);
  const result = evaluatePolicy({
    toPayPaise: ownOrderPaise,
    paymentMethod: draft.paymentMethod ?? "SWIGGY_MONEY",
    lines: policyLines(draft),
    now,
    spentDayPaise: Math.max(0, spend.spentDayPaise - ownOrderPaise),
    spentWeekPaise: Math.max(0, spend.spentWeekPaise - ownOrderPaise),
    ordersToday: Math.max(0, spend.ordersToday - 1),
    codOrdersToday: Math.max(0, spend.codOrdersToday - (ownIsCod ? 1 : 0)),
    orderedBefore,
    limits: { ...limits, supervised: false },
  });
  const WINDOW_CODES = new Set(["OVER_DAY_LIMIT", "OVER_WEEK_LIMIT", "TOO_MANY_ORDERS", "COD_COUNT"]);
  return result.reasons.filter((r) => WINDOW_CODES.has(r.code));
}

/**
 * Reconcile unknown orders against get_orders. A match needs the same total (±₹1) AND a parseable
 * timestamp inside the window — a total alone can match last week's order.
 * Also converts crashed 'placing' rows into 'unknown' first so they become resolvable.
 */
export async function reconcileUnknownOrders(): Promise<void> {
  const store = getStore();
  const stale = await store.markStalePlacingUnknown(new Date(Date.now() - STALE_PLACING_MS));
  for (const s of stale) {
    await store.casDraft(s.draftId, ["placing_swiggypay", "placing_cod"], { state: "unknown", error: "err_unknown" });
    await store.audit("stale_placing_marked_unknown", { draftId: s.draftId });
    await sendOwner(`⚠️ An order attempt (₹${rupeesText(s.totalPaise)}) never finished — marked UNKNOWN. New orders are blocked until /resolve.`);
  }

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
      if (o.totalPaise === undefined || Math.abs(o.totalPaise - u.totalPaise) > 100) return false;
      if (!o.createdAt) return false;
      const ts = Date.parse(o.createdAt);
      return !Number.isNaN(ts) && ts >= from && ts <= to;
    });
    if (match) {
      await store.updateOrder(u.id, { state: "placed", swiggyOrderIds: [match.orderId], placedAt: new Date() });
      await store.casDraft(u.draftId, ["unknown"], { state: "placed" });
      await store.audit("unknown_reconciled_placed", { draftId: u.draftId, data: { orderId: match.orderId } });
      await sendOwner(`✅ Resolved: the ₹${rupeesText(u.totalPaise)} order DID go through (order ${match.orderId}). New orders are unblocked.`);
    }
  }
}

/**
 * Cart hygiene sweeper: if the draft holding the cart lease is expired/superseded/terminal, the items it
 * put in the owner's shared Swiggy cart are cleared and the lease released. Never touches an active draft.
 */
export async function cleanupAbandonedCart(): Promise<boolean> {
  const store = getStore();
  const lock = await store.lockInfo();
  if (!lock.draftId || lock.holder === "checkout") return false;
  const draft = await store.getDraft(lock.draftId);
  const active: DraftState[] = ["matched", "cart_synced", "awaiting_confirm", "approved", "approved_waiting_login", "placing_swiggypay", "placing_cod"];
  if (draft && active.includes(draft.state)) return false;
  try {
    const provider = await getProvider();
    await provider.clearCart();
  } catch (e) {
    console.error("cleanupAbandonedCart: clearCart failed", String(e));
  }
  await store.releaseLock(lock.draftId);
  await store.audit("abandoned_cart_cleared", { draftId: lock.draftId });
  return true;
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
