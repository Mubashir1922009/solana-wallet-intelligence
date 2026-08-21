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
- Operator passwords use versioned scrypt hashes. Random session and CSRF tokens are HMAC-hashed at rest; the session token is only in an HttpOnly, Strict, production-Secure cookie.
- Login failures, session rejection, CSRF rejection, logout, dashboard actions, and Telegram actions are durably audited without credential values.
- Strategy APIs and SSE require the single-operator session. State changes additionally require the session-bound CSRF header.
- Telegram webhooks require the official secret header plus configured chat and user identity; callback nonces expire and are single-use.

## Future live key management

Live wallet signing requires a separate professional architecture and threat-model review before activation. The review must cover isolated signing, least privilege, withdrawal restrictions, transaction simulation, allowlists, rotation, recovery, audit logging, and operator emergency procedures. A private key must never be delivered to browser code, stored in the application database, printed in logs, or placed in ordinary environment files without an explicitly reviewed custody design.

The current `ExecutionProvider` boundary is not an authorization to add a hot key. A future implementation must preserve the central USD limit above the provider and require user authorization for live sells.

## Deployment follow-up

Production still requires TLS termination, database backup/restore drills, private networking, secret rotation, monitoring, and an incident-response runbook. Application authentication, origin policy, headers, login limiting, and webhook validation do not replace infrastructure controls.
