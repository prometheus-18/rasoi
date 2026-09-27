// State machine safety: double confirm, stale approval, single-use callback tokens.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, getStore } from "@/lib/store";
import type { CartView } from "@/lib/types";

const fake = {
  name: "swiggy" as const,
  cart: null as CartView | null,
  async getCart() {
    return this.cart!;
  },
  async clearCart() {},
  async getPaymentOptions() {
    return { swiggyMoney: { available: true }, cod: { available: true } };
  },
};
vi.mock("@/lib/commerce/provider", () => ({ getProvider: async () => fake }));

import { approveDraft, confirmDraft, rejectDraft } from "@/lib/orders/engine";
import { consumeCallbackData, makeCallbackData } from "@/lib/notify/telegram";

function cart(toPayPaise: number): CartView {
  return {
    items: [{ spinId: "s1", skuId: "k1", name: "Onion", quantity: 1, unitPaise: toPayPaise, linePaise: toPayPaise }],
    toPayPaise,
    storeCount: 1,
    warnings: [],
    removedOutOfStock: [],
    reducedQuantity: [],
    selectedAddressId: "addr1",
  };
}

async function makeSyncedDraft(toPayPaise = 40000) {
  const store = getStore();
  const device = await store.createDevice({ name: "t", tokenHash: `h${Math.random()}` });
  const draft = await store.createDraft({ deviceId: device.id, state: "recorded" });
  await store.updateDraftFields(draft.id, { cart: cart(toPayPaise), totalPaise: toPayPaise, paymentMethod: "SWIGGY_MONEY" });
  await store.casDraft(draft.id, ["recorded"], { state: "cart_synced" });
  return (await store.getDraft(draft.id))!;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).__rasoiStore = new MemoryStore();
  fake.cart = cart(40000);
  process.env.VERCEL_ENV = "production";
});

describe("confirm / approve state machine", () => {
  it("supervised default: confirm → awaiting_approval", async () => {
    const draft = await makeSyncedDraft();
    const outcome = await confirmDraft(draft);
    expect(outcome.status).toBe("awaiting_approval");
    expect((await getStore().getDraft(draft.id))!.state).toBe("awaiting_approval");
  });

  it("double confirm: the second is rejected by CAS", async () => {
    const draft = await makeSyncedDraft();
    const first = await confirmDraft(draft);
    expect(first.status).toBe("awaiting_approval");
    const second = await confirmDraft(draft); // stale copy, still says cart_synced
    expect(second.status).toBe("invalid");
  });

  it("approve with a stale version is refused", async () => {
    const draft = await makeSyncedDraft();
    await confirmDraft(draft);
    const now = (await getStore().getDraft(draft.id))!;
    expect(await approveDraft(draft.id, now.version - 1)).toBe("stale");
    expect(await approveDraft(draft.id, now.version)).toBe("checkout");
  });

  it("approve after reject is gone", async () => {
    const draft = await makeSyncedDraft();
    await confirmDraft(draft);
    expect(await rejectDraft(draft.id)).toBe(true);
    expect(await approveDraft(draft.id)).toBe("gone");
  });

  it("large cart drift forces a resync instead of confirming", async () => {
    const draft = await makeSyncedDraft(40000);
    fake.cart = cart(46000); // > ₹10 and > 3 %
    const outcome = await confirmDraft(draft);
    expect(outcome.status).toBe("resync");
    expect((await getStore().getDraft(draft.id))!.state).toBe("cart_synced"); // still confirmable
  });
});

describe("telegram callback tokens", () => {
  it("are single-use", async () => {
    const data = await makeCallbackData({ action: "approve", draftId: "d1", version: 2 });
    expect(data.startsWith("cb:")).toBe(true);
    expect(await consumeCallbackData(data)).toMatchObject({ action: "approve", draftId: "d1", version: 2 });
    expect(await consumeCallbackData(data)).toBeNull(); // replayed button does nothing
  });
  it("garbage data is rejected", async () => {
    expect(await consumeCallbackData("approve:d1:2")).toBeNull();
  });
});
