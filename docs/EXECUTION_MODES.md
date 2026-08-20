# Execution modes

## PAPER

Creates persistent simulated positions only after a deterministic `BUY` and either a verified observed price or a fresh Jupiter quote matching the configured input amount. A quote-based position uses expected output base units, records quote age, and keeps USD price/P&L unknown when Jupiter did not return those fields. The default amount is USD 1.00. The configured amount cannot exceed the central maximum, and the maximum itself cannot exceed USD 5.00.

Exit recommendations only change recommendation/state data. `WAIT` leaves the position open. `authorize-paper-sell` records a user action and position events before closing the simulated position.

## SHADOW

Accepted as configuration for evaluation without funds. The current API exposes the mode but does not yet schedule shadow quotes or create shadow-specific position records. This behavior is deliberately incomplete and must be implemented before shadow performance claims are made.

## LIVE

Non-functional by design. Configuration parsing throws: `LIVE execution is disabled: no reviewed live execution provider is installed`.

The current Jupiter provider cannot build or execute. It omits `taker`, rejects transaction-bearing payloads, and never calls `/execute`. A future live buy provider must use the shared execution interface, cannot bypass the central USD cap, and must notify only after a confirmed successful buy. A future live sell requires explicit user authorization. Signing/custody requires a separate security review before any activation.
