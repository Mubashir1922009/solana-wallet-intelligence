# Security

## Current controls

- Secrets are read from environment variables. `.env` files are ignored and `.env.example` contains placeholders only.
- Helius webhook deliveries support an exact `Authorization` value comparison using constant-length SHA-256 digests.
- HTTP bodies are capped at 1 MiB and validated before processing.
- Provider errors do not include secret-bearing URLs or response bodies.
- API responses never include database, Helius, OpenRouter, or Redis credentials.
- The dashboard receives only its public API base URL.
- No private key, seed phrase, signing code, dynamic code loading, or `eval` exists.
- `LIVE` fails configuration validation and never falls back to paper execution.

## Future live key management

Live wallet signing requires a separate professional architecture and threat-model review before activation. The review must cover isolated signing, least privilege, withdrawal restrictions, transaction simulation, allowlists, rotation, recovery, audit logging, and operator emergency procedures. A private key must never be delivered to browser code, stored in the application database, printed in logs, or placed in ordinary environment files without an explicitly reviewed custody design.

The current `ExecutionProvider` boundary is not an authorization to add a hot key. A future implementation must preserve the central USD limit above the provider and require user authorization for live sells.

## Deployment follow-up

Production deployment still needs authenticated operator access, TLS termination, origin policy, webhook secret rotation, network controls for PostgreSQL/Redis, request rate limiting, dependency scanning, backups, and an incident-response runbook. These are explicit deployment requirements, not features silently approximated in this foundation.
