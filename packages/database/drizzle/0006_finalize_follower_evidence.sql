-- Finalize the follower-evidence schema as the authoritative runtime revision.
-- This migration is intentionally additive so an already-applied 0005 remains safe.

CREATE INDEX IF NOT EXISTS "forward_return_source_event_idx" ON "forward_return_observations" USING btree ("source_event_id");
CREATE INDEX IF NOT EXISTS "follower_source_status_time_idx" ON "follower_source_events" USING btree ("status", "source_observed_at");

INSERT INTO "schema_revisions" ("component", "revision", "applied_at")
VALUES ('runtime', 'runtime-schema-0006', now())
ON CONFLICT ("component") DO UPDATE
SET "revision" = EXCLUDED."revision", "applied_at" = EXCLUDED."applied_at";
