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
import type { CandidateEvaluation, FollowerSourceEvent, OperatorSecurityEvent, ResearchRun, RuntimeJob, ShadowPositionContext, TokenConcentrationObservation, TokenMintObservation, TokenRiskComponent, WalletReputationSnapshot } from "@intelligence/core";
import type { JsonValue } from "@intelligence/shared";

export const walletStatus = pgEnum("wallet_status", ["candidate", "research_watch", "tracking", "rejected", "paused", "insufficient_data"]);
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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(), status: text("status").notNull().default("PENDING"),
  errorCode: text("error_code"), attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "string" }), idempotencyKey: text("idempotency_key"),
  attemptCount: integer("attempt_count").notNull().default(0), nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }), responseClass: text("response_class")
}, (table) => [index("notifications_created_idx").on(table.createdAt), uniqueIndex("notifications_idempotency_uidx").on(table.idempotencyKey)]);

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
  , requestBefore: text("request_before"), continuationCursor: text("continuation_cursor"), lastProcessedSignature: text("last_processed_signature"),
  lastProcessedSlot: bigint("last_processed_slot", { mode: "bigint" }), lastProcessedAt: timestamp("last_processed_at", { withTimezone: true, mode: "string" }),
  completenessState: text("completeness_state").notNull().default("UNKNOWN"), attemptCount: integer("attempt_count").notNull().default(1),
  lastErrorClass: text("last_error_class"), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow()
}, (table) => [index("wallet_backfill_wallet_time_idx").on(table.wallet, table.startedAt)]);

export const tokenIntelligenceSnapshots = pgTable("token_intelligence_snapshots", {
  id: uuid("id").primaryKey(), tokenMint: text("token_mint").notNull(), rawSupply: numeric("raw_supply", { precision: 78, scale: 0 }), decimals: integer("decimals"),
  supplySlot: bigint("supply_slot", { mode: "bigint" }), mintObservation: jsonb("mint_observation").$type<TokenMintObservation>().notNull(),
  concentration: jsonb("concentration").$type<TokenConcentrationObservation>().notNull(), confidence: text("confidence").notNull(), completeness: doublePrecision("completeness").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(), observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("token_intelligence_mint_time_idx").on(table.tokenMint, table.observedAt)]);

export const tokenLargestAccounts = pgTable("token_largest_accounts", {
  id: uuid("id").primaryKey(), snapshotId: uuid("snapshot_id").notNull().references(() => tokenIntelligenceSnapshots.id, { onDelete: "cascade" }),
  tokenAccount: text("token_account").notNull(), rawBalance: numeric("raw_balance", { precision: 78, scale: 0 }).notNull(), decimals: integer("decimals").notNull(),
  percentageOfSupply: numeric("percentage_of_supply"), resolvedOwner: text("resolved_owner"), ownerClassification: text("owner_classification").notNull(),
  slot: bigint("slot", { mode: "bigint" }).notNull(), observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), provenance: text("provenance").notNull()
}, (table) => [uniqueIndex("token_largest_snapshot_account_uidx").on(table.snapshotId, table.tokenAccount), index("token_largest_owner_idx").on(table.resolvedOwner)]);

export const tokenRiskEvaluations = pgTable("token_risk_evaluations", {
  id: uuid("id").primaryKey(), tokenMint: text("token_mint").notNull(), totalRisk: doublePrecision("total_risk").notNull(), components: jsonb("components").$type<TokenRiskComponent[]>().notNull(),
  reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(), confidence: text("confidence").notNull(), dataCompleteness: doublePrecision("data_completeness").notNull(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "string" }).notNull(), rulesetHash: text("ruleset_hash").notNull(), intelligenceSnapshotId: uuid("intelligence_snapshot_id"), marketObservationId: uuid("market_observation_id")
}, (table) => [index("token_risk_evaluation_mint_time_idx").on(table.tokenMint, table.evaluatedAt)]);

