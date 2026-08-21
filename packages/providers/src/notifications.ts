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

export interface TelegramOptions { botToken?: string; chatId?: string; dashboardUrl?: string; fetchImplementation?: typeof fetch; timeoutMs?: number; buildInlineKeyboard?: (type: NotificationType, payload: JsonValue) => Promise<JsonValue | null> }
export class TelegramNotificationProvider implements NotificationProvider {
  readonly name = "telegram";
  readonly enabled: boolean;
  private readonly request: typeof fetch;
  constructor(private readonly options: TelegramOptions) { this.enabled = options.botToken !== undefined && options.chatId !== undefined; this.request = options.fetchImplementation ?? fetch; }
  async notify(type: NotificationType, payload: JsonValue): Promise<void> {
    if (!this.enabled) throw new NotificationDeliveryError("DISABLED", "Telegram is not configured");
    const replyMarkup = await this.options.buildInlineKeyboard?.(type, payload) ?? null;
    const response = await this.request(`https://api.telegram.org/bot${this.options.botToken ?? ""}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      body: JSON.stringify({ chat_id: this.options.chatId, text: formatNotification(type, payload, this.options.dashboardUrl), disable_web_page_preview: true, ...(replyMarkup === null ? {} : { reply_markup: replyMarkup }) })
    });
    if (!response.ok) throw new NotificationDeliveryError("HTTP_ERROR", `Telegram delivery failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500);
    const parsed = z.object({ ok: z.literal(true) }).loose().safeParse(await response.json());
    if (!parsed.success) throw new NotificationDeliveryError("MALFORMED_RESPONSE", "Telegram returned an invalid delivery response");
  }
}

export class NotificationDeliveryError extends Error { constructor(readonly code: string, message: string, readonly retryable = false) { super(message); } }

export interface NotificationStore {
  insertNotification(record: NotificationRecord): Promise<"inserted" | "duplicate">;
  updateNotification(record: NotificationRecord): Promise<void>;
  getNotification(id: string): Promise<NotificationRecord | null>;
  enqueueRuntimeJob(job: import("@intelligence/core").RuntimeJob): Promise<"inserted" | "duplicate">;
}

export class DurableNotificationService {
  constructor(private readonly store: NotificationStore, private readonly providers: NotificationProvider[]) {}
  async send(category: NotificationRecord["category"], payload: JsonValue, idempotencyKey: string): Promise<NotificationRecord[]> {
    const records: NotificationRecord[] = [];
    for (const provider of this.providers) {
      const now = new Date().toISOString();
      const record: NotificationRecord = { id: newId(), category, payload, provider: provider.name ?? "unknown", status: "PENDING", errorCode: null, createdAt: now, attemptedAt: null, deliveredAt: null, idempotencyKey: `${idempotencyKey}:${provider.name ?? "unknown"}`, attemptCount: 0, nextAttemptAt: null, responseClass: null };
      if (await this.store.insertNotification(record) === "duplicate") continue;
      if (provider.enabled === false) {
        const disabled = { ...record, status: "DISABLED" as const, errorCode: "NOT_CONFIGURED", attemptedAt: now, responseClass: "DISABLED" as const };
        await this.store.updateNotification(disabled); records.push(disabled); continue;
      }
      try {
        await provider.notify(category, payload);
        const sent = { ...record, status: "SENT" as const, attemptedAt: now, deliveredAt: new Date().toISOString(), attemptCount: 1, responseClass: "SUCCESS" as const };
        await this.store.updateNotification(sent); records.push(sent);
      } catch (error) {
        const transient = error instanceof NotificationDeliveryError && error.retryable; const nextAttemptAt = transient ? new Date(Date.parse(now) + 1_000).toISOString() : null;
        const failed = { ...record, status: transient ? "PENDING" as const : "FAILED" as const, attemptedAt: now, errorCode: error instanceof NotificationDeliveryError ? error.code : "DELIVERY_FAILED", attemptCount: 1, nextAttemptAt, responseClass: transient ? "TRANSIENT" as const : "PERMANENT" as const };
        await this.store.updateNotification(failed); if (nextAttemptAt !== null) await this.scheduleRetry(failed, nextAttemptAt); records.push(failed);
      }
    }
    return records;
  }
  async retry(id: string): Promise<NotificationRecord | null> { const record = await this.store.getNotification(id); if (record === null || record.status !== "PENDING") return record; const provider = this.providers.find((item) => (item.name ?? "unknown") === record.provider); if (provider === undefined || provider.enabled === false) { const failed = { ...record, status: "FAILED" as const, responseClass: "PERMANENT" as const, errorCode: "PROVIDER_UNAVAILABLE", nextAttemptAt: null }; await this.store.updateNotification(failed); return failed; } const attempt = (record.attemptCount ?? 0) + 1; const now = new Date().toISOString(); try { await provider.notify(record.category, record.payload); const sent = { ...record, status: "SENT" as const, attemptedAt: now, deliveredAt: now, attemptCount: attempt, nextAttemptAt: null, responseClass: "SUCCESS" as const, errorCode: null }; await this.store.updateNotification(sent); return sent; } catch (error) { const transient = error instanceof NotificationDeliveryError && error.retryable && attempt < 5; const next = transient ? new Date(Date.parse(now) + Math.min(60_000, 1_000 * 2 ** (attempt - 1))).toISOString() : null; const failed = { ...record, status: transient ? "PENDING" as const : "FAILED" as const, attemptedAt: now, attemptCount: attempt, nextAttemptAt: next, responseClass: transient ? "TRANSIENT" as const : "PERMANENT" as const, errorCode: error instanceof NotificationDeliveryError ? error.code : "DELIVERY_FAILED" }; await this.store.updateNotification(failed); if (next !== null) await this.scheduleRetry(failed, next); return failed; } }
  private async scheduleRetry(record: NotificationRecord, runAt: string): Promise<void> { await this.store.enqueueRuntimeJob({ id: newId(), type: "NOTIFICATION_RETRY", payload: { notificationId: record.id }, status: "PENDING", runAt, createdAt: new Date().toISOString(), startedAt: null, completedAt: null, attempts: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, lastError: null, idempotencyKey: `notification-retry:${record.id}:${record.attemptCount ?? 0}` }); }
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
