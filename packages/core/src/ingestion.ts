import { newId } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { ChainTransaction } from "./domain.js";
import type { IntelligenceStore } from "./store.js";

export interface ProviderTransactionEnvelope {
  signature: string;
  slot: bigint;
  blockTime: string | null;
  status: "succeeded" | "failed" | "unknown";
  feeLamports: bigint | null;
  provider: string;
  rawPayload: JsonValue;
  relevantWallets: string[];
  receivedAt: string;
}

export interface IngestionResult {
  eventId: string;
  signature: string;
  outcome: "accepted" | "duplicate";
}

export class TransactionIngestionService {
  constructor(private readonly store: IntelligenceStore) {}

  async ingest(envelope: ProviderTransactionEnvelope): Promise<IngestionResult> {
    const completedAt = new Date().toISOString();
    const latency = envelope.blockTime === null ? null : Math.max(0, Date.parse(envelope.receivedAt) - Date.parse(envelope.blockTime));
    const transaction: ChainTransaction = {
      ...envelope,
      observedAt: envelope.receivedAt,
      providerReceivedAt: envelope.receivedAt,
      normalizationCompletedAt: completedAt,
      ingestionLatencyMs: Number.isFinite(latency) ? latency : null,
      tokenBalanceDeltas: [],
      nativeBalanceDeltas: []
    };
    const outcome = await this.store.insertTransaction(transaction);
    return { eventId: newId(), signature: envelope.signature, outcome: outcome === "inserted" ? "accepted" : "duplicate" };
  }
}