export const liveSubscriptionState = pgTable("live_subscription_state", {
  wallet: text("wallet").primaryKey(), lifecycle: text("lifecycle").notNull(), priority: integer("priority").notNull(), provider: text("provider").notNull(), subscriptionHealthy: boolean("subscription_healthy").notNull(),
  lastObservedSignature: text("last_observed_signature"), lastObservedSlot: bigint("last_observed_slot", { mode: "bigint" }), lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "string" }),
  lastSuccessfulIngestionAt: timestamp("last_successful_ingestion_at", { withTimezone: true, mode: "string" }), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("live_subscription_lifecycle_priority_idx").on(table.lifecycle, table.priority)]);

export const shadowPositionRecords = pgTable("shadow_position_records", {
  positionId: uuid("position_id").primaryKey().references(() => paperPositions.id, { onDelete: "cascade" }), context: jsonb("context").$type<ShadowPositionContext>().notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

export const positionMarks = pgTable("position_marks", {
  id: uuid("id").primaryKey(), positionId: uuid("position_id").notNull().references(() => paperPositions.id, { onDelete: "cascade" }), marketObservationId: uuid("market_observation_id"),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), estimatedValueUsd: numeric("estimated_value_usd"), grossUnrealizedPnlUsd: numeric("gross_unrealized_pnl_usd"),
  netUnrealizedPnlUsd: numeric("net_unrealized_pnl_usd"), estimatedFeesUsd: numeric("estimated_fees_usd"), maxFavorableExcursionUsd: numeric("max_favorable_excursion_usd"), maxAdverseExcursionUsd: numeric("max_adverse_excursion_usd"),
  timeHeldMs: integer("time_held_ms").notNull(), quoteAgeMs: integer("quote_age_ms"), routeAvailable: boolean("route_available").notNull(), confidence: text("confidence").notNull(), provenance: text("provenance").notNull()
}, (table) => [index("position_marks_position_time_idx").on(table.positionId, table.observedAt)]);

export const exitRecommendations = pgTable("exit_recommendations", {
  id: uuid("id").primaryKey(), positionId: uuid("position_id").notNull().references(() => paperPositions.id, { onDelete: "cascade" }), recommendation: text("recommendation").notNull(),
  reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(), confidence: text("confidence").notNull(), inputSnapshot: jsonb("input_snapshot").$type<JsonValue>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(), rulesetHash: text("ruleset_hash").notNull()
}, (table) => [index("exit_recommendations_position_time_idx").on(table.positionId, table.createdAt)]);

export const candidateDiscoveries = pgTable("candidate_discoveries", {
  id: uuid("id").primaryKey(), wallet: text("wallet").notNull(), reason: text("reason").notNull(), sourceToken: text("source_token").notNull(), sourceEvent: text("source_event").notNull(),
  independentObservationCount: integer("independent_observation_count").notNull(), confidence: text("confidence").notNull(), firstDiscoveredAt: timestamp("first_discovered_at", { withTimezone: true, mode: "string" }).notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true, mode: "string" }).notNull(), idempotencyKey: text("idempotency_key").notNull()
}, (table) => [uniqueIndex("candidate_discoveries_idempotency_uidx").on(table.idempotencyKey), index("candidate_discoveries_wallet_idx").on(table.wallet)]);

export const forwardReturnObservations = pgTable("forward_return_observations", {
  id: uuid("id").primaryKey(), wallet: text("wallet").notNull(), transactionSignature: text("transaction_signature").notNull(), tokenMint: text("token_mint").notNull(), windowMs: integer("window_ms").notNull(),
  status: text("status").notNull(), entryMarketObservationId: uuid("entry_market_observation_id"), forwardMarketObservationId: uuid("forward_market_observation_id"), followerReturn: doublePrecision("follower_return"),
  sourceEventId: uuid("source_event_id"), dataCompleteness: doublePrecision("data_completeness").notNull().default(0), providerProvenance: text("provider_provenance"), estimatedNetReturn: doublePrecision("estimated_net_return"),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }), latenessMs: integer("lateness_ms"), idempotencyKey: text("idempotency_key").notNull()
}, (table) => [uniqueIndex("forward_return_idempotency_uidx").on(table.idempotencyKey), index("forward_return_wallet_time_idx").on(table.wallet, table.observedAt)]);

