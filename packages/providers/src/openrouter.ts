import { stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/core";
import { z } from "zod";
import type { AIProvider, AIRequest, AIResult } from "./interfaces.js";

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1)
});

export interface OpenRouterOptions {
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  maximumAttempts?: number;
  maximumRequestsPerDay?: number;
  fetchImplementation?: typeof fetch;
}

export class OpenRouterAIProvider implements AIProvider {
  readonly enabled: boolean;
  private readonly cache = new Map<string, AIResult<unknown>>();
  private readonly request: typeof fetch;
  private queueTail: Promise<void> = Promise.resolve();
  private requestTimes: number[] = [];

  constructor(private readonly options: OpenRouterOptions) {
    this.enabled = options.apiKey !== undefined;
    this.request = options.fetchImplementation ?? fetch;
  }

  async analyze<TSchema extends z.ZodType>(request: AIRequest<TSchema>): Promise<AIResult<z.infer<TSchema>>> {
    const started = Date.now();
    if (!this.enabled) return { modelRequested: this.options.model, modelReturned: null, value: null, latencyMs: 0, cached: false, errorCode: "DISABLED_NO_API_KEY" };
    const cacheKey = stableHash({ purpose: request.purpose, model: this.options.model, systemPrompt: request.systemPrompt, userPrompt: request.userPrompt } as JsonValue);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return { ...cached, cached: true } as AIResult<z.infer<TSchema>>;
    const release = await this.acquireQueue();
    try {
      const queuedCached = this.cache.get(cacheKey);
      if (queuedCached !== undefined) return { ...queuedCached, cached: true } as AIResult<z.infer<TSchema>>;
      const rateLimit = Math.min(50, Math.max(1, this.options.maximumRequestsPerDay ?? 50));
      const cutoff = Date.now() - 86_400_000;
      this.requestTimes = this.requestTimes.filter((timestamp) => timestamp >= cutoff);
      if (this.requestTimes.length >= rateLimit) {
        return { modelRequested: this.options.model, modelReturned: null, value: null, latencyMs: Date.now() - started, cached: false, errorCode: "LOCAL_DAILY_RATE_LIMIT" };
      }
      this.requestTimes.push(Date.now());
      const maximumAttempts = Math.min(3, Math.max(1, this.options.maximumAttempts ?? 2));
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          const response = await this.request("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${this.options.apiKey ?? ""}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: this.options.model,
              messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.userPrompt }],
              response_format: { type: "json_object" },
              temperature: 0
            }),
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000)
          });
          if (!response.ok) {
            if ((response.status === 429 || response.status >= 500) && attempt < maximumAttempts) continue;
            return { modelRequested: this.options.model, modelReturned: null, value: null, latencyMs: Date.now() - started, cached: false, errorCode: `HTTP_${response.status}` };
          }
          const completion = completionSchema.parse(await response.json());
          const choice = completion.choices[0];
          if (choice === undefined) throw new Error("OpenRouter returned no choices");
          const value = request.responseSchema.parse(JSON.parse(choice.message.content) as unknown) as z.infer<TSchema>;
          const result: AIResult<z.infer<TSchema>> = { modelRequested: this.options.model, modelReturned: completion.model ?? null, value, latencyMs: Date.now() - started, cached: false, errorCode: null };
          this.cache.set(cacheKey, result);
          return result;
        } catch (error) {
          if (attempt === maximumAttempts) {
            const code = error instanceof z.ZodError ? "INVALID_STRUCTURED_RESPONSE" : error instanceof SyntaxError ? "INVALID_JSON_RESPONSE" : "REQUEST_FAILED";
            return { modelRequested: this.options.model, modelReturned: null, value: null, latencyMs: Date.now() - started, cached: false, errorCode: code };
          }
        }
      }
      return { modelRequested: this.options.model, modelReturned: null, value: null, latencyMs: Date.now() - started, cached: false, errorCode: "REQUEST_FAILED" };
    } finally {
      release();
    }
  }

  private async acquireQueue(): Promise<() => void> {
    const previous = this.queueTail;
    let release = (): void => undefined;
    this.queueTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}
