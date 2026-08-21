# Single-operator authentication

This is intentionally single-operator, not general IAM. Generate `OPERATOR_PASSWORD_HASH` with `pnpm secrets:generate password-hash` and `SESSION_SECRET` with `pnpm secrets:generate session`. The password is read without echo and is never persisted or printed.

Passwords use versioned scrypt parameters and per-hash random salt. Login creates 256-bit random session and CSRF values; only HMAC-SHA-256 hashes are stored. The session value is delivered as `HttpOnly; SameSite=Strict`, plus `Secure` in production. The CSRF value is available to the dashboard and is not an authentication credential. Sessions expire, can be revoked by logout, and record conservative client labels.

All strategy API reads and SSE require a session. Mutations additionally require `X-CSRF-Token`. Liveness/readiness and separately authenticated provider webhooks are public exceptions. CORS accepts only loopback development origins and `CORS_ALLOWED_ORIGIN`; wildcard origins are not used. Repeated login failures are bounded and outcomes are audited without passwords or session values.