export const followerSourceEvents = pgTable("follower_source_events", {
  id: uuid("id").primaryKey(), sourceWallet: text("source_wallet").notNull(), sourceTransaction: text("source_transaction").notNull(), tokenMint: text("token_mint").notNull(),
  sourceBlockTime: timestamp("source_block_time", { withTimezone: true, mode: "string" }), sourceObservedAt: timestamp("source_observed_at", { withTimezone: true, mode: "string" }).notNull(), decisionEvidenceAt: timestamp("decision_evidence_at", { withTimezone: true, mode: "string" }).notNull(),
  entryMarketObservationId: uuid("entry_market_observation_id"), copyabilityEvaluationId: uuid("copyability_evaluation_id"), status: text("status").$type<FollowerSourceEvent["status"]>().notNull(),
  sourceEffectiveEntry: text("source_effective_entry"), followerQuotedEntry: text("follower_quoted_entry"), routeAvailable: boolean("route_available"), quoteRequestedAt: timestamp("quote_requested_at", { withTimezone: true, mode: "string" }), quoteReceivedAt: timestamp("quote_received_at", { withTimezone: true, mode: "string" }),
  quoteLatencyMs: integer("quote_latency_ms"), priceImpactPct: text("price_impact_pct"), dataCompleteness: doublePrecision("data_completeness").notNull(), providerProvenance: text("provider_provenance"), idempotencyKey: text("idempotency_key").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [uniqueIndex("follower_source_tx_uidx").on(table.sourceTransaction), uniqueIndex("follower_source_idempotency_uidx").on(table.idempotencyKey), index("follower_source_wallet_time_idx").on(table.sourceWallet, table.sourceObservedAt)]);

export const walletReputationSnapshots = pgTable("wallet_reputation_snapshots", {
  id: uuid("id").primaryKey(), wallet: text("wallet").notNull(), snapshot: jsonb("snapshot").$type<WalletReputationSnapshot>().notNull(), calculatedAt: timestamp("calculated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [uniqueIndex("wallet_reputation_wallet_uidx").on(table.wallet)]);

export const runtimeJobs = pgTable("runtime_jobs", {
  id: uuid("id").primaryKey(), type: text("type").notNull(), payload: jsonb("payload").$type<RuntimeJob["payload"]>().notNull(), status: text("status").notNull(),
  runAt: timestamp("run_at", { withTimezone: true, mode: "string" }).notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }), completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }), attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(), leaseOwner: text("lease_owner"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"), idempotencyKey: text("idempotency_key").notNull()
}, (table) => [uniqueIndex("runtime_jobs_idempotency_uidx").on(table.idempotencyKey), index("runtime_jobs_claim_idx").on(table.status, table.runAt), index("runtime_jobs_lease_idx").on(table.status, table.leaseExpiresAt)]);

export const workerLeases = pgTable("worker_leases", {
  role: text("role").primaryKey(), workerId: text("worker_id").notNull(), startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "string" }).notNull(), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }).notNull(),
  status: text("status").notNull(), lastProcessedSlot: bigint("last_processed_slot", { mode: "bigint" }), activeSubscriptions: integer("active_subscriptions").notNull().default(0),
  queueDepth: integer("queue_depth").notNull().default(0), revision: text("revision")
}, (table) => [index("worker_leases_expiry_idx").on(table.leaseExpiresAt)]);

export const schemaRevisions = pgTable("schema_revisions", {
  component: text("component").primaryKey(), revision: text("revision").notNull(), appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull()
});

