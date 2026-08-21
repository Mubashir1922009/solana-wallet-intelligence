CREATE TABLE "candidate_evaluations" (
	"wallet" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"sample_size" integer NOT NULL,
	"independent_token_count" integer NOT NULL,
	"provisional_score" double precision,
	"evidence_at_evaluation" jsonb NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"ruleset_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_security_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"session_id" uuid,
	"actor" text NOT NULL,
	"client_label" text,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"client_label" text
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"report" jsonb,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "runtime_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_interactions" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"position_id" uuid NOT NULL,
	"action" text NOT NULL,
	"expected_position_state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"update_id" text
);
--> statement-breakpoint
CREATE TABLE "token_discoveries" (
	"mint" text PRIMARY KEY NOT NULL,
	"first_pool_created_at" timestamp with time zone,
	"symbol" text,
	"name" text,
	"decimals" integer,
	"organic_score" double precision,
	"organic_score_label" text,
	"provider" text NOT NULL,
	"provenance" text NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"provider_observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_leases" (
	"role" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_processed_slot" bigint,
	"active_subscriptions" integer DEFAULT 0 NOT NULL,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"revision" text
);
--> statement-breakpoint
ALTER TABLE "forward_return_observations" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forward_return_observations" ADD COLUMN "lateness_ms" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "response_class" text;--> statement-breakpoint
ALTER TABLE "telegram_interactions" ADD CONSTRAINT "telegram_interactions_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_evaluations_state_score_idx" ON "candidate_evaluations" USING btree ("state","provisional_score");--> statement-breakpoint
CREATE INDEX "operator_security_events_time_idx" ON "operator_security_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "operator_security_events_type_idx" ON "operator_security_events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_sessions_token_hash_uidx" ON "operator_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_sessions_expiry_idx" ON "operator_sessions" USING btree ("expires_at","revoked_at");--> statement-breakpoint
CREATE INDEX "research_runs_kind_time_idx" ON "research_runs" USING btree ("kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_jobs_idempotency_uidx" ON "runtime_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "runtime_jobs_claim_idx" ON "runtime_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "runtime_jobs_lease_idx" ON "runtime_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_interactions_update_uidx" ON "telegram_interactions" USING btree ("update_id");--> statement-breakpoint
CREATE INDEX "telegram_interactions_expiry_idx" ON "telegram_interactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "token_discoveries_pool_time_idx" ON "token_discoveries" USING btree ("first_pool_created_at");--> statement-breakpoint
CREATE INDEX "token_discoveries_observed_idx" ON "token_discoveries" USING btree ("last_observed_at");--> statement-breakpoint
CREATE INDEX "worker_leases_expiry_idx" ON "worker_leases" USING btree ("lease_expires_at");