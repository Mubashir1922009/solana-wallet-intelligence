# Provisional scoring

The baseline engine is deterministic and configuration-driven. It is scaffolding for evaluation, not a scientifically validated claim about wallet intent or identity.

Positive bounded components are performance quality, consistency, early-entry quality, latency-adjusted copyability, and data confidence. Negative bounded components are crowding, estimated follower slippage, suspicious coordination, inadequate sample size, and stale activity. Every component stores value, weight, contribution, and whether its source was observed, derived, or an unknown default.

Unknown positive metrics receive a conservative provisional default of `0.35`; they never receive perfect credit. Unknown penalties remain unknown at the data-model layer and currently contribute no unsupported penalty, while the score records `UNKNOWN_METRICS_PRESENT`. This distinction prevents unknown values from being presented as observed zeroes.

Sample confidence shrinks linearly until 20 observations. Performance quality weights the median return at 75% and a capped average return at 25%, preventing one extreme profitable outlier from dominating the wallet score. All values remain bounded to `[0, 1]`, and the total is bounded to `[0, 100]`.

Copyability now compares the source wallet's effective input/output ratio with a time-stamped follower quote using integer rational arithmetic. It records deterioration and improvement separately plus detection, normalization, decision, quote, and total follower latency. Missing route, amount, decimal, or timestamp data yields `UNKNOWN` or `PARTIAL`, never an invented score.

Candidate promotion uses the separate follower-reputation snapshot: capped and median follower returns dominate the provisional score, while valid copyability and observed crowding provide smaller bounded components. A wallet needs at least eight valid outcome samples across at least three independent tokens, a provisional score of 62, and crowding frequency no greater than 0.45. These are provisional research thresholds, not claims of profitability, and every evaluation persists reason codes plus the evidence known at that time.

Crowding observations count distinct monitored wallets and actions buying the same output token after the source transaction in provisional 5-second, 30-second, and 60-second windows. Raw volume is summed only when input assets are compatible. Coverage and confidence are stored with each observation. Crowding is a risk proxy only; it does not prove manipulation, identity, or intent.
