# Staging resource setup

This project accepts staging credentials only through private environment variables. Create the resources in accounts you control, configure them locally or in the deployment platform's secret store, and do not send credential values to ChatGPT, Codex, source control, logs, screenshots, or issue trackers.

Run `pnpm resources:check` at any time. It performs no network requests and prints presence/readiness only; it never prints an environment-variable value.

## Disposable project staging PostgreSQL

Create or designate a PostgreSQL database that is disposable, project-owned, and dedicated to this project's staging rehearsal where possible. It must support normal transactions, row-level locks, and `FOR UPDATE SKIP LOCKED`. Use SSL for a remote database and a scoped database name such as `wallet_intelligence_staging`, not a default database such as `postgres`.

The database role must be able to create the project's tables, indexes, foreign keys, and constraints. It does not need server-wide administration rights. Do not create a resource through Codex and do not install local database software for this milestone.

Configure these variables privately:

```text
DATABASE_URL=<secret PostgreSQL connection string>
STAGING_DATABASE_ACK=wallet-intelligence-shadow
```

Set the acknowledgement only after verifying that the URL identifies the disposable project staging database. Never commit `DATABASE_URL`; `.env.example` contains placeholders only.

PowerShell session example:

```powershell
$env:DATABASE_URL = "<secret PostgreSQL connection string>"
$env:STAGING_DATABASE_ACK = "wallet-intelligence-shadow"
pnpm resources:check
```

POSIX shell example:

```sh
export DATABASE_URL='<secret PostgreSQL connection string>'
export STAGING_DATABASE_ACK='wallet-intelligence-shadow'
pnpm resources:check
```

## Helius read-only RPC

Create a Helius API key in your own Helius account. The project expects the key server-side through `HELIUS_API_KEY`; it must never be exposed through a `NEXT_PUBLIC_` variable or embedded in checked-in URLs.

The current provider accepts the credential separately from the RPC base URL:

```text
HELIUS_API_KEY=<secret>
HELIUS_RPC_URL=https://mainnet.helius-rpc.com
```

The standard Helius base URL is already the application default. Set `HELIUS_RPC_URL` only when a different server-side RPC base URL is intentionally required. Application logs and reports must not contain a credential-bearing query string. This milestone uses Helius only for bounded reads; transaction submission is prohibited.

## Optional for current milestone

None of these variables is required for the PostgreSQL/Helius evidence milestone:

- `JUPITER_API_KEY`: optional authenticated Jupiter quote/discovery access.
- `TELEGRAM_BOT_TOKEN`: optional Telegram fixture-to-live notification configuration.
- `TELEGRAM_CHAT_ID`: optional; required together with all Telegram variables for live notification validation.
- `TELEGRAM_USER_ID`: optional authorized Telegram operator identity.
- `TELEGRAM_WEBHOOK_SECRET`: optional Telegram webhook verification secret.
- `OPENROUTER_API_KEY`: optional secondary analysis; deterministic logic remains authoritative.
- `REDIS_URL`: optional Redis health/cache integration.
- `SOLANA_RPC_URL`: standard read-only Solana HTTP fallback.
- `SOLANA_WS_URL`: standard read-only Solana WebSocket fallback.

Free or existing suitable plans are acceptable; this setup does not require a paid tier.

## Readiness workflow

1. Configure secrets privately in the local shell or deployment secret store.
2. Run `pnpm resources:check` and confirm `RESOURCE_PATH: FULL` and `FULL_STAGING_REHEARSAL: READY` for the complete milestone.
3. Run `pnpm staging:verify --preflight` for a no-database harness check.
4. Only after independently confirming the database identity and acknowledgement, run `pnpm staging:verify`.

The staging verifier refuses missing acknowledgement and default/unscoped database names. It does not authorize live-money execution.
