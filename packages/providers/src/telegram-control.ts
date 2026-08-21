import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { newRuntimeJob, PaperPositionService, type IntelligenceStore, type TelegramAction } from "@intelligence/core";
import type { JsonValue } from "@intelligence/shared";

const updateSchema = z.object({ update_id: z.union([z.number().int(), z.string()]), callback_query: z.object({ id: z.string(), from: z.object({ id: z.union([z.number().int(), z.string()]) }), message: z.object({ chat: z.object({ id: z.union([z.number().int(), z.string()]) }) }).optional(), data: z.string().max(64) }) });
export interface TelegramControlOptions { botToken: string; chatId: string; userId: string; webhookSecret: string; dashboardUrl?: string; callbackTtlMs?: number; fetchImplementation?: typeof fetch; now?: () => Date }
export class TelegramShadowController {
  private readonly positions: PaperPositionService; private readonly request: typeof fetch;
  constructor(private readonly store: IntelligenceStore, private readonly options: TelegramControlOptions) { this.positions = new PaperPositionService(store); this.request = options.fetchImplementation ?? fetch; }
  validWebhookSecret(actual: string | undefined): boolean { return actual !== undefined && safeEqual(hash(actual), hash(this.options.webhookSecret)); }
  async buildKeyboard(type: string, payload: JsonValue): Promise<JsonValue | null> {
    if (!["EXIT_RECOMMENDATION", "SOURCE_WALLET_SELL"].includes(type) || typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof payload.positionId !== "string") return null;
    const position = await this.store.getPosition(payload.positionId); if (position === null || position.state === "closed") return null;
    const buttons: Array<[string, TelegramAction]> = [["SELL SHADOW NOW", "SELL_SHADOW"], ["WAIT", "WAIT"], ["RECALCULATE", "RECALCULATE"], [position.state === "manual_control" ? "RETURN CONTROL" : "MANUAL CONTROL", position.state === "manual_control" ? "SYSTEM_CONTROL" : "MANUAL_CONTROL"]]; const rows: JsonValue[] = [];
    for (const [label, action] of buttons) { const nonce = randomBytes(18).toString("base64url"); await this.store.createTelegramInteraction({ nonceHash: hash(nonce), positionId: position.id, action, expectedPositionState: position.state, createdAt: this.now(), expiresAt: new Date(Date.parse(this.now()) + (this.options.callbackTtlMs ?? 900_000)).toISOString(), consumedAt: null, updateId: null }); rows.push([{ text: label, callback_data: `sh:${nonce}` }]); }
    if (this.options.dashboardUrl !== undefined) rows.push([{ text: "OPEN DASHBOARD", url: this.options.dashboardUrl }]); return { inline_keyboard: rows };
  }
  async handle(raw: unknown): Promise<{ accepted: boolean; outcome: string }> {
    const parsed = updateSchema.safeParse(raw); if (!parsed.success) return { accepted: false, outcome: "MALFORMED_UPDATE" }; const callback = parsed.data.callback_query; await this.answer(callback.id, "Processing shadow action");
    if (String(callback.from.id) !== this.options.userId) { await this.audit("UNAUTHORIZED_USER"); return { accepted: false, outcome: "UNAUTHORIZED_USER" }; }
    if (callback.message === undefined || String(callback.message.chat.id) !== this.options.chatId) { await this.audit("UNAUTHORIZED_CHAT"); return { accepted: false, outcome: "UNAUTHORIZED_CHAT" }; }
    if (!callback.data.startsWith("sh:")) { await this.audit("INVALID_CALLBACK"); return { accepted: false, outcome: "INVALID_CALLBACK" }; }
    const interaction = await this.store.consumeTelegramInteraction(hash(callback.data.slice(3)), String(parsed.data.update_id), this.now()); if (interaction === null) { await this.audit("DUPLICATE_OR_EXPIRED"); return { accepted: false, outcome: "DUPLICATE_OR_EXPIRED" }; }
    const position = await this.store.getPosition(interaction.positionId); if (position === null || position.state !== interaction.expectedPositionState || position.state === "closed") { await this.audit("STALE_POSITION"); return { accepted: false, outcome: "STALE_POSITION" }; }
    switch (interaction.action) { case "SELL_SHADOW": await this.positions.authorizePaperSell(position.id); break; case "WAIT": await this.positions.wait(position.id); break; case "RECALCULATE": await this.positions.recalculate(position.id); await this.store.enqueueRuntimeJob(newRuntimeJob("EXIT_RECALCULATION", { positionId: position.id }, this.now(), `telegram-exit-recalculation:${interaction.nonceHash}`, 5)); break; case "MANUAL_CONTROL": await this.positions.takeManualControl(position.id); break; case "SYSTEM_CONTROL": await this.positions.returnSystemControl(position.id); break; }
    await this.store.insertOperatorSecurityEvent({ id: randomUUID(), type: "TELEGRAM_ACTION", occurredAt: this.now(), sessionId: null, actor: "TELEGRAM", clientLabel: null, details: { action: interaction.action, positionId: position.id } }); return { accepted: true, outcome: interaction.action };
  }
  private async answer(id: string, text: string): Promise<void> { try { await this.request(`https://api.telegram.org/bot${this.options.botToken}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text }), signal: AbortSignal.timeout(3_000) }); } catch { /* Action persistence remains independent of callback acknowledgement availability. */ } }
  private async audit(reason: string): Promise<void> { await this.store.insertOperatorSecurityEvent({ id: randomUUID(), type: "TELEGRAM_REJECTED", occurredAt: this.now(), sessionId: null, actor: "TELEGRAM", clientLabel: null, details: { reason } }); }
  private now(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeEqual(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
