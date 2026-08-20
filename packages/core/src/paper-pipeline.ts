import type { ClassifiedWalletAction } from "./solana.js";
import type { MarketObservation } from "./market.js";
import { marketQuoteToEntrySnapshot } from "./market.js";
import { evaluateCopyability, type CopyabilityEvaluation, type CopyabilityTimestamps } from "./copyability.js";
import type { PaperPosition, Signal, TradeDecision } from "./domain.js";
import { PaperExecutionService } from "./execution.js";
import type { IntelligenceStore } from "./store.js";

export interface PaperPipelineResult {
  copyability: CopyabilityEvaluation;
  position: PaperPosition | null;
  outcome: "OPENED" | "OBSERVED" | "REJECTED";
  reasonCodes: string[];
}

export class QuoteBasedPaperPipeline {
  private readonly executor: PaperExecutionService;

  constructor(private readonly store: IntelligenceStore, paperTradeUsd: string, maximumTradeUsd: string, maximumQuoteAgeMs: number) {
    this.executor = new PaperExecutionService(store, paperTradeUsd, maximumTradeUsd, maximumQuoteAgeMs);
  }

  async process(signal: Signal, action: ClassifiedWalletAction, decision: TradeDecision, quote: MarketObservation, timestamps: CopyabilityTimestamps): Promise<PaperPipelineResult> {
    await this.store.insertMarketObservation(quote);
    const copyability = evaluateCopyability(action, quote, timestamps, decision.createdAt);
    await this.store.insertCopyabilityEvaluation(copyability);
    await this.store.insertDecision(decision);
    if (decision.decision === "REJECT" || signal.decision === "REJECT") return { copyability, position: null, outcome: "REJECTED", reasonCodes: decision.reasonCodes };
    if (decision.decision !== "BUY" || signal.decision !== "BUY") return { copyability, position: null, outcome: "OBSERVED", reasonCodes: decision.reasonCodes };
    if (copyability.status === "UNKNOWN" || !quote.routeAvailable || action.outputDecimals === null) {
      return { copyability, position: null, outcome: "OBSERVED", reasonCodes: [...decision.reasonCodes, "COPYABILITY_OR_QUOTE_INSUFFICIENT"] };
    }
    const position = await this.executor.openApprovedSignal(signal, decision, { market: marketQuoteToEntrySnapshot(quote), tokenDecimals: action.outputDecimals });
    return { copyability, position, outcome: position === null ? "OBSERVED" : "OPENED", reasonCodes: decision.reasonCodes };
  }
}
