import type {
  ChainTransaction,
  PaperPosition,
  PositionEvent,
  Signal,
  TradeDecision,
  UserAction,
  Wallet,
  WalletMetrics,
  WalletStatus,
  WalletAction
} from "./domain.js";
import type { WalletBackfillRun } from "./domain.js";
import type { CopyabilityEvaluation } from "./copyability.js";
import type { CrowdingObservation } from "./crowding.js";
import type { MarketObservation } from "./market.js";

export interface IntelligenceStore {
  upsertWallet(publicKey: string, now: string): Promise<Wallet>;
  getWallet(publicKey: string): Promise<(Wallet & { metrics: WalletMetrics | null }) | null>;
  listWallets(): Promise<Array<Wallet & { metrics: WalletMetrics | null }>>;
  setWalletStatus(publicKey: string, status: WalletStatus, now: string): Promise<Wallet | null>;
  upsertWalletMetrics(metrics: WalletMetrics): Promise<void>;
  insertTransaction(transaction: ChainTransaction): Promise<"inserted" | "duplicate">;
  getTransaction(signature: string): Promise<ChainTransaction | null>;
  insertWalletAction(action: WalletAction): Promise<"inserted" | "duplicate">;
  listWalletActions(publicKey: string, limit: number): Promise<WalletAction[]>;
  insertSignal(signal: Signal): Promise<"inserted" | "duplicate">;
  getSignal(id: string): Promise<Signal | null>;
  listSignals(): Promise<Signal[]>;
  insertMarketObservation(observation: MarketObservation): Promise<void>;
  getMarketObservation(id: string): Promise<MarketObservation | null>;
  insertCopyabilityEvaluation(evaluation: CopyabilityEvaluation): Promise<"inserted" | "duplicate">;
  getCopyabilityBySourceTransaction(signature: string): Promise<CopyabilityEvaluation | null>;
  listRecentCopyability(limit: number): Promise<CopyabilityEvaluation[]>;
  insertCrowdingObservation(observation: CrowdingObservation): Promise<"inserted" | "duplicate">;
  insertBackfillRun(run: WalletBackfillRun): Promise<void>;
  insertDecision(decision: TradeDecision): Promise<void>;
  createPosition(position: PaperPosition): Promise<"inserted" | "duplicate">;
  getPosition(id: string): Promise<PaperPosition | null>;
  getPositionBySignal(signalId: string): Promise<PaperPosition | null>;
  listPositions(): Promise<PaperPosition[]>;
  updatePosition(position: PaperPosition): Promise<void>;
  appendPositionEvent(event: PositionEvent): Promise<"inserted" | "duplicate">;
  appendUserAction(action: UserAction): Promise<void>;
  listRecentEvents(limit: number): Promise<PositionEvent[]>;
}
