# Backup and recovery

PostgreSQL is authoritative for wallets, evidence, decisions, positions, jobs, runtime controls, sessions, notifications, and audit events. Runtime JSON reports are supporting evidence, not a database backup.

Before a risky migration, the operator must create and verify a provider-supported backup. Paid backup products are not configured automatically. Record the backup identifier outside source control without credentials, run the migration once through the deployment pre-deploy step, and confirm `/readyz` reports the expected revision.

A restore rehearsal must use an isolated project staging database: restore the backup, run `pnpm staging:verify`, compare row counts and the authoritative schema revision, verify open positions and pending jobs recover, then destroy the isolated environment through the provider’s authorized operator workflow. Never rehearse by overwriting production.

Security events and user actions are audit data and must not be removed by raw-payload retention. Research exports exclude secrets and authentication/session hashes. Raw provider payloads may be pruned under the documented retention policy; positions, decisions, evaluations, copyability evidence, user actions, and required audit events remain durable.
