import { z } from "zod";

export type LiveProviderMode = "STANDARD_WS" | "HELIUS_WEBHOOK" | "HYBRID";
export interface LiveChainEvent { wallet: string; signature: string; slot: bigint; succeeded: boolean; receivedAt: string; provider: string }
export interface LiveConnectionSnapshot {
  mode: LiveProviderMode;
  provider: string;
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "SHUTDOWN";
  activeSubscriptions: number;
  desiredSubscriptions: number;
  lastEventAt: string | null;
  lastObservedSlot: bigint | null;
  reconnectCount: number;
  malformedMessages: number;
  duplicateNotifications: number;
  lastError: string | null;
}

export interface LiveChainEventProvider {
  readonly mode: LiveProviderMode;
  readonly name: string;
  connect(): Promise<void>;
  subscribe(wallet: string): Promise<boolean>;
  unsubscribe(wallet: string): Promise<void>;
  shutdown(): Promise<void>;
  snapshot(): LiveConnectionSnapshot;
}

interface WebSocketMessageEvent { data: unknown }
interface WebSocketCloseEvent { code?: number; reason?: string }
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEvent) => void): void;
}

const notificationSchema = z.object({
  jsonrpc: z.literal("2.0"), method: z.literal("logsNotification"), params: z.object({
    subscription: z.number().int().nonnegative(), result: z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.object({ signature: z.string().min(32), err: z.unknown().nullable(), logs: z.array(z.string()) }) })
  })
});
const responseSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number().int().positive(), result: z.union([z.number().int().nonnegative(), z.boolean()]) });
const errorSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number().int().positive().optional(), error: z.object({ code: z.number(), message: z.string() }) });

interface PendingRequest { operation: "subscribe" | "unsubscribe"; wallet: string }
export interface StandardSolanaLiveOptions {
  wsUrl: string;
  maximumSubscriptions: number;
  commitment?: "confirmed" | "finalized";
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  reconnectJitterRatio?: number;
  livenessTimeoutMs?: number;
  websocketFactory?: (url: string) => WebSocketLike;
  onEvent: (event: LiveChainEvent) => Promise<void> | void;
  onReconnect?: (wallets: string[]) => Promise<void> | void;
  onStatus?: (snapshot: LiveConnectionSnapshot) => void;
  random?: () => number;
}

export class StandardSolanaLiveChainProvider implements LiveChainEventProvider {
  readonly mode = "STANDARD_WS" as const;
  readonly name = "standard-solana-websocket";
  private socket: WebSocketLike | null = null;
  private status: LiveConnectionSnapshot["status"] = "DISCONNECTED";
  private readonly desired = new Set<string>();
  private readonly subscriptionByWallet = new Map<string, number>();
  private readonly walletBySubscription = new Map<number, string>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly seen = new Set<string>();
  private requestId = 0;
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private lastEventAt: string | null = null;
  private lastObservedSlot: bigint | null = null;
  private malformedMessages = 0;
  private duplicateNotifications = 0;
  private lastError: string | null = null;
  private intentionalShutdown = false;

  constructor(private readonly options: StandardSolanaLiveOptions) {}

  connect(): Promise<void> {
    if (this.status === "CONNECTED") return Promise.resolve();
    this.intentionalShutdown = false;
    this.status = "CONNECTING";
    this.emitStatus();
    return new Promise((resolve, reject) => {
      const factory = this.options.websocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
      const socket = factory(this.options.wsUrl);
      this.socket = socket;
      let settled = false;
      socket.addEventListener("open", () => {
        this.status = "CONNECTED";
        this.lastMessageAt = Date.now();
        this.lastError = null;
        this.startLiveness();
        const reconnecting = this.reconnectCount > 0;
        this.subscriptionByWallet.clear();
        this.walletBySubscription.clear();
        this.pending.clear();
        for (const wallet of this.desired) this.sendSubscribe(wallet);
        this.emitStatus();
        if (reconnecting) void this.options.onReconnect?.([...this.desired]);
        if (!settled) { settled = true; resolve(); }
      });
      socket.addEventListener("message", (event) => { void this.handleMessage(event.data); });
      socket.addEventListener("error", () => {
        this.lastError = "websocket_error";
        this.emitStatus();
        if (!settled) { settled = true; reject(new Error("Solana WebSocket connection failed")); }
      });
      socket.addEventListener("close", (event) => {
        this.stopLiveness();
        this.socket = null;
        this.status = this.intentionalShutdown ? "SHUTDOWN" : "DISCONNECTED";
        this.lastError = event.reason ?? this.lastError;
        this.emitStatus();
        if (!this.intentionalShutdown) this.scheduleReconnect();
      });
    });
  }

  async subscribe(wallet: string): Promise<boolean> {
    const alreadyDesired = this.desired.has(wallet);
    if (!alreadyDesired && this.desired.size >= this.options.maximumSubscriptions) return false;
    this.desired.add(wallet);
    if (this.status === "CONNECTED" && !alreadyDesired && !this.subscriptionByWallet.has(wallet)) this.sendSubscribe(wallet);
    this.emitStatus();
    return true;
  }

  async unsubscribe(wallet: string): Promise<void> {
    this.desired.delete(wallet);
    const subscription = this.subscriptionByWallet.get(wallet);
    if (subscription !== undefined && this.status === "CONNECTED") {
      const id = this.nextRequestId();
      this.pending.set(id, { operation: "unsubscribe", wallet });
      this.send({ jsonrpc: "2.0", id, method: "logsUnsubscribe", params: [subscription] });
    }
    this.subscriptionByWallet.delete(wallet);
    if (subscription !== undefined) this.walletBySubscription.delete(subscription);
    this.emitStatus();
  }

