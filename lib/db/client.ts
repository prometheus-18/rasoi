import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

const g = globalThis as unknown as { __rasoiDb?: Db };

export function db(): Db {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!g.__rasoiDb) g.__rasoiDb = drizzle(neon(env.databaseUrl), { schema });
  return g.__rasoiDb;
}
