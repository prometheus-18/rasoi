// THE checkout path. This is the ONLY file in the codebase that calls provider.checkoutOnce().
// Invariants (see CLAUDE.md + docs/PLAN.md):
//  - exactly one checkout call per order row (unique idempotency key), NEVER retried
//  - gated by DRY_RUN (DB flag, default ON) and ALLOW_REAL_ORDERS (env, Production only,
//    re-checked inside the Swiggy adapter as well)
//  - pre-flight rebuilds the cart from the approved snapshot and verifies exact items,
//    toPay ≤ approved total, and the pinned address before sending
//  - a timeout/ambiguous result → state "unknown", which blocks all new checkouts until
//    reconciled via get_orders or resolved by the owner

import { getProvider } from "@/lib/commerce/provider";
import { CommerceError } from "@/lib/commerce/swiggy-errors";
import { sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { sendOwner } from "@/lib/notify/telegram";
import { getFlags, getLimits, markOrderedNames, reconcileUnknownOrders, spendContext, trackWaitingDraft } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";
import { rupeesText, type CartLine, type Draft, type DraftState, type PaymentMethod } from "@/lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function failBeforeSend(orderId: string, draftId: string, placingStates: DraftState[], errHi: string, errEn: string, code?: string): Promise<void> {
  const store = getStore();
  await store.updateOrder(orderId, { state: "not_placed", raw: { failEn: errEn, code } });
  await store.casDraft(draftId, ["approved", ...placingStates], { state: "not_placed", error: errHi, meta: { failEn: errEn, failCode: code ?? null } });
  await store.audit("checkout_not_placed", { draftId, data: { errEn, code } });
  await sendOwner(`❌ Order NOT placed (nothing sent to Swiggy): ${errEn}`);
}

/**
 * Run the checkout for an `approved` draft. Safe to call multiple times: the unique
 * idempotency key guarantees at most one attempt ever reaches Swiggy.
 */