export const runtimeSettings = pgTable("runtime_settings", {
  key: text("key").primaryKey(), watcherEnabled: boolean("watcher_enabled").notNull().default(true), shadowEntryEnabled: boolean("shadow_entry_enabled").notNull().default(true),
  killSwitch: boolean("kill_switch").notNull().default(false), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(), updatedBy: text("updated_by").notNull(), revision: integer("revision").notNull().default(1)
});

export const operatorLoginBuckets = pgTable("operator_login_buckets", {
  clientLabelHash: text("client_label_hash").primaryKey(), windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull(), attempts: integer("attempts").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("operator_login_buckets_updated_idx").on(table.updatedAt)]);

export const operatorSessions = pgTable("operator_sessions", {
  id: uuid("id").primaryKey(), tokenHash: text("token_hash").notNull(), csrfHash: text("csrf_hash").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }), clientLabel: text("client_label")
}, (table) => [uniqueIndex("operator_sessions_token_hash_uidx").on(table.tokenHash), index("operator_sessions_expiry_idx").on(table.expiresAt, table.revokedAt)]);

export const operatorSecurityEvents = pgTable("operator_security_events", {
  id: uuid("id").primaryKey(), type: text("type").notNull(), occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  sessionId: uuid("session_id"), actor: text("actor").notNull(), clientLabel: text("client_label"), details: jsonb("details").$type<OperatorSecurityEvent["details"]>().notNull()
}, (table) => [index("operator_security_events_time_idx").on(table.occurredAt), index("operator_security_events_type_idx").on(table.type)]);

export const telegramInteractions = pgTable("telegram_interactions", {
  nonceHash: text("nonce_hash").primaryKey(), positionId: uuid("position_id").notNull().references(() => paperPositions.id, { onDelete: "cascade" }), action: text("action").notNull(),
  expectedPositionState: text("expected_position_state").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }), updateId: text("update_id")
}, (table) => [uniqueIndex("telegram_interactions_update_uidx").on(table.updateId), index("telegram_interactions_expiry_idx").on(table.expiresAt)]);

export const tokenDiscoveries = pgTable("token_discoveries", {
  mint: text("mint").primaryKey(), firstPoolCreatedAt: timestamp("first_pool_created_at", { withTimezone: true, mode: "string" }), symbol: text("symbol"), name: text("name"), decimals: integer("decimals"),
  organicScore: doublePrecision("organic_score"), organicScoreLabel: text("organic_score_label"), provider: text("provider").notNull(), provenance: text("provenance").notNull(),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true, mode: "string" }).notNull(), lastObservedAt: timestamp("last_observed_at", { withTimezone: true, mode: "string" }).notNull(),
  providerObservedAt: timestamp("provider_observed_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [index("token_discoveries_pool_time_idx").on(table.firstPoolCreatedAt), index("token_discoveries_observed_idx").on(table.lastObservedAt)]);

export const candidateEvaluations = pgTable("candidate_evaluations", {
  wallet: text("wallet").primaryKey(), state: text("state").notNull(), sampleSize: integer("sample_size").notNull(), independentTokenCount: integer("independent_token_count").notNull(),
  provisionalScore: doublePrecision("provisional_score"), evidenceAtEvaluation: jsonb("evidence_at_evaluation").$type<CandidateEvaluation["evidenceAtEvaluation"]>().notNull(),
  reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(), evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "string" }).notNull(), rulesetHash: text("ruleset_hash").notNull()
}, (table) => [index("candidate_evaluations_state_score_idx").on(table.state, table.provisionalScore)]);

export const researchRuns = pgTable("research_runs", {
  id: uuid("id").primaryKey(), kind: text("kind").notNull(), startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }), status: text("status").notNull(), parameters: jsonb("parameters").$type<ResearchRun["parameters"]>().notNull(),
  report: jsonb("report").$type<ResearchRun["report"]>(), errorCode: text("error_code")
}, (table) => [index("research_runs_kind_time_idx").on(table.kind, table.startedAt)]);
