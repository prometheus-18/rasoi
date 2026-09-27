// The properties that keep real money safe:
//  1. checkoutOnce is called AT MOST ONCE per order, even on timeout / repeated runCheckout.
//  2. DRY_RUN (default ON) and non-Production env never reach checkoutOnce at all.
//  3. Pre-flight rejects (price drift, wrong address) happen BEFORE any checkout call.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, getStore } from "@/lib/store";
import type { CartView, Draft, RawCheckoutOutcome } from "@/lib/types";

const fake = {
  name: "swiggy" as const,
  checkoutCalls: 0,
  outcome: { kind: "placed", orderIds: ["SW1"], message: "Order placed!" } as RawCheckoutOutcome,
  cart: null as CartView | null,
  orders: [] as { orderId: string; createdAt?: string; totalPaise?: number }[],
  async searchProducts() {
    return [];
  },
  async goToItems() {
    return [];
  },
  async getAddresses() {
    return [{ id: "addr1", pincode: "110001" }];
  },
  async updateCart() {
    return this.cart!;
  },
  async getCart() {
    return this.cart!;
  },
  async clearCart() {},
  async getPaymentOptions() {
    return { swiggyMoney: { available: true }, cod: { available: true } };
  },
  async checkoutOnce(): Promise<RawCheckoutOutcome> {
    this.checkoutCalls++;
    return this.outcome;
  },
  async getOrders() {
    return this.orders;
  },
  async getOrderDetails() {
    return null;
  },
  async trackOrder() {
    return {};
  },
};

vi.mock("@/lib/commerce/provider", () => ({ getProvider: async () => fake }));

import { runCheckout } from "@/lib/orders/checkout";
import { confirmDraft, setFlag } from "@/lib/orders/engine";

function makeCart(toPayPaise: number): CartView {
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

async function makeApprovedDraft(toPayPaise = 40000): Promise<Draft> {
  const store = getStore();
  const device = await store.createDevice({ name: "t", tokenHash: `h${Math.random()}` });
  const draft = await store.createDraft({ deviceId: device.id, state: "recorded" });
  await store.updateDraftFields(draft.id, { cart: makeCart(toPayPaise), totalPaise: toPayPaise, approvedTotalPaise: toPayPaise, paymentMethod: "SWIGGY_MONEY" });
  await store.casDraft(draft.id, ["recorded"], { state: "approved", approvedTotalPaise: toPayPaise });
  return (await store.getDraft(draft.id))!;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).__rasoiStore = new MemoryStore();
  fake.checkoutCalls = 0;
  fake.cart = makeCart(40000);
  fake.orders = [];
  fake.outcome = { kind: "placed", orderIds: ["SW1"], message: "Order placed!" };
  process.env.VERCEL_ENV = "production";
  process.env.ALLOW_REAL_ORDERS = "true";
  process.env.PINNED_ADDRESS_ID = "addr1";
  delete process.env.PINNED_ADDRESS_FINGERPRINT;
});

describe("runCheckout — at most once, ever", () => {
  it("places a real order exactly once and never re-calls on a second run", async () => {
    await setFlag("dryRun", false);
    const draft = await makeApprovedDraft();
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(1);
    const store = getStore();
    expect((await store.getDraft(draft.id))!.state).toBe("placed");
    expect((await store.getOrderByDraft(draft.id))!.state).toBe("placed");

    await runCheckout(draft.id); // draft no longer 'approved' AND idempotency key exists
    expect(fake.checkoutCalls).toBe(1);
  });

  it("a definite failure never triggers a retry", async () => {
    await setFlag("dryRun", false);
    fake.outcome = { kind: "failed_definite", message: "payment declined", code: "PAYMENT_DECLINED" };
    const draft = await makeApprovedDraft();
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(1);
    expect((await getStore().getDraft(draft.id))!.state).toBe("not_placed");
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(1);
  });

  it("a timeout → unknown, blocks new checkouts, reconciles from get_orders — still one call", async () => {
    await setFlag("dryRun", false);
    fake.outcome = { kind: "unknown", message: "504 gateway timeout" };
    const draft = await makeApprovedDraft();
    // reconciliation will find the order in history after the first 3 s wait
    fake.orders = [{ orderId: "SW-REC", createdAt: new Date().toISOString(), totalPaise: 40000 }];
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(1);
    const order = await getStore().getOrderByDraft(draft.id);
    expect(order!.state).toBe("placed"); // reconciled, not re-called
    expect(order!.swiggyOrderIds).toEqual(["SW-REC"]);
    expect((await getStore().getDraft(draft.id))!.state).toBe("placed");
  }, 20_000);

  it("an unresolved unknown order blocks any new confirm", async () => {
    const store = getStore();
    const draft = await makeApprovedDraft();
    await store.insertOrder({ draftId: draft.id, idempotencyKey: "old", state: "unknown", totalPaise: 10000, paymentMethod: "SWIGGY_MONEY" });

    const device = await store.createDevice({ name: "t2", tokenHash: "h2" });
    const d2 = await store.createDraft({ deviceId: device.id, state: "recorded" });
    await store.updateDraftFields(d2.id, { cart: makeCart(5000), totalPaise: 5000 });
    await store.casDraft(d2.id, ["recorded"], { state: "cart_synced" });
    const outcome = await confirmDraft((await store.getDraft(d2.id))!);
    expect(outcome.status).toBe("blocked");
    expect(fake.checkoutCalls).toBe(0);
  });
});

describe("runCheckout — gates", () => {
  it("DRY_RUN (default) never calls checkoutOnce", async () => {
    const draft = await makeApprovedDraft();
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(0);
    expect((await getStore().getOrderByDraft(draft.id))!.state).toBe("placed_dry");
    expect((await getStore().getDraft(draft.id))!.meta?.dry).toBe(true);
  });

  it("preview env stays dry even with ALLOW_REAL_ORDERS=true and dryRun off", async () => {
    process.env.VERCEL_ENV = "preview";
    await setFlag("dryRun", false);
    const draft = await makeApprovedDraft();
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(0);
    expect((await getStore().getOrderByDraft(draft.id))!.state).toBe("placed_dry");
  });

  it("pre-flight rejects price drift above the approved total before any call", async () => {
    await setFlag("dryRun", false);
    const draft = await makeApprovedDraft(40000);
    fake.cart = makeCart(45000); // live cart got pricier
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(0);
    expect((await getStore().getDraft(draft.id))!.state).toBe("not_placed");
  });

  it("pre-flight rejects a wrong cart address before any call", async () => {
    await setFlag("dryRun", false);
    const draft = await makeApprovedDraft();
    fake.cart = { ...makeCart(40000), selectedAddressId: "somewhere-else" };
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(0);
    expect((await getStore().getDraft(draft.id))!.state).toBe("not_placed");
  });

  it("paused blocks even an approved draft", async () => {
    await setFlag("dryRun", false);
    await setFlag("paused", true);
    const draft = await makeApprovedDraft();
    await runCheckout(draft.id);
    expect(fake.checkoutCalls).toBe(0);
    expect((await getStore().getDraft(draft.id))!.state).toBe("approved"); // waits, does not fail
  });
});
