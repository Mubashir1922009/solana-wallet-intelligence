ALTER TYPE "public"."wallet_status" ADD VALUE IF NOT EXISTS 'research_watch';

ALTER TABLE "wallet_backfill_runs" ADD COLUMN "request_before" text;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "continuation_cursor" text;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "last_processed_signature" text;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "last_processed_slot" bigint;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "last_processed_at" timestamp with time zone;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "completeness_state" text DEFAULT 'UNKNOWN' NOT NULL;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "attempt_count" integer DEFAULT 1 NOT NULL;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "last_error_class" text;
ALTER TABLE "wallet_backfill_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

CREATE TABLE "follower_source_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_wallet" text NOT NULL,
  "source_transaction" text NOT NULL,
  "token_mint" text NOT NULL,
  "source_block_time" timestamp with time zone,
  "source_observed_at" timestamp with time zone NOT NULL,
  "decision_evidence_at" timestamp with time zone NOT NULL,
  "entry_market_observation_id" uuid,
  "copyability_evaluation_id" uuid,
  "status" text NOT NULL,
  "source_effective_entry" text,
  "follower_quoted_entry" text,
  "route_available" boolean,
  "quote_requested_at" timestamp with time zone,
  "quote_received_at" timestamp with time zone,
  "quote_latency_ms" integer,
  "price_impact_pct" text,
  "data_completeness" double precision NOT NULL,
  "provider_provenance" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX "follower_source_tx_uidx" ON "follower_source_events" USING btree ("source_transaction");
CREATE UNIQUE INDEX "follower_source_idempotency_uidx" ON "follower_source_events" USING btree ("idempotency_key");
CREATE INDEX "follower_source_wallet_time_idx" ON "follower_source_events" USING btree ("source_wallet", "source_observed_at");

ALTER TABLE "forward_return_observations" ADD COLUMN "source_event_id" uuid;
ALTER TABLE "forward_return_observations" ADD COLUMN "data_completeness" double precision DEFAULT 0 NOT NULL;
ALTER TABLE "forward_return_observations" ADD COLUMN "provider_provenance" text;
ALTER TABLE "forward_return_observations" ADD COLUMN "estimated_net_return" double precision;
