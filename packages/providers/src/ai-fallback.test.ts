import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AIProvider, AIRequest, AIResult } from "./interfaces.js";
import { FallbackAIProvider } from "./ai-fallback.js";
import { GroqAIProvider } from "./groq.js";

const request: AIRequest<z.ZodType> = { purpose: "test", systemPrompt: "s", userPrompt: "u", responseSchema: z.object({ answer: z.string() }) };

function stubProvider(name: string, enabled: boolean, errorCode: string | null = "REQUEST_FAILED"): AIProvider {
  return {
    enabled,
    analyze: async <TSchema extends z.ZodType>(): Promise<AIResult<z.infer<TSchema>>> => ({ modelRequested: name, modelReturned: errorCode === null ? name : null, value: errorCode === null ? ({ answer: "ok" } as z.infer<TSchema>) : null, latencyMs: 1, cached: false, errorCode })
  };
}

describe("fallback AI provider", () => {
  it("is disabled when every child is disabled", () => {
    const provider = new FallbackAIProvider([stubProvider("a", false), stubProvider("b", false)]);
    expect(provider.enabled).toBe(false);
  });

  it("returns the first successful provider and records it as active", async () => {
    const provider = new FallbackAIProvider([stubProvider("primary", true, "LOCAL_DAILY_RATE_LIMIT"), stubProvider("secondary", true, null)]);
    const result = await provider.analyze(request);
    expect(result.errorCode).toBeNull();
    expect(result.value).toMatchObject({ answer: "ok" });
    expect(result.modelRequested).toBe("fallback[1]:secondary");
    expect(provider.snapshot().activeIndex).toBe(1);
  });

  it("short-circuits on the primary when it succeeds", async () => {
    const provider = new FallbackAIProvider([stubProvider("primary", true, null), stubProvider("secondary", true, null)]);
    const result = await provider.analyze(request);
    expect(result.modelRequested).toBe("fallback[0]:primary");
  });

  it("reports exhaustion when all providers fail", async () => {
    const provider = new FallbackAIProvider([stubProvider("primary", true, "HTTP_429"), stubProvider("secondary", true, "REQUEST_FAILED")]);
    const result = await provider.analyze(request);
    expect(result.errorCode).toBe("REQUEST_FAILED");
    expect(result.modelRequested).toBe("fallback-exhausted:secondary");
  });
});

describe("grok AI provider", () => {
  it("disables cleanly without a key", async () => {
    const provider = new GroqAIProvider({ model: "llama-3.3-70b-versatile" });
    expect(provider.enabled).toBe(false);
    const result = await provider.analyze(request);
    expect(result.errorCode).toBe("DISABLED_NO_API_KEY");
  });

  it("parses a structured completion from the Groq-compatible endpoint", async () => {
    let capturedUrl = "";
    const provider = new GroqAIProvider({
      apiKey: "gsk-test", model: "llama-3.3-70b-versatile",
      fetchImplementation: (async (url: unknown) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ model: "llama-3.3-70b-versatile", choices: [{ message: { content: "{\"answer\":\"ok\"}" } }] }), { status: 200 });
      }) as typeof fetch
    });
    const result = await provider.analyze(request);
    expect(capturedUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(result.errorCode).toBeNull();
    expect(result.value).toMatchObject({ answer: "ok" });
    expect(result.modelReturned).toBe("llama-3.3-70b-versatile");
  });

  it("reports HTTP quota exhaustion without retrying 429 past the attempt limit", async () => {
    let calls = 0;
    const provider = new GroqAIProvider({
      apiKey: "gsk-test", model: "llama-3.3-70b-versatile", maximumAttempts: 2,
      fetchImplementation: (async () => { calls += 1; return new Response("rate limited", { status: 429 }); }) as typeof fetch
    });
    const result = await provider.analyze(request);
    expect(result.errorCode).toBe("HTTP_429");
    expect(calls).toBe(2);
  });
});

