// Storage layer. Two implementations behind one interface:
//  - DrizzleStore → Neon Postgres (production). neon-http has NO transactions, so every
//    state transition is a single conditional UPDATE ... RETURNING (CAS) or a unique-key insert.
//  - MemoryStore → used when DATABASE_URL is missing (demo mode / unit tests). Single-threaded,
//    so the same CAS semantics hold trivially. Nothing real can happen in demo mode.

import { and, count, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { env } from "@/lib/env";
import { sha256Hex } from "@/lib/crypto";
import type { Device, Draft, DraftState, MatchedItem, OrderRow, OrderState, PaymentMethod, CartView, VoiceItem } from "@/lib/types";

export type SwiggyAuthRow = {
  accessTokenEnc: string;
  clientId: string;
  expiresAt: Date;
  sessionId: string | null;
  createdAt: Date;
};

export type DraftPatch = {
  state: DraftState;
  version: number;
  transcript: string | null;
  items: VoiceItem[] | null;
  matched: MatchedItem[] | null;
  cart: CartView | null;
  totalPaise: number | null;
  paymentMethod: PaymentMethod | null;
  approvedTotalPaise: number | null;
  error: string | null;
  meta: Record<string, unknown> | null;
};

export type OrderPatch = {
  state: OrderState;
  swiggyOrderIds: string[] | null;
  raw: unknown;
  placedAt: Date | null;
};

export interface Store {
  readonly demo: boolean;

  // KV (settings table). Values may carry a TTL; expired reads return null.
  getKV<T>(key: string): Promise<T | null>;
  setKV(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Atomic read-and-delete — single-use tokens (pairing codes, owner links, telegram callbacks). */
  takeKV<T>(key: string): Promise<T | null>;
  deleteKV(key: string): Promise<void>;

  getSwiggyAuth(): Promise<SwiggyAuthRow | null>;
  setSwiggyAuth(row: { accessTokenEnc: string; clientId: string; expiresAt: Date }): Promise<void>;
  clearSwiggyAuth(): Promise<void>;
  setSwiggySessionId(sessionId: string | null): Promise<void>;

  createDevice(d: { name: string; tokenHash: string; pinHash?: string; pinSalt?: string }): Promise<Device>;
  getDeviceByTokenHash(hash: string): Promise<Device | null>;
  getDevice(id: string): Promise<Device | null>;
  touchDevice(id: string): Promise<void>;
  listDevices(): Promise<Device[]>;
  revokeDevice(id: string): Promise<void>;
  /** Atomic fail counter: ok resets, failure increments; locks at 5. Returns the new state. */
  pinAttempt(id: string, ok: boolean): Promise<{ fails: number; locked: boolean }>;
  unlockDevice(id: string): Promise<void>;

  createDraft(d: { deviceId: string; state: DraftState; transcript?: string; items?: VoiceItem[] }): Promise<Draft>;
  getDraft(id: string): Promise<Draft | null>;
  /**
   * Non-state field updates (matched/error/meta). Never changes `state`.
   * `ifState` makes the write conditional so a late request cannot clobber an approved snapshot.
   */
  updateDraftFields(id: string, patch: Partial<Omit<DraftPatch, "state">>, ifState?: DraftState[]): Promise<Draft | null>;
  /** The ONLY way to change draft state: single conditional UPDATE ... RETURNING. */
  casDraft(id: string, from: DraftState[], patch: Partial<DraftPatch> & { state: DraftState }): Promise<Draft | null>;
  listDraftsByState(states: DraftState[], limit?: number): Promise<Draft[]>;
  supersedeActiveDrafts(deviceId: string, exceptId: string): Promise<void>;
  countDraftsSince(deviceId: string, since: Date): Promise<number>;
  expireStaleDrafts(olderThan: Date): Promise<number>;

  /** Returns null when the idempotency key already exists (someone else is/was placing). */
  insertOrder(o: { draftId: string; idempotencyKey: string; state: OrderState; totalPaise: number; paymentMethod: PaymentMethod }): Promise<OrderRow | null>;
  updateOrder(id: string, patch: Partial<OrderPatch>): Promise<void>;
  getOrderByDraft(draftId: string): Promise<OrderRow | null>;
  recentOrders(limit: number): Promise<OrderRow[]>;
  /** Conservative spend since a moment: placed + partially_placed + placing + unknown all count. */
  spendSince(since: Date): Promise<{ totalPaise: number; count: number; codCount: number }>;
  anyBlockingOrder(): Promise<boolean>;
  unknownOrders(): Promise<OrderRow[]>;
  /** A 'placing' row older than `olderThan` means the function died mid-checkout → treat as unknown. */
  markStalePlacingUnknown(olderThan: Date): Promise<OrderRow[]>;

  /**
   * Global cart lease. holder 'cart' = list editing (re-entrant for the same draft);
   * holder 'checkout' = exclusive: it may take over the draft's cart lease, but a cart edit
   * can never take over a checkout lease.
   */
  acquireLock(draftId: string, ttlMs: number, holder: LockHolder): Promise<boolean>;
  lockHeldBy(draftId: string, holder: LockHolder): Promise<boolean>;
  releaseLock(draftId: string): Promise<void>;

  /** true = first time seeing this update_id (process it); false = duplicate (skip). */
  markUpdateProcessed(updateId: number): Promise<boolean>;

  audit(kind: string, info?: { draftId?: string; deviceId?: string; data?: unknown }): Promise<void>;
  countAudit(kind: string, deviceId: string, since: Date): Promise<number>;

  getPantry(spoken: string): Promise<unknown | null>;
  setPantry(spoken: string, data: unknown): Promise<void>;
}

type KVEnvelope = { v: unknown; exp?: number };

export type LockHolder = "cart" | "checkout";

// ─────────────────────────────────────────────────────────────────────────────
// Drizzle / Neon implementation
// ─────────────────────────────────────────────────────────────────────────────

function rowToDraft(r: typeof t.drafts.$inferSelect): Draft {
  return {
    id: r.id,
    deviceId: r.deviceId,
    state: r.state as DraftState,
    version: r.version,
    transcript: r.transcript,
    items: (r.items as VoiceItem[] | null) ?? null,
    matched: (r.matched as MatchedItem[] | null) ?? null,
    cart: (r.cart as CartView | null) ?? null,
    totalPaise: r.totalPaise,
    paymentMethod: (r.paymentMethod as PaymentMethod | null) ?? null,
    approvedTotalPaise: r.approvedTotalPaise,
    error: r.error,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToOrder(r: typeof t.orders.$inferSelect): OrderRow {
  return {
    id: r.id,
    draftId: r.draftId,
    idempotencyKey: r.idempotencyKey,
    state: r.state as OrderState,
    totalPaise: r.totalPaise,
    paymentMethod: r.paymentMethod as PaymentMethod,
    swiggyOrderIds: (r.swiggyOrderIds as string[] | null) ?? null,
    raw: r.raw,
    placedAt: r.placedAt,
    createdAt: r.createdAt,
  };
}

const ACTIVE_PRECONFIRM: DraftState[] = ["recorded", "parsed", "matched", "cart_synced", "awaiting_confirm"];
/** States a stale draft may be expired from. An old 'approved' draft must never auto-fire hours later. */
const EXPIRABLE: DraftState[] = [...ACTIVE_PRECONFIRM, "awaiting_approval", "approved", "approved_waiting_login"];
const BLOCKING_ORDER_STATES: OrderState[] = ["placing", "unknown"];
const SPEND_ORDER_STATES: OrderState[] = ["placing", "placed", "partially_placed", "unknown"];

class DrizzleStore implements Store {
  readonly demo = false;
  private seeded = false;

  private async seed() {
    if (this.seeded) return;
    await db().insert(t.commerceLock).values({ id: 1 }).onConflictDoNothing();
    this.seeded = true;
  }

  async getKV<T>(key: string): Promise<T | null> {
    const rows = await db().select().from(t.settings).where(eq(t.settings.key, key)).limit(1);
    if (!rows[0]) return null;
    const envl = rows[0].value as KVEnvelope;
    if (envl.exp && envl.exp < Date.now()) return null;
    return envl.v as T;
  }

  async setKV(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const envl: KVEnvelope = { v: value, ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) };
    await db()
      .insert(t.settings)
      .values({ key, value: envl })
      .onConflictDoUpdate({ target: t.settings.key, set: { value: envl, updatedAt: new Date() } });
  }

  async takeKV<T>(key: string): Promise<T | null> {
    const rows = await db().delete(t.settings).where(eq(t.settings.key, key)).returning();
    if (!rows[0]) return null;
    const envl = rows[0].value as KVEnvelope;
    if (envl.exp && envl.exp < Date.now()) return null;
    return envl.v as T;
  }

  async deleteKV(key: string): Promise<void> {
    await db().delete(t.settings).where(eq(t.settings.key, key));
  }

  async getSwiggyAuth(): Promise<SwiggyAuthRow | null> {
    const rows = await db().select().from(t.swiggyAuth).where(eq(t.swiggyAuth.id, 1)).limit(1);
    const r = rows[0];
    return r ? { accessTokenEnc: r.accessTokenEnc, clientId: r.clientId, expiresAt: r.expiresAt, sessionId: r.sessionId, createdAt: r.createdAt } : null;
  }

  async setSwiggyAuth(row: { accessTokenEnc: string; clientId: string; expiresAt: Date }): Promise<void> {
    await db()
      .insert(t.swiggyAuth)
      .values({ id: 1, ...row, sessionId: null, createdAt: new Date() })
      .onConflictDoUpdate({ target: t.swiggyAuth.id, set: { ...row, sessionId: null, createdAt: new Date() } });
  }

  async clearSwiggyAuth(): Promise<void> {
    await db().delete(t.swiggyAuth).where(eq(t.swiggyAuth.id, 1));
  }

  async setSwiggySessionId(sessionId: string | null): Promise<void> {
    await db().update(t.swiggyAuth).set({ sessionId }).where(eq(t.swiggyAuth.id, 1));
  }

  async createDevice(d: { name: string; tokenHash: string; pinHash?: string; pinSalt?: string }): Promise<Device> {
    const rows = await db().insert(t.devices).values(d).returning();
    return rows[0] as Device;
  }

  async getDeviceByTokenHash(hash: string): Promise<Device | null> {
    const rows = await db()
      .select()
      .from(t.devices)
      .where(and(eq(t.devices.tokenHash, hash), eq(t.devices.revoked, false)))
      .limit(1);
    return (rows[0] as Device) ?? null;
  }

  async getDevice(id: string): Promise<Device | null> {
    const rows = await db().select().from(t.devices).where(eq(t.devices.id, id)).limit(1);
    return (rows[0] as Device) ?? null;
  }

  async touchDevice(id: string): Promise<void> {
    await db().update(t.devices).set({ lastSeen: new Date() }).where(eq(t.devices.id, id));
  }

  async listDevices(): Promise<Device[]> {
    return (await db().select().from(t.devices).orderBy(desc(t.devices.createdAt))) as Device[];
  }

  async revokeDevice(id: string): Promise<void> {
    await db().update(t.devices).set({ revoked: true }).where(eq(t.devices.id, id));
  }

  async pinAttempt(id: string, ok: boolean): Promise<{ fails: number; locked: boolean }> {
    const rows = ok
      ? await db().update(t.devices).set({ pinFails: 0 }).where(eq(t.devices.id, id)).returning()
      : await db()
          .update(t.devices)
          .set({ pinFails: sql`${t.devices.pinFails} + 1`, locked: sql`${t.devices.pinFails} + 1 >= 5` })
          .where(eq(t.devices.id, id))
          .returning();
    const r = rows[0];
    return { fails: r?.pinFails ?? 0, locked: r?.locked ?? false };
  }

  async unlockDevice(id: string): Promise<void> {
    await db().update(t.devices).set({ locked: false, pinFails: 0 }).where(eq(t.devices.id, id));
  }

  async createDraft(d: { deviceId: string; state: DraftState; transcript?: string; items?: VoiceItem[] }): Promise<Draft> {
    const rows = await db()
      .insert(t.drafts)
      .values({ deviceId: d.deviceId, state: d.state, transcript: d.transcript, items: d.items })
      .returning();
    return rowToDraft(rows[0]);
  }

  async getDraft(id: string): Promise<Draft | null> {
    const rows = await db().select().from(t.drafts).where(eq(t.drafts.id, id)).limit(1);
    return rows[0] ? rowToDraft(rows[0]) : null;
  }

  async updateDraftFields(id: string, patch: Partial<Omit<DraftPatch, "state">>, ifState?: DraftState[]): Promise<Draft | null> {
    const rows = await db()
      .update(t.drafts)
      .set({ ...patch, updatedAt: new Date() })
      .where(ifState ? and(eq(t.drafts.id, id), inArray(t.drafts.state, ifState)) : eq(t.drafts.id, id))
      .returning();
    return rows[0] ? rowToDraft(rows[0]) : null;
  }

  async listDraftsByState(states: DraftState[], limit = 50): Promise<Draft[]> {
    const rows = await db().select().from(t.drafts).where(inArray(t.drafts.state, states)).orderBy(desc(t.drafts.updatedAt)).limit(limit);
    return rows.map(rowToDraft);
  }

  async casDraft(id: string, from: DraftState[], patch: Partial<DraftPatch> & { state: DraftState }): Promise<Draft | null> {
    const rows = await db()
      .update(t.drafts)
      .set({ ...patch, version: sql`${t.drafts.version} + 1`, updatedAt: new Date() })
      .where(and(eq(t.drafts.id, id), inArray(t.drafts.state, from)))
      .returning();
    return rows[0] ? rowToDraft(rows[0]) : null;
  }

  async supersedeActiveDrafts(deviceId: string, exceptId: string): Promise<void> {
    await db()
      .update(t.drafts)
      .set({ state: "superseded", updatedAt: new Date() })
      .where(and(eq(t.drafts.deviceId, deviceId), inArray(t.drafts.state, ACTIVE_PRECONFIRM), ne(t.drafts.id, exceptId)));
  }

  async countDraftsSince(deviceId: string, since: Date): Promise<number> {
    const rows = await db()
      .select({ c: count() })
      .from(t.drafts)
      .where(and(eq(t.drafts.deviceId, deviceId), sql`${t.drafts.createdAt} >= ${since}`));
    return rows[0]?.c ?? 0;
  }

  async expireStaleDrafts(olderThan: Date): Promise<number> {
    const rows = await db()
      .update(t.drafts)
      .set({ state: "expired", updatedAt: new Date() })
      .where(and(inArray(t.drafts.state, EXPIRABLE), lt(t.drafts.updatedAt, olderThan)))
      .returning({ id: t.drafts.id });
    return rows.length;
  }

  async insertOrder(o: { draftId: string; idempotencyKey: string; state: OrderState; totalPaise: number; paymentMethod: PaymentMethod }): Promise<OrderRow | null> {
    const rows = await db().insert(t.orders).values(o).onConflictDoNothing({ target: t.orders.idempotencyKey }).returning();
    return rows[0] ? rowToOrder(rows[0]) : null;
  }

  async updateOrder(id: string, patch: Partial<OrderPatch>): Promise<void> {
    await db()
      .update(t.orders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(t.orders.id, id));
  }

  async getOrderByDraft(draftId: string): Promise<OrderRow | null> {
    const rows = await db().select().from(t.orders).where(eq(t.orders.draftId, draftId)).orderBy(desc(t.orders.createdAt)).limit(1);
    return rows[0] ? rowToOrder(rows[0]) : null;
  }

  async recentOrders(limit: number): Promise<OrderRow[]> {
    const rows = await db().select().from(t.orders).orderBy(desc(t.orders.createdAt)).limit(limit);
    return rows.map(rowToOrder);
  }

  async spendSince(since: Date): Promise<{ totalPaise: number; count: number; codCount: number }> {
    const rows = await db()
      .select({
        total: sql<string>`coalesce(sum(${t.orders.totalPaise}), 0)`,
        c: count(),
        cod: sql<string>`coalesce(sum(case when ${t.orders.paymentMethod} = 'COD' then 1 else 0 end), 0)`,
      })
      .from(t.orders)
      .where(and(inArray(t.orders.state, SPEND_ORDER_STATES), sql`${t.orders.createdAt} >= ${since}`));
    const r = rows[0];
    return { totalPaise: Number(r?.total ?? 0), count: r?.c ?? 0, codCount: Number(r?.cod ?? 0) };
  }

  async anyBlockingOrder(): Promise<boolean> {
    const rows = await db().select({ id: t.orders.id }).from(t.orders).where(inArray(t.orders.state, BLOCKING_ORDER_STATES)).limit(1);
    return rows.length > 0;
  }

  async unknownOrders(): Promise<OrderRow[]> {
    const rows = await db().select().from(t.orders).where(eq(t.orders.state, "unknown"));
    return rows.map(rowToOrder);
  }

  async markStalePlacingUnknown(olderThan: Date): Promise<OrderRow[]> {
    const rows = await db()
      .update(t.orders)
      .set({ state: "unknown", updatedAt: new Date(), raw: { stalePlacing: true } })
      .where(and(eq(t.orders.state, "placing"), lt(t.orders.createdAt, olderThan)))
      .returning();
    return rows.map(rowToOrder);
  }

  async acquireLock(draftId: string, ttlMs: number, holder: LockHolder): Promise<boolean> {
    await this.seed();
    const cutoff = new Date(Date.now() - ttlMs);
    // free / expired → anyone; same draft → same holder may re-enter, and 'checkout' may take over 'cart'
    const sameDraftOk =
      holder === "checkout"
        ? sql`${t.commerceLock.draftId} = ${draftId}`
        : sql`(${t.commerceLock.draftId} = ${draftId} AND ${t.commerceLock.holder} IS DISTINCT FROM 'checkout')`;
    const rows = await db()
      .update(t.commerceLock)
      .set({ draftId, holder, acquiredAt: new Date() })
      .where(
        and(
          eq(t.commerceLock.id, 1),
          sql`(${t.commerceLock.draftId} IS NULL OR ${t.commerceLock.acquiredAt} < ${cutoff} OR ${sameDraftOk})`,
        ),
      )
      .returning();
    return rows.length > 0;
  }

  async lockHeldBy(draftId: string, holder: LockHolder): Promise<boolean> {
    const rows = await db()
      .select({ id: t.commerceLock.id })
      .from(t.commerceLock)
      .where(and(eq(t.commerceLock.id, 1), eq(t.commerceLock.draftId, draftId), eq(t.commerceLock.holder, holder)))
      .limit(1);
    return rows.length > 0;
  }

  async releaseLock(draftId: string): Promise<void> {
    await db()
      .update(t.commerceLock)
      .set({ draftId: null, holder: null, acquiredAt: null })
      .where(and(eq(t.commerceLock.id, 1), eq(t.commerceLock.draftId, draftId)));
  }

  async markUpdateProcessed(updateId: number): Promise<boolean> {
    const rows = await db().insert(t.processedUpdates).values({ updateId }).onConflictDoNothing().returning();
    return rows.length > 0;
  }

  async audit(kind: string, info?: { draftId?: string; deviceId?: string; data?: unknown }): Promise<void> {
    try {
      const last = await db().select({ hash: t.auditLog.hash }).from(t.auditLog).orderBy(desc(t.auditLog.id)).limit(1);
      const prevHash = last[0]?.hash ?? "genesis";
      const hash = sha256Hex(`${prevHash}|${kind}|${info?.draftId ?? ""}|${JSON.stringify(info?.data ?? null)}`);
      await db().insert(t.auditLog).values({ kind, draftId: info?.draftId, deviceId: info?.deviceId, data: info?.data, prevHash, hash });
    } catch (e) {
      console.error("audit write failed", kind, e);
    }
  }

  async countAudit(kind: string, deviceId: string, since: Date): Promise<number> {
    const rows = await db()
      .select({ c: count() })
      .from(t.auditLog)
      .where(and(eq(t.auditLog.kind, kind), eq(t.auditLog.deviceId, deviceId), sql`${t.auditLog.at} >= ${since}`));
    return rows[0]?.c ?? 0;
  }

  async getPantry(spoken: string): Promise<unknown | null> {
    const rows = await db().select().from(t.pantryMap).where(eq(t.pantryMap.spoken, spoken)).limit(1);
    return rows[0]?.data ?? null;
  }

  async setPantry(spoken: string, data: unknown): Promise<void> {
    await db()
      .insert(t.pantryMap)
      .values({ spoken, data })
      .onConflictDoUpdate({ target: t.pantryMap.spoken, set: { data, updatedAt: new Date() } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation (demo mode + unit tests)
// ─────────────────────────────────────────────────────────────────────────────

type MemState = {
  kv: Map<string, KVEnvelope>;
  swiggyAuth: SwiggyAuthRow | null;
  devices: Map<string, Device>;
  drafts: Map<string, Draft>;
  orders: Map<string, OrderRow>;
  orderKeys: Set<string>;
  lock: { draftId: string | null; holder: LockHolder | null; acquiredAt: number | null };
  processed: Set<number>;
  audits: { kind: string; deviceId?: string; draftId?: string; at: number; data?: unknown }[];
  pantry: Map<string, unknown>;
  seq: number;
};

export class MemoryStore implements Store {
  readonly demo = true;
  private s: MemState;

  constructor() {
    this.s = {
      kv: new Map(),
      swiggyAuth: null,
      devices: new Map(),
      drafts: new Map(),
      orders: new Map(),
      orderKeys: new Set(),
      lock: { draftId: null, holder: null, acquiredAt: null },
      processed: new Set(),
      audits: [],
      pantry: new Map(),
      seq: 0,
    };
  }

  private uuid(): string {
    return globalThis.crypto.randomUUID();
  }

  async getKV<T>(key: string): Promise<T | null> {
    const e = this.s.kv.get(key);
    if (!e || (e.exp && e.exp < Date.now())) return null;
    return e.v as T;
  }
  async setKV(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.s.kv.set(key, { v: value, ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) });
  }
  async takeKV<T>(key: string): Promise<T | null> {
    const e = this.s.kv.get(key);
    this.s.kv.delete(key);
    if (!e || (e.exp && e.exp < Date.now())) return null;
    return e.v as T;
  }
  async deleteKV(key: string): Promise<void> {
    this.s.kv.delete(key);
  }

  async getSwiggyAuth() {
    return this.s.swiggyAuth;
  }
  async setSwiggyAuth(row: { accessTokenEnc: string; clientId: string; expiresAt: Date }) {
    this.s.swiggyAuth = { ...row, sessionId: null, createdAt: new Date() };
  }
  async clearSwiggyAuth() {
    this.s.swiggyAuth = null;
  }
  async setSwiggySessionId(sessionId: string | null) {
    if (this.s.swiggyAuth) this.s.swiggyAuth.sessionId = sessionId;
  }

  async createDevice(d: { name: string; tokenHash: string; pinHash?: string; pinSalt?: string }): Promise<Device> {
    const dev: Device = {
      id: this.uuid(),
      name: d.name,
      tokenHash: d.tokenHash,
      pinHash: d.pinHash ?? null,
      pinSalt: d.pinSalt ?? null,
      pinFails: 0,
      locked: false,
      revoked: false,
      createdAt: new Date(),
      lastSeen: null,
    };
    this.s.devices.set(dev.id, dev);
    return dev;
  }
  async getDeviceByTokenHash(hash: string): Promise<Device | null> {
    for (const d of this.s.devices.values()) if (d.tokenHash === hash && !d.revoked) return d;
    return null;
  }
  async getDevice(id: string): Promise<Device | null> {
    return this.s.devices.get(id) ?? null;
  }
  async touchDevice(id: string) {
    const d = this.s.devices.get(id);
    if (d) d.lastSeen = new Date();
  }
  async listDevices(): Promise<Device[]> {
    return [...this.s.devices.values()];
  }
  async revokeDevice(id: string) {
    const d = this.s.devices.get(id);
    if (d) d.revoked = true;
  }
  async pinAttempt(id: string, ok: boolean): Promise<{ fails: number; locked: boolean }> {
    const d = this.s.devices.get(id);
    if (!d) return { fails: 0, locked: false };
    if (ok) d.pinFails = 0;
    else {
      d.pinFails += 1;
      if (d.pinFails >= 5) d.locked = true;
    }
    return { fails: d.pinFails, locked: d.locked };
  }
  async unlockDevice(id: string) {
    const d = this.s.devices.get(id);
    if (d) {
      d.locked = false;
      d.pinFails = 0;
    }
  }

  async createDraft(d: { deviceId: string; state: DraftState; transcript?: string; items?: VoiceItem[] }): Promise<Draft> {
    const draft: Draft = {
      id: this.uuid(),
      deviceId: d.deviceId,
      state: d.state,
      version: 1,
      transcript: d.transcript ?? null,
      items: d.items ?? null,
      matched: null,
      cart: null,
      totalPaise: null,
      paymentMethod: null,
      approvedTotalPaise: null,
      error: null,
      meta: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.s.drafts.set(draft.id, draft);
    return draft;
  }
  async getDraft(id: string): Promise<Draft | null> {
    return this.s.drafts.get(id) ?? null;
  }
  async updateDraftFields(id: string, patch: Partial<Omit<DraftPatch, "state">>, ifState?: DraftState[]): Promise<Draft | null> {
    const d = this.s.drafts.get(id);
    if (!d) return null;
    if (ifState && !ifState.includes(d.state)) return null;
    Object.assign(d, patch, { updatedAt: new Date() });
    return d;
  }
  async listDraftsByState(states: DraftState[], limit = 50): Promise<Draft[]> {
    return [...this.s.drafts.values()]
      .filter((d) => states.includes(d.state))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }
  async casDraft(id: string, from: DraftState[], patch: Partial<DraftPatch> & { state: DraftState }): Promise<Draft | null> {
    const d = this.s.drafts.get(id);
    if (!d || !from.includes(d.state)) return null;
    Object.assign(d, patch, { version: d.version + 1, updatedAt: new Date() });
    return d;
  }
  async supersedeActiveDrafts(deviceId: string, exceptId: string): Promise<void> {
    for (const d of this.s.drafts.values())
      if (d.deviceId === deviceId && d.id !== exceptId && ACTIVE_PRECONFIRM.includes(d.state)) d.state = "superseded";
  }
  async countDraftsSince(deviceId: string, since: Date): Promise<number> {
    let n = 0;
    for (const d of this.s.drafts.values()) if (d.deviceId === deviceId && d.createdAt >= since) n++;
    return n;
  }
  async expireStaleDrafts(olderThan: Date): Promise<number> {
    let n = 0;
    for (const d of this.s.drafts.values())
      if (EXPIRABLE.includes(d.state) && d.updatedAt < olderThan) {
        d.state = "expired";
        n++;
      }
    return n;
  }

  async insertOrder(o: { draftId: string; idempotencyKey: string; state: OrderState; totalPaise: number; paymentMethod: PaymentMethod }): Promise<OrderRow | null> {
    if (this.s.orderKeys.has(o.idempotencyKey)) return null;
    this.s.orderKeys.add(o.idempotencyKey);
    const row: OrderRow = { id: this.uuid(), swiggyOrderIds: null, raw: null, placedAt: null, createdAt: new Date(), ...o };
    this.s.orders.set(row.id, row);
    return row;
  }
  async updateOrder(id: string, patch: Partial<OrderPatch>): Promise<void> {
    const o = this.s.orders.get(id);
    if (o) Object.assign(o, patch);
  }
  async getOrderByDraft(draftId: string): Promise<OrderRow | null> {
    const all = [...this.s.orders.values()].filter((o) => o.draftId === draftId);
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return all[0] ?? null;
  }
  async recentOrders(limit: number): Promise<OrderRow[]> {
    return [...this.s.orders.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
  async spendSince(since: Date): Promise<{ totalPaise: number; count: number; codCount: number }> {
    let totalPaise = 0,
      c = 0,
      codCount = 0;
    for (const o of this.s.orders.values())
      if (SPEND_ORDER_STATES.includes(o.state) && o.createdAt >= since) {
        totalPaise += o.totalPaise;
        c++;
        if (o.paymentMethod === "COD") codCount++;
      }
    return { totalPaise, count: c, codCount };
  }
  async anyBlockingOrder(): Promise<boolean> {
    for (const o of this.s.orders.values()) if (BLOCKING_ORDER_STATES.includes(o.state)) return true;
    return false;
  }
  async unknownOrders(): Promise<OrderRow[]> {
    return [...this.s.orders.values()].filter((o) => o.state === "unknown");
  }
  async markStalePlacingUnknown(olderThan: Date): Promise<OrderRow[]> {
    const out: OrderRow[] = [];
    for (const o of this.s.orders.values())
      if (o.state === "placing" && o.createdAt < olderThan) {
        o.state = "unknown";
        o.raw = { stalePlacing: true };
        out.push(o);
      }
    return out;
  }

  async acquireLock(draftId: string, ttlMs: number, holder: LockHolder): Promise<boolean> {
    const l = this.s.lock;
    const expired = l.acquiredAt !== null && l.acquiredAt < Date.now() - ttlMs;
    const sameDraftOk = l.draftId === draftId && (holder === "checkout" || l.holder !== "checkout");
    if (l.draftId === null || expired || sameDraftOk) {
      l.draftId = draftId;
      l.holder = holder;
      l.acquiredAt = Date.now();
      return true;
    }
    return false;
  }
  async lockHeldBy(draftId: string, holder: LockHolder): Promise<boolean> {
    return this.s.lock.draftId === draftId && this.s.lock.holder === holder;
  }
  async releaseLock(draftId: string): Promise<void> {
    if (this.s.lock.draftId === draftId) this.s.lock = { draftId: null, holder: null, acquiredAt: null };
  }

  async markUpdateProcessed(updateId: number): Promise<boolean> {
    if (this.s.processed.has(updateId)) return false;
    this.s.processed.add(updateId);
    return true;
  }

  async audit(kind: string, info?: { draftId?: string; deviceId?: string; data?: unknown }): Promise<void> {
    this.s.audits.push({ kind, draftId: info?.draftId, deviceId: info?.deviceId, data: info?.data, at: Date.now() });
  }
  async countAudit(kind: string, deviceId: string, since: Date): Promise<number> {
    return this.s.audits.filter((a) => a.kind === kind && a.deviceId === deviceId && a.at >= since.getTime()).length;
  }

  async getPantry(spoken: string): Promise<unknown | null> {
    return this.s.pantry.get(spoken) ?? null;
  }
  async setPantry(spoken: string, data: unknown): Promise<void> {
    this.s.pantry.set(spoken, data);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __rasoiStore?: Store };

export function getStore(): Store {
  if (!g.__rasoiStore) g.__rasoiStore = env.databaseUrl ? new DrizzleStore() : new MemoryStore();
  return g.__rasoiStore;
}
