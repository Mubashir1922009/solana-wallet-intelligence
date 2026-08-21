CREATE TABLE "operator_login_buckets" (
	"client_label_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"watcher_enabled" boolean DEFAULT true NOT NULL,
	"shadow_entry_enabled" boolean DEFAULT true NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_revisions" (
	"component" text PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"applied_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operator_login_buckets_updated_idx" ON "operator_login_buckets" USING btree ("updated_at");
--> statement-breakpoint
INSERT INTO "schema_revisions" ("component", "revision", "applied_at") VALUES ('runtime', 'runtime-schema-0004', now());
--> statement-breakpoint
INSERT INTO "runtime_settings" ("key", "watcher_enabled", "shadow_entry_enabled", "kill_switch", "updated_at", "updated_by", "revision") VALUES ('PRIMARY', true, true, false, now(), 'migration:runtime-schema-0004', 1);
