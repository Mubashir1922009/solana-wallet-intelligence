import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EntryMarketSnapshot, TokenRiskSnapshot, WalletScore } from "@intelligence/core";
import type { JsonValue } from "@intelligence/shared";

export const walletStatus = pgEnum("wallet_status", ["candidate", "tracking", "rejected", "paused", "insufficient_data"]);
export const decisionKind = pgEnum("decision_kind", ["BUY", "REJECT", "OBSERVE"]);
export const positionState = pgEnum("position_state", ["open", "manual_control", "sell_recommended", "closed"]);

export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "string" }).notNull(),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true, mode: "string" }),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true, mode: "string" }),
  status: walletStatus("status").notNull(),
  dataConfidence: doublePrecision("data_confidence"),
  flags: jsonb("flags").$type<string[]>().notNull().default([]),
  notes: text("notes")
}, (table) => [uniqueIndex("wallets_public_key_uidx").on(table.publicKey), index("wallets_status_idx").on(table.status)]);

export const walletMetrics = pgTable("wallet_metrics", {
  walletId: uuid("wallet_id").primaryKey().references(() => wallets.id, { onDelete: "cascade" }),
  sampleSize: integer("sample_size").notNull(),
  observedTrades: integer("observed_trades").notNull(),
  realizedWins: integer("realized_wins").notNull(),
  realizedLosses: integer("realized_losses").notNull(),
  realizedPnLUsd: numeric("realized_pnl_usd"),
  medianReturn: doublePrecision("median_return"),
  averageReturn: doublePrecision("average_return"),
  hitRate: doublePrecision("hit_rate"),
  earlyEntryScore: doublePrecision("early_entry_score"),
  consistencyScore: doublePrecision("consistency_score"),
  copyabilityScore: doublePrecision("copyability_score"),
  crowdingScore: doublePrecision("crowding_score"),
  followerSlippageEstimate: doublePrecision("follower_slippage_estimate"),
  suspiciousCoordinationScore: doublePrecision("suspicious_coordination_score"),
  dataConfidence: doublePrecision("data_confidence"),
  scoreCalculatedAt: timestamp("score_calculated_at", { withTimezone: true, mode: "string" }).notNull()
});

export const tokens = pgTable("tokens", {
  mint: text("mint").primaryKey(),
  symbol: text("symbol"),
  name: text("name"),
  decimals: integer("decimals"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "string" }).notNull(),
  metadataSource: text("metadata_source")
}, (table) => [index("tokens_first_seen_idx").on(table.firstSeenAt)]);

export const tokenRiskSnapshots = pgTable("token_risk_snapshots", {
  id: uuid("id").primaryKey(),
  tokenMint: text("token_mint").notNull().references(() => tokens.mint),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" }).notNull(),
  liquidityUsd: numeric("liquidity_usd"),
  holderConcentration: doublePrecision("holder_concentration"),
  mintAuthorityActive: boolean("mint_authority_active"),
  freezeAuthorityActive: boolean("freeze_authority_active"),
  creator: text("creator"),
  funder: text("funder"),
  priceImpactBps: integer("price_impact_bps"),
  routeAvailable: boolean("route_available"),
  warningFlags: jsonb("warning_flags").$type<string[]>().notNull().default([]),
  riskScore: doublePrecision("risk_score"),
  dataConfidence: doublePrecision("data_confidence")
}, (table) => [index("token_risk_mint_time_idx").on(table.tokenMint, table.capturedAt)]);

export const chainTransactions = pgTable("chain_transactions", {
  signature: text("signature").primaryKey(),
  slot: bigint("slot", { mode: "bigint" }).notNull(),
  blockTime: timestamp("block_time", { withTimezone: true, mode: "string" }),
  status: text("status").notNull(),
  feeLamports: bigint("fee_lamports", { mode: "bigint" }),
  provider: text("provider").notNull(),
  rawPayload: jsonb("raw_payload").$type<JsonValue>().notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  providerReceivedAt: timestamp("provider_received_at", { withTimezone: true, mode: "string" }).notNull(),
  normalizationCompletedAt: timestamp("normalization_completed_at", { withTimezone: true, mode: "string" }),
  ingestionLatencyMs: integer("ingestion_latency_ms")
}, (table) => [index("chain_transactions_slot_idx").on(table.slot), index("chain_transactions_observed_idx").on(table.observedAt)]);

