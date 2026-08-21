# Data-source classification

`UNKNOWN` is distinct from numeric zero and from `false` throughout the schema.

| Field group | Classification | Current source or derivation |
| --- | --- | --- |
| Signature, slot, block time, fee, status | VERIFIED | Validated standard Solana `getTransaction`; raw response preserved |
| History discovery and pagination | VERIFIED | Standard `getSignaturesForAddress`; optional Helius `getTransactionsForAddress` fallback |
| SOL/SPL wallet deltas | DERIVED | Pre/post balances, fee-payer adjustment, token owner/mint aggregation using `bigint` |
| Buy/sell/transfer/complex classification | DERIVED | Conservative recognized-input asset rules plus stored evidence and ambiguities |
| Token metadata | UNKNOWN until sourced | Decimals may come from balances/quote request; symbol/name provider is not installed |
| Follower quote and route | VERIFIED market observation | Jupiter Swap V2 `/order`, no taker and no transaction request |
| Quote-based paper entry | SIMULATED | Fresh expected output amount; not claimed as a real fill or executable guarantee |
| Copyability price deterioration | DERIVED | Exact source effective-price ratio versus time-stamped follower quote |
| Crowding | DERIVED with coverage | Same-token observed-wallet buys in provisional 5s/30s/60s windows |
| Missing route, time, decimals, or coverage | UNKNOWN/PARTIAL | Explicit reason codes; never converted to zero |
| Wallet score | DERIVED | Provisional deterministic rules and stored ruleset hash |
| AI explanation | ESTIMATED | Optional structured OpenRouter output; never authoritative |
| Recent tradeable token discovery | EXTERNAL_HEURISTIC | Jupiter Tokens V2 `recent`, ordered by first-pool creation; not mint age or safety |
| Organic score/label | EXTERNAL_HEURISTIC | Stored with Jupiter provenance; never overrides internal token, wallet, or crowding rules |

## Official references checked 2026-08-20

- Solana [`getTransaction`](https://solana.com/docs/rpc/http/gettransaction), [`getSignaturesForAddress`](https://solana.com/docs/rpc/http/getsignaturesforaddress), [JSON structures](https://solana.com/docs/rpc/json-structures), and [versioned transactions](https://solana.com/developers/guides/advanced/versions)
- Helius [`getTransactionsForAddress`](https://www.helius.dev/docs/api-reference/rpc/http/gettransactionsforaddress)
- Jupiter [Swap V2](https://developers.jup.ag/docs/swap) and [Tokens V2](https://developers.jup.ag/docs/tokens); this implementation omits `taker`, requires transaction to be null/absent, and never invokes execution or submission

Provider contracts can evolve. Re-verify official schemas before changing request or response fields.
