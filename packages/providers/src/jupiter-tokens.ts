import { z } from "zod";
import type { TokenDiscovery } from "@intelligence/core";
import type { JupiterAuthMode } from "./jupiter.js";
import { JupiterMarketError } from "./jupiter.js";

const recentTokenSchema = z.array(z.looseObject({
  id: z.string().min(32), symbol: z.string().nullable().optional(), name: z.string().nullable().optional(), decimals: z.number().int().min(0).max(30).nullable().optional(),
  organicScore: z.number().nullable().optional(), organicScoreLabel: z.string().nullable().optional(),
  firstPool: z.looseObject({ createdAt: z.iso.datetime({ offset: true }).nullable().optional() }).nullable().optional()
}));

export interface JupiterRecentTokenOptions { apiKey?: string; authMode?: JupiterAuthMode; baseUrl?: string; timeoutMs?: number; fetchImplementation?: typeof fetch }

export class JupiterRecentTokenProvider {
  readonly name = "jupiter-tokens-v2";
  readonly authMode: "API_KEY" | "KEYLESS" | "DISABLED";
  readonly enabled: boolean;
  private readonly request: typeof fetch;
  constructor(private readonly options: JupiterRecentTokenOptions = {}) {
    this.authMode = options.authMode === "DISABLED" ? "DISABLED" : options.authMode === "API_KEY" ? "API_KEY" : options.authMode === "KEYLESS" ? "KEYLESS" : options.apiKey === undefined ? "KEYLESS" : "API_KEY";
    this.enabled = this.authMode !== "DISABLED";
    this.request = options.fetchImplementation ?? fetch;
  }
  async recent(observedAt = new Date().toISOString()): Promise<TokenDiscovery[]> {
    if (!this.enabled) throw new JupiterMarketError("DISABLED", "Jupiter recent-token provider is disabled", false);
    if (this.authMode === "API_KEY" && this.options.apiKey === undefined) throw new JupiterMarketError("MISSING_API_KEY", "Jupiter API-key mode requires JUPITER_API_KEY", false);
    const headers: Record<string, string> = { accept: "application/json" }; if (this.authMode === "API_KEY" && this.options.apiKey !== undefined) headers["x-api-key"] = this.options.apiKey;
    const response = await this.request(`${this.options.baseUrl ?? "https://api.jup.ag/tokens/v2"}/recent`, { headers, signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000) });
    if (!response.ok) { const code = response.status === 429 ? "RATE_LIMITED" : response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "HTTP_ERROR"; throw new JupiterMarketError(code, `Jupiter Tokens V2 recent request failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500, response.status); }
    const parsed = recentTokenSchema.safeParse(await response.json()); if (!parsed.success) throw new JupiterMarketError("MALFORMED_RESPONSE", "Jupiter Tokens V2 recent response was malformed", false);
    return parsed.data.map((token) => ({ mint: token.id, firstPoolCreatedAt: token.firstPool?.createdAt ?? null, symbol: token.symbol ?? null, name: token.name ?? null, decimals: token.decimals ?? null, organicScore: token.organicScore ?? null, organicScoreLabel: token.organicScoreLabel ?? null, provider: "JUPITER_TOKENS_V2", provenance: "EXTERNAL_HEURISTIC", firstObservedAt: observedAt, lastObservedAt: observedAt, providerObservedAt: observedAt }));
  }
}
