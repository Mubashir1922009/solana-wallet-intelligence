import process from "node:process";
import { createPostgresStore, rawPayloadRetentionMode } from "@intelligence/database";

async function main(): Promise<void> {

if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required; no database was modified");
const apply = rawPayloadRetentionMode(process.argv) === "APPLIED";
const configuredDays = Number(process.env.RAW_PAYLOAD_RETENTION_DAYS ?? "14");
if (!Number.isInteger(configuredDays) || configuredDays < 1 || configuredDays > 365) throw new Error("RAW_PAYLOAD_RETENTION_DAYS must be an integer from 1 to 365");
const database = createPostgresStore(process.env.DATABASE_URL);
try {
  await database.schemaReady();
  const result = await database.pruneRawPayloads(configuredDays, apply);
  console.info(JSON.stringify({ posture: apply ? "APPLIED" : "DRY_RUN", normalizedDecisionAuditRetained: true, ...result }, null, 2));
  if (!apply) console.info("Dry run only. Pass --apply after confirming this is the intended project database.");
} finally {
  await database.close();
}
}
void main();
