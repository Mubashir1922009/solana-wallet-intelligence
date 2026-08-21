import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const directory = join(process.cwd(), "packages", "database", "drizzle");
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
  if (migrations.length === 0) throw new Error("No SQL migrations found");
  const sql = (await Promise.all(migrations.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
  const requiredTables = [
    "wallets", "wallet_metrics", "tokens", "token_risk_snapshots", "chain_transactions", "transaction_wallets",
    "wallet_actions", "signals", "trade_decisions", "paper_positions", "position_events", "ai_analyses",
    "user_actions", "notifications", "system_health", "webhook_deliveries", "market_observations",
    "copyability_evaluations", "crowding_observations", "wallet_backfill_runs", "token_intelligence_snapshots",
    "token_largest_accounts", "token_risk_evaluations", "live_subscription_state", "shadow_position_records",
    "position_marks", "exit_recommendations", "candidate_discoveries", "forward_return_observations", "wallet_reputation_snapshots",
    "runtime_jobs", "worker_leases", "operator_sessions", "operator_security_events", "telegram_interactions", "token_discoveries",
    "candidate_evaluations", "research_runs", "schema_revisions", "runtime_settings", "operator_login_buckets"
  ];
  const missing = requiredTables.filter((table) => !sql.includes(`CREATE TABLE "${table}"`));
  if (missing.length > 0) throw new Error(`Migration is missing required tables: ${missing.join(", ")}`);
  const requiredConstraints = ["\"signature\" text PRIMARY KEY", "paper_positions_signal_uidx", "position_events_idempotency_uidx", "signals_source_tx_wallet_token_uidx", "wallet_actions_signature_wallet_type_uidx", "copyability_source_tx_uidx", "crowding_source_tx_uidx", "candidate_discoveries_idempotency_uidx", "forward_return_idempotency_uidx", "notifications_idempotency_uidx", "token_largest_snapshot_account_uidx", "runtime_jobs_idempotency_uidx", "operator_sessions_token_hash_uidx", "telegram_interactions_update_uidx"];
  for (const requiredConstraint of requiredConstraints) {
    if (!sql.includes(requiredConstraint)) throw new Error(`Migration is missing idempotency constraint: ${requiredConstraint}`);
  }
  if (!sql.includes("runtime-schema-0004")) throw new Error("Migration is missing the authoritative schema revision record");
  console.info(`Validated ${migrations.length} migration(s), ${requiredTables.length} required tables, and ${requiredConstraints.length} idempotency constraints.`);
}

void main();
