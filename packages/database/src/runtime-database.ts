import { createPostgresStore } from "./postgres-store.js";

export type AuthoritativeRuntimeDatabase = ReturnType<typeof createPostgresStore>;
export type RuntimeDatabaseFactory = (databaseUrl: string) => AuthoritativeRuntimeDatabase;

export function createAuthoritativeRuntimeDatabase(databaseUrl: string | undefined, factory: RuntimeDatabaseFactory = createPostgresStore): AuthoritativeRuntimeDatabase {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) throw new Error("Authoritative PostgreSQL DATABASE_URL is required; in-memory fallback is prohibited");
  try { return factory(databaseUrl); }
  catch (error) { throw new Error("Authoritative PostgreSQL initialization failed; in-memory fallback is prohibited", { cause: error }); }
}
