# Durable runtime

PostgreSQL is the source of truth for jobs, positions, signals, notifications, sessions, security events, discoveries, candidate evaluations, and research runs. Redis is optional and loss of Redis cannot lose authoritative work.

`runtime_jobs` stores type, payload, due time, status, attempts, maximum attempts, lease owner/expiry, timestamps, last sanitized error, and a unique logical key. Workers atomically select due or expired-leased rows inside a transaction with `FOR UPDATE SKIP LOCKED`, increment attempts, and install a lease before work leaves the transaction. Completion and failure require the same lease owner. Transient failure is rescheduled with bounded exponential backoff; exhaustion becomes `FAILED`.

`worker_leases` has one `SHADOW_RUNTIME` row. A second worker cannot start the watcher while the current lease is healthy. Heartbeats expose slot, subscription count, queue depth, revision, and expiry. Stale ownership is reclaimable. On startup the leader schedules missing marks for every open position and claims overdue forward-return jobs at their actual execution time.

Migrations are never auto-run by API replicas. Run `pnpm db:migrate` as a distinct release step. API and worker startup check connectivity and required schema. A missing migration fails readiness/startup.

Raw provider payloads are operational evidence but can dominate storage. `RAW_PAYLOAD_RETENTION_DAYS` defines the review horizon (14 days by default). `pnpm maintenance:prune-raw` is always a dry run; add `-- --apply` only after confirming `DATABASE_URL` is the intended project database. Pruning replaces old transaction/webhook raw JSON with a small tombstone and never deletes normalized transactions, signals, decisions, positions, outcomes, operator actions, or security audits. Archive raw payloads externally before applying when longer forensic retention is required.