export const transactionWallets = pgTable("transaction_wallets", {
  signature: text("signature").notNull().references(() => chainTransactions.signature, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull()
}, (table) => [uniqueIndex("transaction_wallets_uidx").on(table.signature, table.publicKey), index("transaction_wallets_public_key_idx").on(table.publicKey)]);

export const walletActions = pgTable("wallet_actions", {
  id: uuid("id").primaryKey(),
  wallet: text("wallet").notNull(),
  actionType: text("action_type").notNull(),
  classification: text("classification").notNull().default("UNKNOWN"),
  classificationConfidence: text("classification_confidence").notNull().default("UNKNOWN"),
  evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
  ambiguityReasons: jsonb("ambiguity_reasons").$type<string[]>().notNull().default([]),
  tokenMint: text("token_mint"),
  inputMint: text("input_mint"),
  outputMint: text("output_mint"),
  inputRawAmount: numeric("input_raw_amount", { precision: 78, scale: 0 }),
  inputDecimals: integer("input_decimals"),
  outputRawAmount: numeric("output_raw_amount", { precision: 78, scale: 0 }),
  outputDecimals: integer("output_decimals"),
  approximateInputUsd: numeric("approximate_input_usd"),
  approximateOutputUsd: numeric("approximate_output_usd"),
  transactionSignature: text("transaction_signature").notNull().references(() => chainTransactions.signature),
  slot: bigint("slot", { mode: "bigint" }).notNull().default(sql`0`),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  chainTime: timestamp("chain_time", { withTimezone: true, mode: "string" }),
  sourceConfidence: doublePrecision("source_confidence")
}, (table) => [uniqueIndex("wallet_actions_signature_wallet_type_uidx").on(table.transactionSignature, table.wallet, table.actionType), index("wallet_actions_wallet_time_idx").on(table.wallet, table.observedAt)]);

export const signals = pgTable("signals", {
  id: uuid("id").primaryKey(),
  sourceWallet: text("source_wallet").notNull(),
  tokenMint: text("token_mint").notNull(),
  sourceTransactionSignature: text("source_transaction_signature").notNull().references(() => chainTransactions.signature),
  detectedAt: timestamp("detected_at", { withTimezone: true, mode: "string" }).notNull(),
  chainEventAt: timestamp("chain_event_at", { withTimezone: true, mode: "string" }),
  chainSlot: bigint("chain_slot", { mode: "bigint" }).notNull(),
  walletScore: jsonb("wallet_score").$type<WalletScore>().notNull(),
  antiCrowdingScore: doublePrecision("anti_crowding_score"),
  tokenRiskSnapshot: jsonb("token_risk_snapshot").$type<TokenRiskSnapshot>(),
  decision: decisionKind("decision").notNull(),
  rejectionReasons: jsonb("rejection_reasons").$type<string[]>().notNull(),
  confidence: doublePrecision("confidence")
}, (table) => [uniqueIndex("signals_source_tx_wallet_token_uidx").on(table.sourceTransactionSignature, table.sourceWallet, table.tokenMint), index("signals_token_time_idx").on(table.tokenMint, table.detectedAt)]);

export const tradeDecisions = pgTable("trade_decisions", {
  id: uuid("id").primaryKey(),
  signalId: uuid("signal_id").notNull().references(() => signals.id),
  decision: decisionKind("decision").notNull(),
  reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
  parameters: jsonb("parameters").$type<JsonValue>().notNull(),
  rulesetHash: text("ruleset_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("trade_decisions_signal_idx").on(table.signalId)]);

export const paperPositions = pgTable("paper_positions", {
  id: uuid("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  triggerWallet: text("trigger_wallet").notNull(),
  signalId: uuid("signal_id").notNull().references(() => signals.id),
  simulatedEntryAt: timestamp("simulated_entry_at", { withTimezone: true, mode: "string" }).notNull(),
  simulatedEntryPriceUsd: numeric("simulated_entry_price_usd"),
  simulatedUsdAmount: numeric("simulated_usd_amount").notNull(),
  tokenRawAmount: numeric("token_raw_amount", { precision: 78, scale: 0 }).notNull(),
  tokenDecimals: integer("token_decimals").notNull(),
  feesEstimateUsd: numeric("fees_estimate_usd"),
  slippageEstimateBps: integer("slippage_estimate_bps"),
  entryMarketSnapshot: jsonb("entry_market_snapshot").$type<EntryMarketSnapshot>().notNull(),
  quoteAgeAtDecisionMs: integer("quote_age_at_decision_ms"),
  state: positionState("state").notNull(),
  markPriceUsd: numeric("mark_price_usd"),
  unrealizedPnlUsd: numeric("unrealized_pnl_usd"),
  realizedPnlUsd: numeric("realized_pnl_usd"),
  exitRecommendation: text("exit_recommendation"),
  openedAt: timestamp("opened_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" })
}, (table) => [uniqueIndex("paper_positions_signal_uidx").on(table.signalId), index("paper_positions_state_idx").on(table.state), index("paper_positions_token_idx").on(table.tokenMint)]);

export const positionEvents = pgTable("position_events", {
  id: uuid("id").primaryKey(),
  positionId: uuid("position_id").notNull().references(() => paperPositions.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  details: jsonb("details").$type<JsonValue>().notNull(),
  idempotencyKey: text("idempotency_key").notNull()
}, (table) => [uniqueIndex("position_events_idempotency_uidx").on(table.idempotencyKey), index("position_events_created_idx").on(table.createdAt)]);

export const aiAnalyses = pgTable("ai_analyses", {
  id: uuid("id").primaryKey(), purpose: text("purpose").notNull(), modelRequested: text("model_requested").notNull(),
  modelReturned: text("model_returned"), promptHash: text("prompt_hash").notNull(), structuredResponse: jsonb("structured_response").$type<JsonValue>(),
  latencyMs: integer("latency_ms"), errorCode: text("error_code"), requestMetadata: jsonb("request_metadata").$type<JsonValue>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("ai_analyses_purpose_time_idx").on(table.purpose, table.createdAt)]);

export const userActions = pgTable("user_actions", {
  id: uuid("id").primaryKey(), positionId: uuid("position_id").references(() => paperPositions.id), action: text("action").notNull(),
  details: jsonb("details").$type<JsonValue>().notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("user_actions_created_idx").on(table.createdAt)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(), type: text("type").notNull(), payload: jsonb("payload").$type<JsonValue>().notNull(),
  provider: text("provider").notNull(), deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("notifications_created_idx").on(table.createdAt)]);

export const systemHealth = pgTable("system_health", {
  id: uuid("id").primaryKey(), component: text("component").notNull(), status: text("status").notNull(), detail: text("detail").notNull(),
  latencyMs: integer("latency_ms"), checkedAt: timestamp("checked_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("system_health_component_time_idx").on(table.component, table.checkedAt)]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey(), provider: text("provider").notNull(), payloadHash: text("payload_hash").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(), processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" }),
  errorCode: text("error_code"), rawPayload: jsonb("raw_payload").$type<JsonValue>().notNull()
}, (table) => [uniqueIndex("webhook_deliveries_payload_hash_uidx").on(table.payloadHash), index("webhook_deliveries_received_idx").on(table.receivedAt)]);

export const marketObservations = pgTable("market_observations", {
  id: uuid("id").primaryKey(), provider: text("provider").notNull(), provenance: text("provenance").notNull(),
  inputMint: text("input_mint").notNull(), outputMint: text("output_mint").notNull(),
  inputRawAmount: numeric("input_raw_amount", { precision: 78, scale: 0 }).notNull(), outputRawAmount: numeric("output_raw_amount", { precision: 78, scale: 0 }),
  otherAmountThresholdRaw: numeric("other_amount_threshold_raw", { precision: 78, scale: 0 }), inputDecimals: integer("input_decimals"), outputDecimals: integer("output_decimals"),
  priceImpactPct: numeric("price_impact_pct"), inputUsdValue: numeric("input_usd_value"), outputUsdValue: numeric("output_usd_value"),
  router: jsonb("router").$type<JsonValue>(), feeInformation: jsonb("fee_information").$type<JsonValue>(), routeAvailable: boolean("route_available").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }).notNull(), receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(),
  providerLatencyMs: integer("provider_latency_ms").notNull(), transactionIncluded: boolean("transaction_included").notNull().default(false)
}, (table) => [index("market_observations_pair_time_idx").on(table.inputMint, table.outputMint, table.receivedAt)]);

export const copyabilityEvaluations = pgTable("copyability_evaluations", {
  id: uuid("id").primaryKey(), sourceWallet: text("source_wallet").notNull(), sourceTransactionSignature: text("source_transaction_signature").notNull().references(() => chainTransactions.signature),
  tokenMint: text("token_mint").notNull(), marketObservationId: uuid("market_observation_id").references(() => marketObservations.id), status: text("status").notNull(),
  sourceEffectivePrice: numeric("source_effective_price"), followerQuotedPrice: numeric("follower_quoted_price"), entryPriceDeteriorationBps: integer("entry_price_deterioration_bps"),
  entryPriceImprovementBps: integer("entry_price_improvement_bps"), detectionLatencyMs: integer("detection_latency_ms"), normalizationLatencyMs: integer("normalization_latency_ms"),
  decisionLatencyMs: integer("decision_latency_ms"), quoteLatencyMs: integer("quote_latency_ms"), totalFollowerLatencyMs: integer("total_follower_latency_ms"),
  confidence: text("confidence").notNull(), reasons: jsonb("reasons").$type<string[]>().notNull(), evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [uniqueIndex("copyability_source_tx_uidx").on(table.sourceTransactionSignature), index("copyability_token_time_idx").on(table.tokenMint, table.evaluatedAt)]);

export const crowdingObservations = pgTable("crowding_observations", {
  id: uuid("id").primaryKey(), sourceWallet: text("source_wallet").notNull(), sourceTransactionSignature: text("source_transaction_signature").notNull().references(() => chainTransactions.signature),
  tokenMint: text("token_mint").notNull(), observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), windows: jsonb("windows").notNull(),
  observedInputVolumeRaw: numeric("observed_input_volume_raw", { precision: 78, scale: 0 }), observedInputMint: text("observed_input_mint"),
  monitoredWalletCount: integer("monitored_wallet_count"), expectedCoverageWalletCount: integer("expected_coverage_wallet_count"), coverageRatio: doublePrecision("coverage_ratio"),
  confidence: text("confidence").notNull(), status: text("status").notNull(), reasons: jsonb("reasons").$type<string[]>().notNull()
}, (table) => [uniqueIndex("crowding_source_tx_uidx").on(table.sourceTransactionSignature), index("crowding_token_time_idx").on(table.tokenMint, table.observedAt)]);

export const walletBackfillRuns = pgTable("wallet_backfill_runs", {
  id: uuid("id").primaryKey(), wallet: text("wallet").notNull(), provider: text("provider").notNull(), historyMode: text("history_mode").notNull(),
  requestedLimit: integer("requested_limit").notNull(), signaturesFetched: integer("signatures_fetched").notNull(), transactionsFetched: integer("transactions_fetched").notNull(),
  actionsPersisted: integer("actions_persisted").notNull(), duplicatesIgnored: integer("duplicates_ignored").notNull(), failures: jsonb("failures").notNull(),
  complete: boolean("complete").notNull(), startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("wallet_backfill_wallet_time_idx").on(table.wallet, table.startedAt)]);
