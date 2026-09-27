import { bigint, bigserial, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Generic KV: limits, dry_run, paused, pairing codes, one-time links, caches, callback tokens. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Singleton row (id=1). Access token AES-256-GCM encrypted; MCP session id persisted per Swiggy's guidance. */
export const swiggyAuth = pgTable("swiggy_auth", {
  id: integer("id").primaryKey(),
  accessTokenEnc: text("access_token_enc").notNull(),
  clientId: text("client_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sessionId: text("session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  pinHash: text("pin_hash"),
  pinSalt: text("pin_salt"),
  pinFails: integer("pin_fails").notNull().default(0),
  locked: boolean("locked").notNull().default(false),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
});

export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id").notNull(),
  state: text("state").notNull(),
  version: integer("version").notNull().default(1),
  transcript: text("transcript"),
  items: jsonb("items"),
  matched: jsonb("matched"),
  cart: jsonb("cart"),
  totalPaise: integer("total_paise"),
  paymentMethod: text("payment_method"),
  approvedTotalPaise: integer("approved_total_paise"),
  error: text("error"),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  state: text("state").notNull(),
  totalPaise: integer("total_paise").notNull(),
  paymentMethod: text("payment_method").notNull(),
  swiggyOrderIds: jsonb("swiggy_order_ids"),
  raw: jsonb("raw"),
  placedAt: timestamp("placed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One global lease: only one draft may touch the shared Swiggy cart at a time. Seeded with id=1. */
export const commerceLock = pgTable("commerce_lock", {
  id: integer("id").primaryKey(),
  draftId: uuid("draft_id"),
  holder: text("holder"), // 'cart' (list editing lease) | 'checkout' (exclusive; cart edits refused)
  acquiredAt: timestamp("acquired_at", { withTimezone: true }),
});

/** Telegram update_id dedupe. */
export const processedUpdates = pgTable("processed_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only, hash-chained. The DB role used by the app gets no UPDATE/DELETE on this table. */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  kind: text("kind").notNull(),
  draftId: uuid("draft_id"),
  deviceId: uuid("device_id"),
  data: jsonb("data"),
  prevHash: text("prev_hash"),
  hash: text("hash"),
});

/** Learned spoken-name → SKU map (Phase 3 auto-learning; written manually before that). */
export const pantryMap = pgTable("pantry_map", {
  spoken: text("spoken").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
