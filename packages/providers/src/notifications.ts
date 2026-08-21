import { newId } from "@intelligence/shared";
import type { JsonValue, NotificationRecord } from "@intelligence/core";
import type { NotificationProvider, NotificationType } from "./interfaces.js";
import { z } from "zod";

export class ConsoleNotificationProvider implements NotificationProvider {
  readonly name = "console";
  readonly enabled = true;
  constructor(private readonly write: (message: string) => void = console.info) {}
  async notify(type: NotificationType, payload: JsonValue): Promise<void> {
    this.write(JSON.stringify({ level: "info", event: "notification", type, payload, at: new Date().toISOString() }));
  }
}

export interface TelegramOptions { botToken?: string; chatId?: string; dashboardUrl?: string; fetchImplementation?: typeof fetch; timeoutMs?: number }
export class TelegramNotificationProvider implements NotificationProvider {
  readonly name = "telegram";
  readonly enabled: boolean;
  private readonly request: typeof fetch;
  constructor(private readonly options: TelegramOptions) { this.enabled = options.botToken !== undefined && options.chatId !== undefined; this.request = options.fetchImplementation ?? fetch; }
  async notify(type: NotificationType, payload: JsonValue): Promise<void> {
    if (!this.enabled) throw new NotificationDeliveryError("DISABLED", "Telegram is not configured");
    const response = await this.request(`https://api.telegram.org/bot${this.options.botToken ?? ""}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      body: JSON.stringify({ chat_id: this.options.chatId, text: formatNotification(type, payload, this.options.dashboardUrl), disable_web_page_preview: true })
    });
    if (!response.ok) throw new NotificationDeliveryError("HTTP_ERROR", `Telegram delivery failed with HTTP ${response.status}`);
    const parsed = z.object({ ok: z.literal(true) }).loose().safeParse(await response.json());
    if (!parsed.success) throw new NotificationDeliveryError("MALFORMED_RESPONSE", "Telegram returned an invalid delivery response");
  }
}

export class NotificationDeliveryError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export interface NotificationStore {
  insertNotification(record: NotificationRecord): Promise<"inserted" | "duplicate">;
  updateNotification(record: NotificationRecord): Promise<void>;
}

export class DurableNotificationService {
  constructor(private readonly store: NotificationStore, private readonly providers: NotificationProvider[]) {}
  async send(category: NotificationRecord["category"], payload: JsonValue, idempotencyKey: string): Promise<NotificationRecord[]> {
    const records: NotificationRecord[] = [];
    for (const provider of this.providers) {
      const now = new Date().toISOString();
      const record: NotificationRecord = { id: newId(), category, payload, provider: provider.name ?? "unknown", status: "PENDING", errorCode: null, createdAt: now, attemptedAt: null, deliveredAt: null, idempotencyKey: `${idempotencyKey}:${provider.name ?? "unknown"}` };
      if (await this.store.insertNotification(record) === "duplicate") continue;
      if (provider.enabled === false) {
        const disabled = { ...record, status: "DISABLED" as const, errorCode: "NOT_CONFIGURED", attemptedAt: now };
        await this.store.updateNotification(disabled); records.push(disabled); continue;
      }
      try {
        await provider.notify(category, payload);
        const sent = { ...record, status: "SENT" as const, attemptedAt: now, deliveredAt: new Date().toISOString() };
        await this.store.updateNotification(sent); records.push(sent);
      } catch (error) {
        const failed = { ...record, status: "FAILED" as const, attemptedAt: now, errorCode: error instanceof NotificationDeliveryError ? error.code : "DELIVERY_FAILED" };
        await this.store.updateNotification(failed); records.push(failed);
      }
    }
    return records;
  }
}

function formatNotification(type: NotificationType, payload: JsonValue, dashboardUrl: string | undefined): string {
  const title = type.replaceAll("_", " ");
  const lines = [title, compactPayload(payload)];
  if (dashboardUrl !== undefined) lines.push(`Dashboard: ${dashboardUrl}`);
  return lines.join("\n").slice(0, 4_000);
}

function compactPayload(payload: JsonValue): string {
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object" || payload === null) return String(payload);
  if (Array.isArray(payload)) return JSON.stringify(payload);
  return Object.entries(payload).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("\n");
}