export async function runCheckout(draftId: string): Promise<void> {
  const store = getStore();
  const draft = await store.getDraft(draftId);
  if (!draft || draft.state !== "approved") return;
  const method: PaymentMethod = draft.paymentMethod ?? "SWIGGY_MONEY";
  const approvedPaise = draft.approvedTotalPaise ?? draft.totalPaise ?? 0;
  const placingState = method === "COD" ? "placing_cod" : "placing_swiggypay";

  const flags = await getFlags();
  if (flags.paused) {
    await store.updateDraftFields(draftId, { error: "अभी रुका हुआ है — मालिक से पूछें" });
    await sendOwner("An approved order is waiting but ordering is PAUSED. /resume to allow it, then approve again.");
    return;
  }
  if (await store.anyBlockingOrder()) {
    await store.updateDraftFields(draftId, { error: "पिछला ऑर्डर पक्का नहीं हुआ — रुकिए" });
    await sendOwner("An approved order is waiting but a previous order is in an unknown state. Use /resolve first.");
    return;
  }

  // ── At-most-once guard: unique (draftId + cart hash) order row ──────────────
  const order = await store.insertOrder({
    draftId,
    idempotencyKey: `${draftId}:${cartHash(draft)}`,
    state: "placing",
    totalPaise: approvedPaise,
    paymentMethod: method,
  });
  if (!order) return; // an attempt already exists for exactly this cart — never a second one

  const cas = await store.casDraft(draftId, ["approved"], { state: placingState });
  if (!cas) {
    await store.updateOrder(order.id, { state: "not_placed", raw: { failEn: "draft state changed" } });
    return;
  }
  await store.audit("checkout_started", { draftId, deviceId: draft.deviceId, data: { method, approvedPaise, dryRun: flags.dryRun } });

  if (!(await store.acquireLock(draftId, 5 * 60_000))) {
    await failBeforeSend(order.id, draftId, [placingState], "कोई और ऑर्डर चल रहा है — थोड़ी देर में फिर कोशिश करें", "commerce lock busy");
    return;
  }

  try {
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
      await failBeforeSend(order.id, draftId, [placingState], "सेटअप पूरा नहीं है — मालिक को बताएं", "PINNED_ADDRESS_ID not set", "CONFIG");
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
        await failBeforeSend(order.id, draftId, [placingState], "सामान बदल गया — दोबारा लिस्ट बनाएं", "live cart does not exactly match the approved snapshot");
        return;
      }
      if (live.toPayPaise > approvedPaise) {
        await failBeforeSend(order.id, draftId, [placingState], "दाम बदल गया — दोबारा पूछें", `live total ₹${rupeesText(live.toPayPaise)} > approved ₹${rupeesText(approvedPaise)}`);
        return;
      }
      if (live.selectedAddressId !== env.pinnedAddressId) {
        await failBeforeSend(order.id, draftId, [placingState], "पता ठीक नहीं है — मालिक को बताएं", `cart address ${live.selectedAddressId} != pinned`, "CONFIG");
        return;
      }
      if (env.pinnedAddressFingerprint) {
        const fp = JSON.parse(env.pinnedAddressFingerprint) as { pincode?: string; lat?: number; lng?: number };
        const addr = (await provider.getAddresses()).find((a) => a.id === env.pinnedAddressId);
        const round2 = (n?: number) => (n === undefined ? undefined : Math.round(n * 100) / 100);
        const fpOk =
          addr &&
          (!fp.pincode || fp.pincode === addr.pincode) &&
          (fp.lat === undefined || round2(fp.lat) === round2(addr.lat)) &&
          (fp.lng === undefined || round2(fp.lng) === round2(addr.lng));
        if (!fpOk) {
          await failBeforeSend(order.id, draftId, [placingState], "पता ठीक नहीं है — मालिक को बताएं", "pinned address fingerprint mismatch", "CONFIG");
          return;
        }
      }
      const pay = await provider.getPaymentOptions();
      const offered = method === "SWIGGY_MONEY" ? pay.swiggyMoney?.available : pay.cod?.available;
      if (!offered) {
        await failBeforeSend(
          order.id,
          draftId,
          [placingState],
          method === "SWIGGY_MONEY" ? "वॉलेट में पैसे नहीं हैं — मालिक को बताया" : "कैश ऑर्डर अभी नहीं हो सकता",
          `${method} not offered by get_payment_options`,
          "PAYMENT_DECLINED",
        );
        if (method === "SWIGGY_MONEY") await sendOwner("💳 Swiggy Money is not offered for this cart (balance low?). Top up and ask the cook to try again, or /login if the session died.");
        return;
      }
    } catch (e) {
      if (e instanceof CommerceError && e.code === "AUTH") {
        // token died between approval and placement — park the draft, never a dead end
        await store.updateOrder(order.id, { state: "not_placed", raw: { failEn: "auth expired pre-flight" } });
        const parked = await store.casDraft(draftId, [placingState], { state: "approved_waiting_login", error: "मालिक को भेज दिया ✓" });
        if (parked) await trackWaitingDraft(draftId);
        await sendOwner("🔑 Swiggy login expired — an approved order is waiting. Send /login, complete it, and the order resumes automatically.");
        return;
      }
      await failBeforeSend(order.id, draftId, [placingState], "दुकान से जवाब नहीं मिला — थोड़ी देर में फिर कोशिश करें", `pre-flight failed: ${String((e as Error).message)}`);
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
      await store.updateOrder(order.id, { state: "not_placed", raw: { message: outcome.message, code: outcome.code } });
      await store.casDraft(draftId, [placingState], {
        state: "not_placed",
        error: outcome.code === "PAYMENT_DECLINED" ? "पैसे नहीं कट पाए — मालिक को बताया" : "ऑर्डर नहीं हो पाया — थोड़ी देर में फिर कोशिश करें",
        meta: { failCode: outcome.code ?? null, failEn: outcome.message },
      });
      await store.audit("checkout_failed_definite", { draftId, data: { code: outcome.code, message: outcome.message } });
      await sendOwner(`❌ Checkout failed (definite, nothing charged): ${outcome.message}`);
      try {
        await provider.clearCart();
      } catch {}
      return;
    }

    // unknown — BLOCK new checkouts, reconcile, never re-call checkout
    await store.updateOrder(order.id, { state: "unknown", raw: { message: outcome.message } });
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
