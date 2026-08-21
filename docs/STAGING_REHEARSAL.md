# Staging PostgreSQL rehearsal

Use only a PostgreSQL database explicitly created or designated for this project’s staging environment. The verifier refuses default database names, requires an acknowledgement, never prints credentials, never drops a database or unrelated schema, and cleans only namespaced rehearsal records.

No-database harness preflight:

```powershell
pnpm staging:verify --preflight
```

Real staging verification in PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:PORT/PROJECT_STAGING_DATABASE"
$env:STAGING_DATABASE_ACK = "wallet-intelligence-shadow"
pnpm staging:verify
```

POSIX shell:

```sh
DATABASE_URL='postgresql://USER:PASSWORD@HOST:PORT/PROJECT_STAGING_DATABASE' \
STAGING_DATABASE_ACK='wallet-intelligence-shadow' \
pnpm staging:verify
```

The workflow checks connectivity/version, applies outstanding Drizzle migrations once, validates the authoritative schema revision, and rehearses writes, idempotency, atomic claims, ownership, expired takeover, retry, worker leadership, session persistence, durable scheduling, notification recovery, and restart recovery. Migration failure exits nonzero and must block API/worker deployment. Configure Railway’s pre-deploy command as `pnpm db:migrate`; API and worker readiness independently require the exact revision. Keep PostgreSQL on Railway private networking; do not expose it publicly merely for co-located services.
