Solana wallet intelligence live-ingestion timeout hotfix

Fixes:
- A transient getTransaction timeout from a WebSocket notification no longer terminates the worker.
- Failed live-event processing is recorded in provider health and schedules a durable GAP_RECOVERY job keyed by wallet+signature.
- Reconnect-recovery callback rejection is contained instead of becoming an unhandled promise rejection.
- Adds regression coverage for a TIMEOUT event-handler failure while the WebSocket remains connected.

No private-key, signing, broadcast, execute, submit, sendTransaction, or sendRawTransaction path is added.
