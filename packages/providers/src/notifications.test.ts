import { describe, expect, it, vi } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { NotificationProvider } from "./interfaces.js";
import { DurableNotificationService, TelegramNotificationProvider } from "./notifications.js";

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
});
