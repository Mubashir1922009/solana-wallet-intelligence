# Copyability semantics

Copyability asks a narrow question: after a source wallet's successful candidate buy becomes observable and the pipeline obtains a follower quote, how much worse or better is the follower's effective entry?

For both source and follower, effective price is input tokens per output token. The engine computes this from raw base units and mint decimals with `bigint` rational arithmetic. It does not convert amounts through JavaScript floating point. Positive deterioration basis points mean the follower pays more input per output than the source; improvement is stored separately and never hidden inside a negative deterioration value.

The evaluation stores source block time, transaction observation, normalization, signal, decision, quote request/receipt, provider latency, and total follower latency where available. `KNOWN` means compatible source and quote amounts can be compared. `PARTIAL` means price comparison is available but timing is incomplete. `UNKNOWN` means a required route, amount, decimal, classification, or asset match is absent.

This is an observation, not a fill claim. Jupiter `/order` without a taker supplies market quote data only. Route availability and price impact can change before any future transaction is built, signed, landed, and confirmed.

Anti-crowding is complementary. It counts observed monitored wallets buying the same token in provisional 5s/30s/60s windows, stores coverage, and distinguishes no observed followers from unknown observation coverage. Thresholds are explicitly provisional until calibrated on replay data.
