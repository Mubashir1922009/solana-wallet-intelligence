CREATE TABLE "copyability_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_wallet" text NOT NULL,
	"source_transaction_signature" text NOT NULL,
	"token_mint" text NOT NULL,
	"market_observation_id" uuid,
	"status" text NOT NULL,
	"source_effective_price" numeric,
	"follower_quoted_price" numeric,
	"entry_price_deterioration_bps" integer,
	"entry_price_improvement_bps" integer,
	"detection_latency_ms" integer,
	"normalization_latency_ms" integer,
	"decision_latency_ms" integer,
	"quote_latency_ms" integer,
	"total_follower_latency_ms" integer,
	"confidence" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crowding_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_wallet" text NOT NULL,
	"source_transaction_signature" text NOT NULL,
	"token_mint" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"windows" jsonb NOT NULL,
	"observed_input_volume_raw" numeric(78, 0),
	"observed_input_mint" text,
	"monitored_wallet_count" integer,
	"expected_coverage_wallet_count" integer,
	"coverage_ratio" double precision,
	"confidence" text NOT NULL,
	"status" text NOT NULL,
	"reasons" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provenance" text NOT NULL,
	"input_mint" text NOT NULL,
	"output_mint" text NOT NULL,
	"input_raw_amount" numeric(78, 0) NOT NULL,
	"output_raw_amount" numeric(78, 0),
	"other_amount_threshold_raw" numeric(78, 0),
	"input_decimals" integer,
	"output_decimals" integer,
	"price_impact_pct" numeric,
	"input_usd_value" numeric,
	"output_usd_value" numeric,
	"router" jsonb,
	"fee_information" jsonb,
	"route_available" boolean NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"provider_latency_ms" integer NOT NULL,
	"transaction_included" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_backfill_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"provider" text NOT NULL,
	"history_mode" text NOT NULL,
	"requested_limit" integer NOT NULL,
	"signatures_fetched" integer NOT NULL,
	"transactions_fetched" integer NOT NULL,
	"actions_persisted" integer NOT NULL,
	"duplicates_ignored" integer NOT NULL,
	"failures" jsonb NOT NULL,
	"complete" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_positions" ALTER COLUMN "simulated_entry_price_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "quote_age_at_decision_ms" integer;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "classification" text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "classification_confidence" text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "ambiguity_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "input_decimals" integer;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "output_decimals" integer;--> statement-breakpoint
ALTER TABLE "wallet_actions" ADD COLUMN "slot" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copyability_evaluations" ADD CONSTRAINT "copyability_evaluations_source_transaction_signature_chain_transactions_signature_fk" FOREIGN KEY ("source_transaction_signature") REFERENCES "public"."chain_transactions"("signature") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copyability_evaluations" ADD CONSTRAINT "copyability_evaluations_market_observation_id_market_observations_id_fk" FOREIGN KEY ("market_observation_id") REFERENCES "public"."market_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crowding_observations" ADD CONSTRAINT "crowding_observations_source_transaction_signature_chain_transactions_signature_fk" FOREIGN KEY ("source_transaction_signature") REFERENCES "public"."chain_transactions"("signature") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copyability_source_tx_uidx" ON "copyability_evaluations" USING btree ("source_transaction_signature");--> statement-breakpoint
CREATE INDEX "copyability_token_time_idx" ON "copyability_evaluations" USING btree ("token_mint","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crowding_source_tx_uidx" ON "crowding_observations" USING btree ("source_transaction_signature");--> statement-breakpoint
CREATE INDEX "crowding_token_time_idx" ON "crowding_observations" USING btree ("token_mint","observed_at");--> statement-breakpoint
CREATE INDEX "market_observations_pair_time_idx" ON "market_observations" USING btree ("input_mint","output_mint","received_at");--> statement-breakpoint
CREATE INDEX "wallet_backfill_wallet_time_idx" ON "wallet_backfill_runs" USING btree ("wallet","started_at");