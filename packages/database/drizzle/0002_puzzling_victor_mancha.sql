CREATE TABLE "candidate_discoveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"reason" text NOT NULL,
	"source_token" text NOT NULL,
	"source_event" text NOT NULL,
	"independent_observation_count" integer NOT NULL,
	"confidence" text NOT NULL,
	"first_discovered_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position_id" uuid NOT NULL,
	"recommendation" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ruleset_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forward_return_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"transaction_signature" text NOT NULL,
	"token_mint" text NOT NULL,
	"window_ms" integer NOT NULL,
	"status" text NOT NULL,
	"entry_market_observation_id" uuid,
	"forward_market_observation_id" uuid,
	"follower_return" double precision,
	"observed_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_subscription_state" (
	"wallet" text PRIMARY KEY NOT NULL,
	"lifecycle" text NOT NULL,
	"priority" integer NOT NULL,
	"provider" text NOT NULL,
	"subscription_healthy" boolean NOT NULL,
	"last_observed_signature" text,
	"last_observed_slot" bigint,
	"last_activity_at" timestamp with time zone,
	"last_successful_ingestion_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position_id" uuid NOT NULL,
	"market_observation_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"estimated_value_usd" numeric,
	"gross_unrealized_pnl_usd" numeric,
	"net_unrealized_pnl_usd" numeric,
	"estimated_fees_usd" numeric,
	"max_favorable_excursion_usd" numeric,
	"max_adverse_excursion_usd" numeric,
	"time_held_ms" integer NOT NULL,
	"quote_age_ms" integer,
	"route_available" boolean NOT NULL,
	"confidence" text NOT NULL,
	"provenance" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_position_records" (
	"position_id" uuid PRIMARY KEY NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_intelligence_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"raw_supply" numeric(78, 0),
	"decimals" integer,
	"supply_slot" bigint,
	"mint_observation" jsonb NOT NULL,
	"concentration" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"completeness" double precision NOT NULL,
	"reasons" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_largest_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"token_account" text NOT NULL,
	"raw_balance" numeric(78, 0) NOT NULL,
	"decimals" integer NOT NULL,
	"percentage_of_supply" numeric,
	"resolved_owner" text,
	"owner_classification" text NOT NULL,
	"slot" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"provenance" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_risk_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"total_risk" double precision NOT NULL,
	"components" jsonb NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"data_completeness" double precision NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"ruleset_hash" text NOT NULL,
	"intelligence_snapshot_id" uuid,
	"market_observation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "wallet_reputation_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "exit_recommendations" ADD CONSTRAINT "exit_recommendations_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_position_records" ADD CONSTRAINT "shadow_position_records_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_largest_accounts" ADD CONSTRAINT "token_largest_accounts_snapshot_id_token_intelligence_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."token_intelligence_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_discoveries_idempotency_uidx" ON "candidate_discoveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "candidate_discoveries_wallet_idx" ON "candidate_discoveries" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "exit_recommendations_position_time_idx" ON "exit_recommendations" USING btree ("position_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forward_return_idempotency_uidx" ON "forward_return_observations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "forward_return_wallet_time_idx" ON "forward_return_observations" USING btree ("wallet","observed_at");--> statement-breakpoint
CREATE INDEX "live_subscription_lifecycle_priority_idx" ON "live_subscription_state" USING btree ("lifecycle","priority");--> statement-breakpoint
CREATE INDEX "position_marks_position_time_idx" ON "position_marks" USING btree ("position_id","observed_at");--> statement-breakpoint
CREATE INDEX "token_intelligence_mint_time_idx" ON "token_intelligence_snapshots" USING btree ("token_mint","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_largest_snapshot_account_uidx" ON "token_largest_accounts" USING btree ("snapshot_id","token_account");--> statement-breakpoint
CREATE INDEX "token_largest_owner_idx" ON "token_largest_accounts" USING btree ("resolved_owner");--> statement-breakpoint
CREATE INDEX "token_risk_evaluation_mint_time_idx" ON "token_risk_evaluations" USING btree ("token_mint","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_reputation_wallet_uidx" ON "wallet_reputation_snapshots" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idempotency_uidx" ON "notifications" USING btree ("idempotency_key");