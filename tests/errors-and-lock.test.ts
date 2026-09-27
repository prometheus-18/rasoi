// Ambiguity must win in the classifier, and the cart lease must not be reentrant across a checkout.

import { beforeEach, describe, expect, it } from "vitest";
import { classifyFailure } from "@/lib/commerce/swiggy-errors";
import { MemoryStore, getStore } from "@/lib/store";

describe("classifyFailure", () => {
  it("5xx with a payment-ish body is TRANSIENT, never a definite decline", () => {
    expect(classifyFailure(502, "Bad gateway: payment service unavailable")).toBe("TRANSIENT");
    expect(classifyFailure(503, "wallet balance service down")).toBe("TRANSIENT");
  });
  it("timeouts are TRANSIENT regardless of wording", () => {
    expect(classifyFailure(undefined, "Request timed out while checking cart")).toBe("TRANSIENT");
  });
  it("explicit 4xx/auth are definite classes", () => {
    expect(classifyFailure(401, "Unauthorized")).toBe("AUTH");
    expect(classifyFailure(419, "session expired")).toBe("SESSION_419");
    expect(classifyFailure(undefined, "Minimum order value is ₹99")).toBe("MIN_ORDER");
    expect(classifyFailure(undefined, "Payment declined: insufficient balance")).toBe("PAYMENT_DECLINED");
  });
});

describe("commerce lock lease", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__rasoiStore = new MemoryStore();
  });
  it("cart lease is re-entrant for the same draft, exclusive across drafts", async () => {
    const s = getStore();
    expect(await s.acquireLock("A", 60_000, "cart")).toBe(true);
    expect(await s.acquireLock("A", 60_000, "cart")).toBe(true);
    expect(await s.acquireLock("B", 60_000, "cart")).toBe(false);
  });
  it("checkout takes over the draft's cart lease; a cart edit cannot take over a checkout lease", async () => {
    const s = getStore();
    expect(await s.acquireLock("A", 60_000, "cart")).toBe(true);
    expect(await s.acquireLock("A", 60_000, "checkout")).toBe(true);
    expect(await s.lockHeldBy("A", "checkout")).toBe(true);
    expect(await s.acquireLock("A", 60_000, "cart")).toBe(false); // late cart sync is refused
    await s.releaseLock("A");
    expect(await s.acquireLock("B", 60_000, "cart")).toBe(true);
  });
  it("conditional draft field writes refuse when the state moved on", async () => {
    const s = getStore();
    const dev = await s.createDevice({ name: "t", tokenHash: "h" });
    const d = await s.createDraft({ deviceId: dev.id, state: "recorded" });
    await s.casDraft(d.id, ["recorded"], { state: "approved" });
    expect(await s.updateDraftFields(d.id, { totalPaise: 1 }, ["matched", "cart_synced"])).toBeNull();
    expect((await s.getDraft(d.id))!.totalPaise).toBeNull();
  });
});
