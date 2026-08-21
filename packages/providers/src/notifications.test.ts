import { describe, expect, it, vi } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { NotificationProvider } from "./interfaces.js";
import { DurableNotificationService, NotificationDeliveryError, TelegramNotificationProvider } from "./notifications.js";

describe("durable notifications", () => {
  it("persists sent delivery state and deduplicates idempotency keys", async () => {
    const store = new InMemoryIntelligenceStore();
    const notify = vi.fn(async () => undefined);
    const provider: NotificationProvider = { name: "test", enabled: true, notify };
    const service = new DurableNotificationService(store, [provider]);
    expect((await service.send("SHADOW_BUY", { positionId: "p" }, "buy:p"))[0]?.status).toBe("SENT");
    expect(await service.send("SHADOW_BUY", { positionId: "p" }, "buy:p")).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("records disabled providers without attempting delivery", async () => {
    const store = new InMemoryIntelligenceStore();
    const notify = vi.fn(async () => undefined);
    const provider: NotificationProvider = { name: "disabled", enabled: false, notify };
    const [record] = await new DurableNotificationService(store, [provider]).send("SYSTEM_DEGRADED", { component: "rpc" }, "degraded:rpc");
    expect(record).toMatchObject({ status: "DISABLED", errorCode: "NOT_CONFIGURED" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps Telegram disabled unless both secrets are configured", () => {
    expect(new TelegramNotificationProvider({}).enabled).toBe(false);
    expect(new TelegramNotificationProvider({ botToken: "token", chatId: "chat" }).enabled).toBe(true);
  });

  it("persists transient failure and schedules a restart-safe retry", async () => {
    const store = new InMemoryIntelligenceStore();
    let attempts = 0;
    const provider: NotificationProvider = { name: "retrying", enabled: true, notify: async () => { attempts += 1; if (attempts === 1) throw new NotificationDeliveryError("HTTP_ERROR", "temporary", true); } };
    const service = new DurableNotificationService(store, [provider]);
    const [record] = await service.send("SYSTEM_DEGRADED", { component: "test" }, "retry:test");
    expect(record).toMatchObject({ status: "PENDING", responseClass: "TRANSIENT", attemptCount: 1 });
    expect((await store.listRuntimeJobs(10))[0]).toMatchObject({ type: "NOTIFICATION_RETRY", status: "PENDING" });
    expect(await service.retry(record?.id ?? "missing")).toMatchObject({ status: "SENT", attemptCount: 2, responseClass: "SUCCESS" });
  });

  it("does not retry permanent delivery failures", async () => {
    const store = new InMemoryIntelligenceStore();
    const provider: NotificationProvider = { name: "permanent", enabled: true, notify: async () => { throw new NotificationDeliveryError("UNAUTHORIZED", "permanent", false); } };
    const [record] = await new DurableNotificationService(store, [provider]).send("SYSTEM_DEGRADED", {}, "permanent:test");
    expect(record).toMatchObject({ status: "FAILED", responseClass: "PERMANENT", nextAttemptAt: null });
    expect(await store.listRuntimeJobs(10)).toEqual([]);
  });

  it("classifies Telegram 429 as retryable without exposing the token in the error", async () => {
    const provider = new TelegramNotificationProvider({ botToken: "secret-token", chatId: "10", fetchImplementation: async () => new Response("rate limited", { status: 429 }) });
    await expect(provider.notify("SYSTEM_DEGRADED", {})).rejects.toMatchObject({ code: "HTTP_ERROR", retryable: true });
    await expect(provider.notify("SYSTEM_DEGRADED", {})).rejects.not.toThrow(/secret-token/);
  });
});
