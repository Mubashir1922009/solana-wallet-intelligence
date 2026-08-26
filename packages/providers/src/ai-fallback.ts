import type { AIProvider, AIRequest, AIResult } from "./interfaces.js";
import { z } from "zod";

export interface FallbackAIProviderSnapshot { providers: Array<{ model: string; enabled: boolean }>; activeIndex: number | null }

export class FallbackAIProvider implements AIProvider {
  readonly enabled: boolean;
  private activeIndex: number | null = null;

  constructor(private readonly providers: AIProvider[]) {
    this.enabled = providers.some((provider) => provider.enabled);
  }

  snapshot(): FallbackAIProviderSnapshot {
    return { providers: this.providers.map((provider) => ({ model: provider.enabled ? "enabled" : "disabled", enabled: provider.enabled })), activeIndex: this.activeIndex };
  }

  async analyze<TSchema extends z.ZodType>(request: AIRequest<TSchema>): Promise<AIResult<z.infer<TSchema>>> {
    if (!this.enabled) return { modelRequested: "fallback:all-disabled", modelReturned: null, value: null, latencyMs: 0, cached: false, errorCode: "DISABLED_NO_API_KEY" };
    let last: AIResult<z.infer<TSchema>> | null = null;
    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index];
      if (provider === undefined || !provider.enabled) continue;
      const result = await provider.analyze(request);
      if (result.errorCode === null) {
        this.activeIndex = index;
        return { ...result, modelRequested: `fallback[${index}]:${result.modelRequested}` };
      }
      last = result;
    }
    if (last === null) return { modelRequested: "fallback:all-disabled", modelReturned: null, value: null, latencyMs: 0, cached: false, errorCode: "DISABLED_NO_API_KEY" };
    return { ...last, modelRequested: `fallback-exhausted:${last.modelRequested}` };
  }
}