  async shutdown(): Promise<void> {
    this.intentionalShutdown = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopLiveness();
    this.status = "SHUTDOWN";
    this.socket?.close(1000, "shutdown");
    this.socket = null;
    this.emitStatus();
  }

  snapshot(): LiveConnectionSnapshot {
    return { mode: this.mode, provider: this.name, status: this.status, activeSubscriptions: this.subscriptionByWallet.size, desiredSubscriptions: this.desired.size, lastEventAt: this.lastEventAt, lastObservedSlot: this.lastObservedSlot, reconnectCount: this.reconnectCount, malformedMessages: this.malformedMessages, duplicateNotifications: this.duplicateNotifications, lastError: this.lastError };
  }

  private sendSubscribe(wallet: string): void {
    const id = this.nextRequestId();
    this.pending.set(id, { operation: "subscribe", wallet });
    this.send({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [wallet] }, { commitment: this.options.commitment ?? "confirmed" }] });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify(payload));
  }

  private async handleMessage(raw: unknown): Promise<void> {
    this.lastMessageAt = Date.now();
    let payload: unknown;
    try { payload = JSON.parse(typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw)); }
    catch { this.malformedMessages += 1; this.emitStatus(); return; }
    const notification = notificationSchema.safeParse(payload);
    if (notification.success) {
      const wallet = this.walletBySubscription.get(notification.data.params.subscription);
      if (wallet === undefined) { this.malformedMessages += 1; this.emitStatus(); return; }
      const value = notification.data.params.result.value;
      const duplicateKey = `${wallet}:${value.signature}`;
      if (this.seen.has(duplicateKey)) { this.duplicateNotifications += 1; this.emitStatus(); return; }
      this.seen.add(duplicateKey);
      if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value ?? "");
      const receivedAt = new Date().toISOString();
      this.lastEventAt = receivedAt;
      this.lastObservedSlot = BigInt(notification.data.params.result.context.slot);
      await this.options.onEvent({ wallet, signature: value.signature, slot: this.lastObservedSlot, succeeded: value.err === null, receivedAt, provider: this.name });
      this.emitStatus();
      return;
    }
    const response = responseSchema.safeParse(payload);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      this.pending.delete(response.data.id);
      if (pending?.operation === "subscribe" && typeof response.data.result === "number") {
        this.subscriptionByWallet.set(pending.wallet, response.data.result);
        this.walletBySubscription.set(response.data.result, pending.wallet);
      }
      this.emitStatus();
      return;
    }
    const rpcError = errorSchema.safeParse(payload);
    if (rpcError.success) { this.lastError = `${rpcError.data.error.code}:${rpcError.data.error.message}`; this.emitStatus(); return; }
    this.malformedMessages += 1;
    this.emitStatus();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectCount += 1;
    const base = this.options.reconnectBaseMs ?? 500;
    const cap = this.options.reconnectCapMs ?? 30_000;
    const jitter = this.options.reconnectJitterRatio ?? 0.2;
    const raw = Math.min(cap, base * 2 ** Math.min(10, this.reconnectCount - 1));
    const random = this.options.random ?? Math.random;
    const delay = Math.max(0, Math.round(raw * (1 - jitter + 2 * jitter * random())));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect().catch(() => undefined); }, delay);
  }

  private startLiveness(): void {
    this.stopLiveness();
    const timeout = this.options.livenessTimeoutMs ?? 45_000;
    this.livenessTimer = setInterval(() => {
      const silenceMs = this.lastMessageAt === 0 ? 0 : Date.now() - this.lastMessageAt;
      if (silenceMs > timeout) {
        this.lastError = "liveness_timeout";
        this.socket?.close(4000, "liveness_timeout");
      } else if (silenceMs > timeout / 2) {
        this.send({ jsonrpc: "2.0", id: this.nextRequestId(), method: "getSlot", params: [{ commitment: this.options.commitment ?? "confirmed" }] });
      }
    }, Math.max(1_000, Math.floor(timeout / 3)));
  }

  private stopLiveness(): void { if (this.livenessTimer !== null) clearInterval(this.livenessTimer); this.livenessTimer = null; }
  private nextRequestId(): number { this.requestId += 1; return this.requestId; }
  private emitStatus(): void { this.options.onStatus?.(this.snapshot()); }
}

export class HeliusWebhookLiveChainProvider implements LiveChainEventProvider {
  readonly mode = "HELIUS_WEBHOOK" as const;
  readonly name = "helius-webhook";
  private active = false;
  private readonly wallets = new Set<string>();
  private lastEventAt: string | null = null;
  private lastObservedSlot: bigint | null = null;
  constructor(private readonly onEvent: (event: LiveChainEvent) => Promise<void> | void) {}
  async connect(): Promise<void> { this.active = true; }
  async subscribe(wallet: string): Promise<boolean> { this.wallets.add(wallet); return true; }
  async unsubscribe(wallet: string): Promise<void> { this.wallets.delete(wallet); }
  async ingest(event: LiveChainEvent): Promise<void> { if (!this.active || !this.wallets.has(event.wallet)) return; this.lastEventAt = event.receivedAt; this.lastObservedSlot = event.slot; await this.onEvent(event); }
  async shutdown(): Promise<void> { this.active = false; }
  snapshot(): LiveConnectionSnapshot { return { mode: this.mode, provider: this.name, status: this.active ? "CONNECTED" : "SHUTDOWN", activeSubscriptions: this.wallets.size, desiredSubscriptions: this.wallets.size, lastEventAt: this.lastEventAt, lastObservedSlot: this.lastObservedSlot, reconnectCount: 0, malformedMessages: 0, duplicateNotifications: 0, lastError: null }; }
}
