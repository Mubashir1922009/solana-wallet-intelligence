# Staging deployment checklist

This checklist prepares an operator-managed SHADOW deployment. It does not create infrastructure and does not authorize transaction signing or live-money execution.

## Environment separation

- Use a dedicated staging project and disposable project-owned PostgreSQL database.
- Store secrets only in the platform secret manager; never copy production credentials into staging or expose them through `NEXT_PUBLIC_` variables.
- Set `NODE_ENV=production` and `EXECUTION_MODE=SHADOW`; `LIVE` must continue to fail startup.
- Configure `DATABASE_URL`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`, session/auth values, and allowed dashboard origin separately for staging.
- Set `STAGING_DATABASE_ACK=wallet-intelligence-shadow` only while running the explicitly reviewed durability rehearsal.

## Ordered rollout

1. Run `pnpm resources:check` and review presence-only output.
2. Run `pnpm staging:durability` against the acknowledged staging database.
3. Configure migration execution as a pre-deploy command: `pnpm db:migrate`.
4. Deploy the API and verify `/livez` first, then `/readyz`; readiness must remain false on database/schema failure.
5. Deploy exactly one worker service initially. Confirm `SHADOW_RUNTIME` leadership and `/readyz` before scaling any process.
6. Deploy the dashboard with its staging API origin compiled into `NEXT_PUBLIC_API_URL`.
7. Add optional Redis only after API/worker/database health is established; Redis failure must not replace PostgreSQL authority.
8. Run bounded read-only E2E, research report, and a SHORT STAGING SOAK. Review sanitized artifacts under `runtime/reports/`.

## Service checks

- API: authentication, CSRF, protected SSE, schema revision, database readiness, provider health, runtime-setting mutations.
- Worker: singular leadership, heartbeat, queue claims, restart recovery, provider fallback, no authoritative transitions during database loss.
- Dashboard: RUNNING/PAUSED/KILLED state, database revision, lease, queue, provider status, discovery funnel, positions, and research sample size.
- PostgreSQL: backup policy documented, retention dry-run only, no broad deletion, exact revision `runtime-schema-0006`.
- Redis: optional and non-authoritative.

## Rollback and evidence

- A failed migration or readiness check blocks deployment; do not patch the database manually to make the deployment green.
- Roll back application images without rolling back or deleting schema unless a separately reviewed migration plan exists.
- Preserve sanitized durability, E2E, soak, research, and readiness artifacts.
- A short soak is functional evidence only, not long-term reliability proof.
