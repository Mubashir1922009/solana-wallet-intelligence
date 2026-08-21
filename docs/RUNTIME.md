# Continuous Shadow Runtime

## Runtime flow

The production worker uses standard Solana WebSocket `logsSubscribe` as its default live source; API replicas never start watchers. Each active wallet receives one logical subscription. A notification contains only a signature and slot, so the coordinator fetches the full transaction through the configured chain provider, normalizes it with the same deterministic path as historical backfill, classifies it, and persists both the chain record and wallet action idempotently.

Candidate buys then pass through wallet scoring, exact token-supply and largest-token-account observation, resolved-owner aggregation, provisional token-risk rules, a fresh Jupiter quote, copyability, and live crowding. The decision is explicitly `BUY`, `OBSERVE`, or `REJECT`. Only `BUY` can open a shadow/paper position, and the full input snapshots and latency record are stored with it.

No signer, private key, transaction builder, Jupiter execute call, or Solana broadcast call exists in this runtime.

## Subscription lifecycle and gaps

`MAX_LIVE_SUBSCRIPTIONS` bounds active subscriptions. Tracked wallets outside capacity remain durably `QUEUED_CAPACITY`; paused and rejected wallets remain explicitly distinct. Priority selection is deterministic.

The watcher reconnects with capped exponential backoff and jitter. After connection restoration it resubscribes desired wallets and recovers each gap using the durable last-observed signature as the history boundary. Transaction and wallet-action uniqueness constraints make overlap safe. Liveness timeouts close an unresponsive socket and enter the same reconnect path.

`LIVE_PROVIDER_MODE=HELIUS_WEBHOOK` selects the optional webhook adapter. Helius webhook authentication should be configured with `HELIUS_WEBHOOK_AUTH`. Standard WebSocket remains the default and requires no provider API key.

## Token intelligence and risk

Supply and raw balances remain `bigint` in application memory and `numeric(78,0)` or `bigint` in PostgreSQL. Concentration distinguishes token accounts from resolved owners. The standard RPC largest-accounts endpoint covers at most 20 token accounts, so the result is an observed concentration window, not a claim about all holders.

Token-2022 mints are identified, but extension interpretation is explicitly `UNKNOWN_UNSUPPORTED`. Unknown authority, concentration, route, impact, and data-quality inputs receive conservative provisional risk rather than being treated as safe. Every evaluation stores components, weights, contributions, reason codes, confidence, completeness, and ruleset hash.

## Position and exit monitoring

Open positions receive fresh quote-only marks. Marks persist value, gross and net P/L when supported by evidence, fee estimate, MFE, MAE, hold time, quote age, route state, confidence, and provenance. Missing routes or prices remain unknown.

Exit recommendations are transparent and never execute a sell. Inputs include adverse movement, source-wallet partial/full sells, transfers, route loss, token-risk deterioration, and position age. Manual control is an audited position state; restoring system control is also audited. Only the explicit paper-sell endpoint closes a simulated position.

## Controls and observability

- `POST /api/runtime/watcher/pause` and `/resume` control ingestion processing.
- `POST /api/runtime/shadow/kill` and `/restore` block or restore new shadow entries while position monitoring continues.
- `GET /api/live/status` exposes watcher/subscription and provider-budget state.
- `GET /api/stream` emits periodic Server-Sent Event snapshots for the dashboard.
- `GET /api/positions/:id/intelligence` returns context, marks, exit recommendations, and events.

The runtime limits provider concurrency, deduplicates equal in-flight calls, caches token observations briefly, retries bounded retryable failures with exponential backoff and jitter, and exposes calls, 429s, timeouts, retries, queue wait, average latency, in-flight work, queued work, and degradation state.

## Discovery and research labels

Discovery is deliberately limited to evidence present in transactions the system already observes. A previously unknown co-signer must recur across independently observed token events before being persisted as a candidate; candidate status is not trust or a claim of special identity. It must still undergo backfill and scoring before tracking.

For observed candidate buys, `FORWARD_RETURN_WINDOWS_MS` creates PostgreSQL jobs for quote-based research observations. Each window persists `VALID_OBSERVATION`, `NO_ROUTE`, or `MISSING_OBSERVATION`; missing quotes never become zero returns. These labels update a provisional wallet-reputation snapshot in which capped follower returns carry more weight than copyability and crowding inputs. Requested time, actual observation time, and lateness are distinct; expired job leases are reclaimed after a crash.

The soak harness defaults to the in-memory contract when a project database is unavailable. `pnpm shadow:soak -- --store=in-memory --duration=2m --max-wallets=1 --wallets=<public-key>` validates transport liveness. `pnpm shadow:soak -- --store=in-memory --duration=5m --full --max-wallets=3 --max-recent-tokens=3 --provider-budget=20` adds bounded real discovery, history, normalization, token-risk, quote, and decision stages. A future staging multi-hour command is `pnpm shadow:soak -- --store=postgres --duration=6h --full --max-wallets=20 --max-recent-tokens=5 --provider-budget=100`; it writes periodic snapshots to ignored `runtime/reports/shadow-soak-latest.json`. Do not infer long-term stability from a short run.

Run the bounded mainnet read-only rehearsal with `pnpm shadow:e2e -- --mode=recent-token-research --max-recent-tokens=3 --max-candidates-per-token=2 --history-transactions=5 --duration-seconds=300`. It never forces BUY; OBSERVE/REJECT and zero positions are valid. Evidence is written beneath ignored `runtime/reports/`.

## Operator expectations

Run migrations before startup. PostgreSQL is required and Redis is optional; tests use the explicit in-memory store. Jupiter `AUTO` uses a key when present and keyless otherwise. OpenRouter remains optional and non-authoritative.
