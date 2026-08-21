import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export async function runMigrations(databaseUrl: string, migrationsFolder = "packages/database/drizzle"): Promise<void> { const client = postgres(databaseUrl, { max: 1 }); try { await migrate(drizzle(client), { migrationsFolder }); } finally { await client.end(); } }
