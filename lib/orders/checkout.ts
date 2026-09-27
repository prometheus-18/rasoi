// THE checkout path. This is the ONLY file in the codebase that calls provider.checkoutOnce().
// Invariants (see CLAUDE.md + docs/PLAN.md):
//  - at most one checkout call per approved cart: the order row's unique key is
//    draftId + cartHash + attempt, and `attempt` only advances for failures that provably
//    happened BEFORE anything was sent to Swiggy. An attempt that reached checkoutOnce keeps
//    its key forever, so it can never be repeated.
//  - gated by DRY_RUN (DB flag, default ON) and ALLOW_REAL_ORDERS (env, Production only,
//    re-checked inside the Swiggy adapter as well)
//  - pre-flight holds the EXCLUSIVE checkout lease (cart edits are refused meanwhile), rebuilds
//    the cart from the approved snapshot and verifies exact items, toPay ≤ approved total and
//    the pinned address before sending
//  - a timeout/ambiguous result → state "unknown", which blocks all new checkouts until
//    reconciled via get_orders or resolved by the owner

import { getProvider } from "@/lib/commerce/provider";
import { CommerceError } from "@/lib/commerce/swiggy-errors";
import { sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { getFlags, getLimits, markOrderedNames, notifyApprovalRequest, reconcileUnknownOrders, spendContext, spendGuard } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";
import { rupeesText, type CartLine, type Draft, type DraftState, type PaymentMethod } from "@/lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHECKOUT_LEASE_MS = 5 * 60_000;

function snapshotLines(draft: Draft): CartLine[] {
  return (draft.cart?.items ?? []).map((i) => ({ spinId: i.spinId, skuId: i.skuId, quantity: i.quantity }));
}

function cartHash(draft: Draft): string {
  const lines = snapshotLines(draft)
    .map((l) => `${l.spinId}:${l.quantity}`)
    .sort()
    .join("|");
  return sha256Hex(`${lines}|${draft.approvedTotalPaise ?? 0}`);
}

type Attempt = { orderId: string; draft: Draft; placingState: DraftState };

/**
 * Void an attempt that never reached Swiggy. `mode`:
 *  - "terminal": the cook must redo the list (draft → not_placed)
 *  - "retry":    keep the draft 'approved'; the sweeper / status-page retry runs it again
 *  - "park":     Swiggy login died → 'approved_waiting_login', resumed automatically after /login
 *  - "reask":    spend window changed → back to 'awaiting_approval' with fresh buttons
 * In every mode the attempt counter advances so the next run gets a fresh order key.
 */
async function voidAttempt(a: Attempt, mode: "terminal" | "retry" | "park" | "reask", errHi: string, errEn: string, code?: string): Promise<void> {
  const store = getStore();
  await store.updateOrder(a.orderId, { state: "not_placed", raw: { sentToProvider: false, failEn: errEn, code } });
  const nextAttempt = (Number(a.draft.meta?.checkoutAttempt) || 0) + 1;
  const meta = { ...(a.draft.meta ?? {}), checkoutAttempt: nextAttempt, failEn: errEn, failCode: code ?? null };
  const from: DraftState[] = ["approved", a.placingState];
  const to: DraftState = mode === "terminal" ? "not_placed" : mode === "park" ? "approved_waiting_login" : mode === "reask" ? "awaiting_approval" : "approved";
  await store.casDraft(a.draft.id, from, { state: to, error: errHi, meta });
  await store.audit(`checkout_voided_${mode}`, { draftId: a.draft.id, data: { errEn, code, attempt: nextAttempt } });
}

/**
 * Run the checkout for an `approved` draft. Safe to call repeatedly: the unique order key
 * guarantees at most one attempt ever reaches Swiggy for a given approved cart.
 */
export async function runCheckout(draftId: string): Promise<void> {
  const store = getStore();
  const draft = await store.getDraft(draftId);
  if (!draft || draft.state !== "approved") return;
  const method: PaymentMethod = draft.paymentMethod ?? "SWIGGY_MONEY";
  const approvedPaise = draft.approvedTotalPaise ?? draft.totalPaise ?? 0;
  const placingState: DraftState = method === "COD" ? "placing_cod" : "placing_swiggypay";

  const flags = await getFlags();
  if (flags.paused) {
    // stays 'approved'; retryApprovedDrafts runs it after /resume (or it expires after 2 h)
    await store.updateDraftFields(draftId, { error: "अभी रुका हुआ है — मालिक से पूछें" }, ["approved"]);
    await sendOwner("An approved order is waiting but ordering is PAUSED. /resume places it.");
    return;
  }
  if (await store.anyBlockingOrder()) {
    await store.updateDraftFields(draftId, { error: "पिछला ऑर्डर पक्का नहीं हुआ — रुकिए" }, ["approved"]);
    await sendOwner("An approved order is waiting behind an UNKNOWN order. /resolve first; it then places automatically.");
    return;
  }

  // ── At-most-once guard: unique (draftId + cart hash + attempt) order row ─────
  const attempt = Number(draft.meta?.checkoutAttempt) || 0;
  const order = await store.insertOrder({
    draftId,
    idempotencyKey: `${draftId}:${cartHash(draft)}:${attempt}`,
    state: "placing",
    totalPaise: approvedPaise,
    paymentMethod: method,
  });
  if (!order) return; // this exact attempt already exists (raced or already sent) — never a second one
  const a: Attempt = { orderId: order.id, draft, placingState };

  const cas = await store.casDraft(draftId, ["approved"], { state: placingState });
  if (!cas) {
    await store.updateOrder(order.id, { state: "not_placed", raw: { sentToProvider: false, failEn: "draft state changed" } });
    return;
  }
  await store.audit("checkout_started", { draftId, deviceId: draft.deviceId, data: { method, approvedPaise, attempt, dryRun: flags.dryRun } });

  // Exclusive lease: takes over this draft's cart lease; cart edits are refused from here on.
  if (!(await store.acquireLock(draftId, CHECKOUT_LEASE_MS, "checkout"))) {
    await voidAttempt(a, "retry", "कोई और ऑर्डर चल रहा है — थोड़ी देर में अपने आप हो जाएगा", "commerce lock busy — will retry");
    return;
  }

  try {
    // Spend windows may have moved since approval (a parallel order) — never exceed silently.
    const overWindow = await spendGuard(draft, approvedPaise, method === "COD");
    if (overWindow.length) {
      await voidAttempt(a, "reask", "आज की सीमा पूरी — मालिक से फिर पूछ रहे हैं", `spend window exceeded: ${overWindow.map((r) => r.code).join(",")}`);
      const fresh = await store.getDraft(draftId);
      if (fresh) await notifyApprovalRequest(fresh, overWindow);
      return;
    }

    const provider = await getProvider();

    // ── DRY RUN: full flow, no checkout call, clearly marked ──────────────────
    if (flags.dryRun || !env.allowRealOrders || provider.name !== "swiggy") {
      await store.updateOrder(order.id, { state: "placed_dry", placedAt: new Date(), swiggyOrderIds: ["DRY-RUN"] });
      await store.casDraft(draftId, [placingState], { state: "placed", meta: { ...(draft.meta ?? {}), dry: true } });
      try {
        await provider.clearCart();
      } catch {}
      await store.audit("checkout_dry_run", { draftId, data: { approvedPaise, method } });
      await sendOwner(`🧪 DRY RUN — order of ₹${rupeesText(approvedPaise)} (${method}) would have been placed. Nothing was sent to Swiggy.`);
      return;
    }

    // ── Real order pre-flight ─────────────────────────────────────────────────
    if (!env.pinnedAddressId) {
      await voidAttempt(a, "terminal", "सेटअप पूरा नहीं है — मालिक को बताएं", "PINNED_ADDRESS_ID not set", "CONFIG");
      await sendOwner("❌ Cannot place orders: PINNED_ADDRESS_ID is not set.");
      return;
    }

    let liveToPay = 0;
    try {
      await provider.updateCart(snapshotLines(draft)); // rebuild from the approved snapshot
      const live = await provider.getCart();
      liveToPay = live.toPayPaise;

      const want = new Map(snapshotLines(draft).map((l) => [l.spinId, l.quantity]));
      const exactMatch = live.items.length === want.size && live.items.every((i) => want.get(i.spinId) === i.quantity);
      if (!exactMatch) {
        await voidAttempt(a, "terminal", "सामान बदल गया — दोबारा लिस्ट बनाएं", "live cart does not exactly match the approved snapshot");
        await sendOwner("❌ Order NOT placed: the live cart did not match the approved list (stock changed?). Cook was told to redo.");
        return;
      }
      if (live.toPayPaise <= 0) {
        // fail CLOSED: an unparsed bill would otherwise pass the ceiling check vacuously
        await voidAttempt(a, "terminal", "दाम नहीं मिला — मालिक को बताएं", "live cart total unreadable (0)", "CONFIG");
        await sendOwner("❌ Order NOT placed: could not read the cart total from Swiggy (payload shape?). Check the adapter mapping.");
        return;
      }
      if (live.toPayPaise > approvedPaise) {
        await voidAttempt(a, "terminal", "दाम बदल गया — दोबारा पूछें", `live total ₹${rupeesText(live.toPayPaise)} > approved ₹${rupeesText(approvedPaise)}`);
        await sendOwner(`❌ Order NOT placed: total rose to ₹${rupeesText(live.toPayPaise)} (approved ₹${rupeesText(approvedPaise)}). Cook must confirm again.`);
        return;
      }
      if (live.selectedAddressId !== env.pinnedAddressId) {
        await voidAttempt(a, "terminal", "पता ठीक नहीं है — मालिक को बताएं", `cart address ${live.selectedAddressId} != pinned`, "CONFIG");
        await sendOwner("🚨 Order NOT placed: the cart's delivery address is not the pinned home address.");
        return;
      }
      if (env.pinnedAddressFingerprint) {
        const fp = JSON.parse(env.pinnedAddressFingerprint) as { pincode?: string; lat?: number; lng?: number };
        const addr = (await provider.getAddresses()).find((x) => x.id === env.pinnedAddressId);
        const round2 = (n?: number) => (n === undefined ? undefined : Math.round(n * 100) / 100);
        const fpOk =
          addr &&
          (!fp.pincode || fp.pincode === addr.pincode) &&
          (fp.lat === undefined || round2(fp.lat) === round2(addr.lat)) &&
          (fp.lng === undefined || round2(fp.lng) === round2(addr.lng));
        if (!fpOk) {
          await voidAttempt(a, "terminal", "पता ठीक नहीं है — मालिक को बताएं", "pinned address fingerprint mismatch", "CONFIG");
          await sendOwner("🚨 Order NOT placed: the pinned address no longer matches its fingerprint. Someone edited the address?");
          return;
        }
      }
      const pay = await provider.getPaymentOptions();
      const offered = method === "SWIGGY_MONEY" ? pay.swiggyMoney?.available : pay.cod?.available;
      if (!offered) {
        await voidAttempt(
          a,
          "terminal",
          method === "SWIGGY_MONEY" ? "वॉलेट में पैसे नहीं हैं — मालिक को बताया" : "कैश ऑर्डर अभी नहीं हो सकता",
          `${method} not offered by get_payment_options`,
          "PAYMENT_DECLINED",
        );
        await sendOwner(
          method === "SWIGGY_MONEY"
            ? "💳 Order NOT placed: Swiggy Money is not offered for this cart (balance low?). Top up and ask the cook to try again."
            : "❌ Order NOT placed: cash on delivery is not offered for this cart.",
        );
        return;
      }
      // the cart edits lease must still be ours right before the irreversible call
      if (!(await store.lockHeldBy(draftId, "checkout"))) {
        await voidAttempt(a, "retry", "थोड़ी देर में अपने आप हो जाएगा", "checkout lease lost during pre-flight");
        return;
      }
    } catch (e) {
      if (e instanceof CommerceError && e.code === "AUTH") {
        // token died between approval and placement — park, resumed automatically after /login
        await voidAttempt(a, "park", "मालिक को भेज दिया ✓ — थोड़ा इंतज़ार", "Swiggy login expired during pre-flight", "AUTH");
        await sendOwner("🔑 Swiggy login expired — an approved order is waiting. Send /login; it resumes automatically after you paste the code.");
        return;
      }
      await voidAttempt(a, "terminal", "दुकान से जवाब नहीं मिला — थोड़ी देर में फिर कोशिश करें", `pre-flight failed: ${String((e as Error).message)}`);
      await sendOwner(`❌ Order NOT placed (nothing sent): pre-flight failed — ${String((e as Error).message).slice(0, 200)}`);
      return;
    }

    // ── THE checkout call — exactly once, never retried ───────────────────────
    const outcome = await provider.checkoutOnce({ addressId: env.pinnedAddressId, paymentMethod: method });

    if (outcome.kind === "placed") {
      await store.updateOrder(order.id, { state: "placed", swiggyOrderIds: outcome.orderIds, placedAt: new Date(), raw: { message: outcome.message } });
      await store.casDraft(draftId, [placingState], {
        state: "placed",
        meta: { ...(draft.meta ?? {}), swiggyMessage: outcome.message ?? null, orderIds: outcome.orderIds },
      });
      await markOrderedNames((draft.cart?.items ?? []).map((i) => i.name));
      await store.audit("checkout_placed", { draftId, data: { orderIds: outcome.orderIds, toPay: liveToPay } });

      const [limits, spend] = await Promise.all([getLimits(), spendContext(new Date())]);
      const left = Math.max(0, limits.perDayPaise - spend.spentDayPaise);
      const itemsTxt = (draft.cart?.items ?? []).map((i) => `• ${i.name} ×${i.quantity}`).join("\n");
      await sendOwner(
        `✅ Order placed — ₹${rupeesText(approvedPaise)} (${method === "COD" ? "Cash on delivery" : "Swiggy Money"})\n${itemsTxt}\nBudget left today: ₹${rupeesText(left)}\nSwiggy: ${outcome.message ?? "-"}`,
      );

      // best-effort snapshot verification (red alert on mismatch)
      try {
        if (outcome.orderIds[0]) {
          const details = (await provider.getOrderDetails(outcome.orderIds[0])) as { items?: unknown[] } | null;
          const gotCount = Array.isArray(details?.items) ? details.items.length : undefined;
          const wantCount = draft.cart?.items.length ?? 0;
          if (gotCount !== undefined && gotCount !== wantCount)
            await sendOwner(`🚨 MISMATCH: Swiggy order ${outcome.orderIds[0]} has ${gotCount} items but ${wantCount} were approved. Check the Swiggy app.`);
        }
      } catch {}
      return;
    }

    if (outcome.kind === "failed_definite") {
      // Sent (or rejected before processing) and provably not placed. The key stays consumed:
      // a definite decline is not silently retried — the cook redoes the list.
      await store.updateOrder(order.id, { state: "not_placed", raw: { sentToProvider: true, message: outcome.message, code: outcome.code } });
      await store.casDraft(draftId, [placingState], {
        state: "not_placed",
        error: outcome.code === "PAYMENT_DECLINED" ? "पैसे नहीं कट पाए — मालिक को बताया" : "ऑर्डर नहीं हो पाया — थोड़ी देर में फिर कोशिश करें",
        meta: { ...(draft.meta ?? {}), failCode: outcome.code ?? null, failEn: outcome.message },
      });
      await store.audit("checkout_failed_definite", { draftId, data: { code: outcome.code, message: outcome.message } });
      await sendOwner(`❌ Checkout failed (definite, nothing charged): ${outcome.message}`);
      try {
        await provider.clearCart();
      } catch {}
      return;
    }

    // unknown — BLOCK new checkouts, reconcile, never re-call checkout
    await store.updateOrder(order.id, { state: "unknown", raw: { sentToProvider: true, message: outcome.message } });
    await store.casDraft(draftId, [placingState], { state: "unknown", error: "ऑर्डर शायद हो गया — दोबारा मत करना" });
    await store.audit("checkout_unknown", { draftId, data: { message: outcome.message } });
    await sendOwner(`⚠️ Checkout result UNKNOWN (₹${rupeesText(approvedPaise)}): ${outcome.message}\nNew orders are blocked. Reconciling against order history…`);
    for (const wait of [3000, 10_000, 30_000, 120_000]) {
      await sleep(wait);
      await reconcileUnknownOrders();
      const now = await store.getOrderByDraft(draftId);
      if (now?.state !== "unknown") return;
    }
    await sendOwner("⚠️ Still unknown after reconciliation. Check the Swiggy app, then send /resolve.");
  } finally {
    await store.releaseLock(draftId);
  }
}
