# Research and walk-forward evaluation

Run `pnpm research:report` against the project database. It emits human and JSON output headed `SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS`.

Observations are ordered by signal time. Each rolling window uses only an earlier training interval and reports a subsequent evaluation interval. Discovery/evaluation records persist evidence known at evaluation time; future returns remain separate labels. Reports show sample sizes, decision counts, copyable rate, route availability, valid/no-route/missing outcomes, median/mean follower return, downside median, win rate, approximate drawdown, deterioration, and wallet-score buckets.

Returns are follower quote outcomes, not source-wallet returns or realized fills. `NO_ROUTE` is not a loss, `MISSING_OBSERVATION` is not zero, and organic score is not approval. The command does not optimize weights.
