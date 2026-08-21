# Solana Wallet Intelligence

A strict TypeScript foundation for evaluating whether publicly observable Solana wallet activity remains useful after realistic detection latency, crowding, price impact, fees, and slippage. The current execution path is paper/shadow only. Mainnet signing and live swap broadcasting are intentionally absent.

## Prerequisites

- Node.js 22 or newer (validated here with Node 24.18.0)
- Corepack
- PostgreSQL 16. Redis 7 is optional and never authoritative.

Docker is optional for tests and builds. It is only a convenience for local durable services.

## Setup

```powershell
corepack pnpm@10.15.1 install
Copy-Item .env.example .env
docker compose -f infra/docker-compose.yml up -d
corepack pnpm@10.15.1 db:migrate
corepack pnpm@10.15.1 dev
```

If Docker is unavailable, use a project-scoped PostgreSQL instance. Redis can be omitted.

API: `http://127.0.0.1:4000`

Dashboard: `http://127.0.0.1:3000`

Health: `http://127.0.0.1:4000/health`

`apps/api` owns HTTP/auth/webhooks and `apps/worker` exclusively owns the watcher and durable jobs. Jupiter `AUTO` uses a server API key when configured and otherwise the documented keyless tier with a conservative budget. Provider credentials remain server-side.

The worker acquires a PostgreSQL leadership lease, restores tracked wallets and open-position jobs, reclaims expired job leases, and resumes overdue research. See [RUNTIME.md](./docs/RUNTIME.md) and [DURABILITY.md](./docs/DURABILITY.md).

## Validation

```powershell
corepack pnpm@10.15.1 typecheck
corepack pnpm@10.15.1 lint
corepack pnpm@10.15.1 test
corepack pnpm@10.15.1 db:check
corepack pnpm@10.15.1 build
```

The test suite uses the explicit `InMemoryIntelligenceStore` fixture; production startup constructs `PostgresIntelligenceStore`. Production routes never substitute fixture market data or wallet results.

## Tracking a wallet

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4000/api/wallets/Vote111111111111111111111111111111111111111/track
```

Run a bounded historical import and inspect normalized results:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:4000/api/wallets/Vote111111111111111111111111111111111111111/backfill?limit=100"
Invoke-RestMethod "http://127.0.0.1:4000/api/wallets/Vote111111111111111111111111111111111111111/actions?limit=100"
Invoke-RestMethod "http://127.0.0.1:4000/api/copyability/recent?limit=20"
Invoke-RestMethod "http://127.0.0.1:4000/api/live/status"
Invoke-RestMethod "http://127.0.0.1:4000/api/token-risk/recent?limit=20"
```

Helius webhook authentication is optional for local development, but when `HELIUS_WEBHOOK_AUTH` is set the endpoint requires the exact value in the `Authorization` header. Configure the same `authHeader` value when creating the Helius webhook.

## Safety posture

- `LIVE` configuration fails startup explicitly.
- The hard central trade ceiling is USD 5.00.
- Token quantities use decimal strings and `bigint`, not JavaScript floating point.
- Missing market prices, crowding data, or risk fields remain unknown.
- Jupiter integration requests order quotes without a `taker`; it never requests a transaction, signs, or calls `/execute`.
- A sell recommendation cannot close even a paper position; explicit paper authorization is required.
- OpenRouter is optional and outside ingestion and deterministic decision paths.
- Telegram notification/control requires bot, chat, user, and webhook-secret settings. Callback actions are expiring, one-time, and shadow-only.
- Watcher pause and shadow kill are separate controls: killing shadow entries does not stop position marking, and neither control adds a transaction signer.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [SECURITY.md](./SECURITY.md), [COPYABILITY.md](./docs/COPYABILITY.md), and the documents under `docs/` before extending provider or execution behavior.

Operational commands: `pnpm research:report`, `pnpm shadow:soak -- --duration=10m --wallet-count=5`, `pnpm performance:validate`, `pnpm maintenance:prune-raw` (dry run), and `pnpm secrets:generate <session|telegram-webhook|password-hash>`.
