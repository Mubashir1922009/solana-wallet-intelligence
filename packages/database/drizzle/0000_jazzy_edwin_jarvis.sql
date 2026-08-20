CREATE TYPE "public"."decision_kind" AS ENUM('BUY', 'REJECT', 'OBSERVE');--> statement-breakpoint
CREATE TYPE "public"."position_state" AS ENUM('open', 'manual_control', 'sell_recommended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('candidate', 'tracking', 'rejected', 'paused', 'insufficient_data');--> statement-breakpoint
CREATE TABLE "ai_analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"model_requested" text NOT NULL,
	"model_returned" text,
	"prompt_hash" text NOT NULL,
	"structured_response" jsonb,
	"latency_ms" integer,
	"error_code" text,
	"request_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_transactions" (
	"signature" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"status" text NOT NULL,
	"fee_lamports" bigint,
	"provider" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"provider_received_at" timestamp with time zone NOT NULL,
	"normalization_completed_at" timestamp with time zone,
	"ingestion_latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"provider" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"trigger_wallet" text NOT NULL,
	"signal_id" uuid NOT NULL,
	"simulated_entry_at" timestamp with time zone NOT NULL,
	"simulated_entry_price_usd" numeric NOT NULL,
	"simulated_usd_amount" numeric NOT NULL,
	"token_raw_amount" numeric(78, 0) NOT NULL,
	"token_decimals" integer NOT NULL,
	"fees_estimate_usd" numeric,
	"slippage_estimate_bps" integer,
	"entry_market_snapshot" jsonb NOT NULL,
	"state" "position_state" NOT NULL,
	"mark_price_usd" numeric,
	"unrealized_pnl_usd" numeric,
	"realized_pnl_usd" numeric,
	"exit_recommendation" text,
	"opened_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "position_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_wallet" text NOT NULL,
	"token_mint" text NOT NULL,
	"source_transaction_signature" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"chain_event_at" timestamp with time zone,
	"chain_slot" bigint NOT NULL,
	"wallet_score" jsonb NOT NULL,
	"anti_crowding_score" double precision,
	"token_risk_snapshot" jsonb,
	"decision" "decision_kind" NOT NULL,
	"rejection_reasons" jsonb NOT NULL,
	"confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "system_health" (
	"id" uuid PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"status" text NOT NULL,
	"detail" text NOT NULL,
	"latency_ms" integer,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_risk_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"liquidity_usd" numeric,
	"holder_concentration" double precision,
	"mint_authority_active" boolean,
	"freeze_authority_active" boolean,
	"creator" text,
	"funder" text,
	"price_impact_bps" integer,
	"route_available" boolean,
	"warning_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_score" double precision,
	"data_confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"mint" text PRIMARY KEY NOT NULL,
	"symbol" text,
	"name" text,
	"decimals" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"metadata_source" text
);
--> statement-breakpoint
CREATE TABLE "trade_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"decision" "decision_kind" NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"parameters" jsonb NOT NULL,
	"ruleset_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_wallets" (
	"signature" text NOT NULL,
	"public_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position_id" uuid,
	"action" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"action_type" text NOT NULL,
	"token_mint" text,
	"input_mint" text,
	"output_mint" text,
	"input_raw_amount" numeric(78, 0),
	"output_raw_amount" numeric(78, 0),
	"approximate_input_usd" numeric,
	"approximate_output_usd" numeric,
	"transaction_signature" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"chain_time" timestamp with time zone,
	"source_confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "wallet_metrics" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"sample_size" integer NOT NULL,
	"observed_trades" integer NOT NULL,
	"realized_wins" integer NOT NULL,
	"realized_losses" integer NOT NULL,
	"realized_pnl_usd" numeric,
	"median_return" double precision,
	"average_return" double precision,
	"hit_rate" double precision,
	"early_entry_score" double precision,
	"consistency_score" double precision,
	"copyability_score" double precision,
	"crowding_score" double precision,
	"follower_slippage_estimate" double precision,
	"suspicious_coordination_score" double precision,
	"data_confidence" double precision,
	"score_calculated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"first_observed_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"status" "wallet_status" NOT NULL,
	"data_confidence" double precision,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"error_code" text,
	"raw_payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_transaction_signature_chain_transactions_signature_fk" FOREIGN KEY ("source_transaction_signature") REFERENCES "public"."chain_transactions"("signature") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD CONSTRAINT "token_risk_snapshots_token_mint_tokens_mint_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_decisions" ADD CONSTRAINT "trade_decisions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_wallets" ADD CONSTRAINT "transaction_wallets_signature_chain_transactions_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."chain_transactions"("signature") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_actions" ADD CONSTRAINT "user_actions_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD CONSTRAINT "wallet_actions_transaction_signature_chain_transactions_signature_fk" FOREIGN KEY ("transaction_signature") REFERENCES "public"."chain_transactions"("signature") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_metrics" ADD CONSTRAINT "wallet_metrics_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_analyses_purpose_time_idx" ON "ai_analyses" USING btree ("purpose","created_at");--> statement-breakpoint
CREATE INDEX "chain_transactions_slot_idx" ON "chain_transactions" USING btree ("slot");--> statement-breakpoint
CREATE INDEX "chain_transactions_observed_idx" ON "chain_transactions" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_signal_uidx" ON "paper_positions" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "paper_positions_state_idx" ON "paper_positions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "paper_positions_token_idx" ON "paper_positions" USING btree ("token_mint");--> statement-breakpoint
CREATE UNIQUE INDEX "position_events_idempotency_uidx" ON "position_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "position_events_created_idx" ON "position_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_source_tx_wallet_token_uidx" ON "signals" USING btree ("source_transaction_signature","source_wallet","token_mint");--> statement-breakpoint
CREATE INDEX "signals_token_time_idx" ON "signals" USING btree ("token_mint","detected_at");--> statement-breakpoint
CREATE INDEX "system_health_component_time_idx" ON "system_health" USING btree ("component","checked_at");--> statement-breakpoint
CREATE INDEX "token_risk_mint_time_idx" ON "token_risk_snapshots" USING btree ("token_mint","captured_at");--> statement-breakpoint
CREATE INDEX "tokens_first_seen_idx" ON "tokens" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "trade_decisions_signal_idx" ON "trade_decisions" USING btree ("signal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_wallets_uidx" ON "transaction_wallets" USING btree ("signature","public_key");--> statement-breakpoint
CREATE INDEX "transaction_wallets_public_key_idx" ON "transaction_wallets" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "user_actions_created_idx" ON "user_actions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_actions_signature_wallet_type_uidx" ON "wallet_actions" USING btree ("transaction_signature","wallet","action_type");--> statement-breakpoint
CREATE INDEX "wallet_actions_wallet_time_idx" ON "wallet_actions" USING btree ("wallet","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_public_key_uidx" ON "wallets" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "wallets_status_idx" ON "wallets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_payload_hash_uidx" ON "webhook_deliveries" USING btree ("payload_hash");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_idx" ON "webhook_deliveries" USING btree ("received_at");