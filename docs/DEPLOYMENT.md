# Remote shadow deployment

Recommended topology: dashboard, API, one worker, PostgreSQL, and optional Redis. Run migration once before starting services. The API exposes `/livez` and `/readyz`; worker health is its PostgreSQL heartbeat surfaced by the API/dashboard.

Required production variables: `NODE_ENV=production`, `EXECUTION_MODE=SHADOW`, `DATABASE_URL`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, and `CORS_ALLOWED_ORIGIN`. Optional groups: `REDIS_URL`; Helius values; `JUPITER_API_KEY` plus `JUPITER_AUTH_MODE`; OpenRouter values; and all four Telegram values. `EXECUTION_MODE=LIVE` always fails.

`infra/Dockerfile.api`, `.worker`, and `.dashboard` use deterministic pnpm installs, multi-stage builds, non-root runtimes, and no baked secrets. The dashboard enables Next standalone output only inside its Linux container build (`BUILD_STANDALONE=true`); this avoids requiring privileged symlink creation for ordinary Windows validation. Docker was not installed by this implementation task; actual image builds require CI validation.

For Railway, create services only with explicit operator authorization. Point each service at its Dockerfile, reference managed PostgreSQL `DATABASE_URL`, optionally reference Redis `REDIS_URL`, set API health to `/readyz`, and use private networking. Railway detects Dockerfiles and health checks wait for a healthy response; Compose `depends_on` has no Railway equivalent, so startup checks remain application responsibilities. See [Railway Docker Compose guidance](https://docs.railway.com/guides/docker-compose) and [health checks](https://docs.railway.com/deployments/healthchecks).

No cloud project, database, Redis instance, bot, or provider account is created by repository preparation.
