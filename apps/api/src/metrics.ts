export class RuntimeCounters {
  private readonly values = new Map<string, number>([
    ["events_received", 0], ["duplicates_ignored", 0], ["events_processed", 0],
    ["normalization_failures", 0], ["signals_generated", 0], ["signals_rejected", 0],
    ["paper_positions_opened", 0], ["provider_errors", 0], ["openrouter_failures", 0]
  ]);

  increment(name: string, amount = 1): void { this.values.set(name, (this.values.get(name) ?? 0) + amount); }
  snapshot(): Record<string, number> { return Object.fromEntries(this.values); }
}
