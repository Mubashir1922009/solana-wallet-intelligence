import { describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "./live-chain.js";
import { ShardedSolanaLiveChainProvider, StandardSolanaLiveChainProvider } from "./live-chain.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly callbacks = new Map<string, Array<(value?: unknown) => void>>();
  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit("close", {}); }
  addEventListener(type: string, listener: (value?: unknown) => void): void { this.callbacks.set(type, [...(this.callbacks.get(type) ?? []), listener]); }
  emit(type: string, value?: unknown): void { for (const listener of this.callbacks.get(type) ?? []) listener(value); }
}

describe("standard Solana live watcher", () => {
  it("subscribes once per wallet and routes logs notifications", async () => {
    const socket = new FakeSocket();
    const received = vi.fn();
    const provider = new StandardSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 2, websocketFactory: () => socket as unknown as WebSocketLike, onEvent: received });
    const connected = provider.connect();
    socket.emit("open");
    await connected;
    await provider.subscribe("wallet-a");
    await provider.subscribe("wallet-a");
    expect(socket.sent).toHaveLength(1);
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: number; method: string; params: unknown[] };
    expect(request.method).toBe("logsSubscribe");
    expect(request.params).toEqual([{ mentions: ["wallet-a"] }, { commitment: "confirmed" }]);
    socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 99 }) });
    socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 99, result: { context: { slot: 123 }, value: { signature: "5".repeat(64), err: null, logs: [] } } } }) });
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(received.mock.calls[0]?.[0]).toMatchObject({ wallet: "wallet-a", slot: 123n, succeeded: true });
    await provider.shutdown();
  });

  it("rejects subscriptions beyond configured capacity", async () => {
    const socket = new FakeSocket();
    const provider = new StandardSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 1, websocketFactory: () => socket as unknown as WebSocketLike, onEvent: () => undefined });
    const connected = provider.connect(); socket.emit("open"); await connected;
    expect(await provider.subscribe("wallet-a")).toBe(true);
    expect(await provider.subscribe("wallet-b")).toBe(false);
    await provider.shutdown();
  });

  it("unsubscribes with the server subscription id and shuts down cleanly", async () => {
    const socket = new FakeSocket();
    const provider = new StandardSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 1, websocketFactory: () => socket as unknown as WebSocketLike, onEvent: () => undefined });
    const connected = provider.connect(); socket.emit("open"); await connected; await provider.subscribe("wallet-a");
    const subscribe = JSON.parse(socket.sent[0] ?? "{}") as { id: number };
    socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: subscribe.id, result: 77 }) });
    await provider.unsubscribe("wallet-a");
    expect(JSON.parse(socket.sent[1] ?? "{}")).toMatchObject({ method: "logsUnsubscribe", params: [77] });
    await provider.shutdown();
    expect(provider.snapshot().status).toBe("SHUTDOWN");
  });

  it("reconnects and resubscribes desired wallets", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let index = 0;
      const provider = new StandardSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 1, reconnectBaseMs: 10, reconnectCapMs: 10, reconnectJitterRatio: 0, websocketFactory: () => sockets[index++] as unknown as WebSocketLike, onEvent: () => undefined });
      const connected = provider.connect(); sockets[0]?.emit("open"); await connected; await provider.subscribe("wallet-a");
      sockets[0]?.emit("close", { reason: "network" });
      await vi.advanceTimersByTimeAsync(10);
      sockets[1]?.emit("open");
      expect(JSON.parse(sockets[1]?.sent[0] ?? "{}")).toMatchObject({ method: "logsSubscribe", params: [{ mentions: ["wallet-a"] }, { commitment: "confirmed" }] });
      expect(provider.snapshot().reconnectCount).toBe(1);
      await provider.shutdown();
    } finally { vi.useRealTimers(); }
  });

  it("ignores duplicate notifications and counts malformed payloads", async () => {
    const socket = new FakeSocket();
    const received = vi.fn();
    const provider = new StandardSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 1, websocketFactory: () => socket as unknown as WebSocketLike, onEvent: received });
    const connected = provider.connect(); socket.emit("open"); await connected; await provider.subscribe("wallet-a");
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: number };
    socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 10 }) });
    const notification = { data: JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 10, result: { context: { slot: 2 }, value: { signature: "6".repeat(64), err: null, logs: [] } } } }) };
    socket.emit("message", notification); socket.emit("message", notification); socket.emit("message", { data: "{" });
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(provider.snapshot()).toMatchObject({ duplicateNotifications: 1, malformedMessages: 1 });
    await provider.shutdown();
  });
});

describe("sharded Solana live watcher", () => {
  it("allocates deterministically within bounded shard capacity", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()]; let index = 0;
    const provider = new ShardedSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 4, maximumSubscriptionsPerConnection: 2, maximumShards: 2, websocketFactory: () => sockets[index++] as unknown as WebSocketLike, onEvent: () => undefined });
    const connected = provider.connect(); sockets.forEach((socket) => socket.emit("open")); await connected;
    expect(await provider.subscribe("wallet-a")).toBe(true); expect(await provider.subscribe("wallet-b")).toBe(true); expect(await provider.subscribe("wallet-c")).toBe(true); expect(await provider.subscribe("wallet-d")).toBe(true); expect(await provider.subscribe("wallet-e")).toBe(false);
    expect([provider.shardFor("wallet-a"), provider.shardFor("wallet-b"), provider.shardFor("wallet-c")]).toEqual([0, 0, 1]); expect(provider.snapshot().shards).toHaveLength(2); await provider.shutdown();
  });
  it("reconnects only the failed shard and reports its affected wallets", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()]; let index = 0; const recovered: Array<{ wallets: string[]; shard: number }> = [];
      const provider = new ShardedSolanaLiveChainProvider({ wsUrl: "wss://example.test", maximumSubscriptions: 2, maximumSubscriptionsPerConnection: 1, maximumShards: 2, reconnectBaseMs: 10, reconnectCapMs: 10, reconnectJitterRatio: 0, websocketFactory: () => sockets[index++] as unknown as WebSocketLike, onEvent: () => undefined, onReconnect: (wallets, shard) => { recovered.push({ wallets, shard }); } });
      const connected = provider.connect(); sockets[0]?.emit("open"); sockets[1]?.emit("open"); await connected; await provider.subscribe("wallet-a"); await provider.subscribe("wallet-b"); sockets[1]?.emit("close", { reason: "network" }); await vi.advanceTimersByTimeAsync(10); sockets[2]?.emit("open"); await vi.waitFor(() => expect(recovered).toEqual([{ wallets: ["wallet-b"], shard: 1 }])); expect(provider.snapshot().shards?.[0]?.reconnectCount).toBe(0); expect(provider.snapshot().shards?.[1]?.reconnectCount).toBe(1); await provider.shutdown();
    } finally { vi.useRealTimers(); }
  });
});
