import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseHeliusWebhookPayload } from "./helius.js";
import { OpenRouterAIProvider } from "./openrouter.js";

describe("provider boundaries", () => {
  it("rejects malformed Helius webhook payloads", () => expect(() => parseHeliusWebhookPayload({ signature: "not-an-array" }, new Date().toISOString())).toThrow());
  it("preserves unknown Helius fields without inferring a buy", () => {
    const payload = [{ signature: "5".repeat(64), slot: 123, timestamp: 1_700_000_000, accountData: [{ account: "Vote111111111111111111111111111111111111111", newProviderField: true }], newProviderField: "preserved" }];
    const [event] = parseHeliusWebhookPayload(payload, "2026-08-20T12:00:00.000Z");
    expect(event?.signature).toBe("5".repeat(64));
    expect(event?.rawPayload).toMatchObject({ newProviderField: "preserved" });
  });
  it("disables OpenRouter cleanly without a key", async () => {
    const provider = new OpenRouterAIProvider({ model: "openrouter/free" });
    const result = await provider.analyze({ purpose: "test", systemPrompt: "Return JSON", userPrompt: "Explain", responseSchema: z.object({ reason: z.string() }) });
    expect(result.errorCode).toBe("DISABLED_NO_API_KEY");
    expect(result.value).toBeNull();
  });
  it("caches validated responses and enforces its local daily limit", async () => {
    let calls = 0;
    const provider = new OpenRouterAIProvider({
      apiKey: "test-only-key", model: "test/model", maximumAttempts: 1, maximumRequestsPerDay: 1,
      fetchImplementation: async () => {
        calls += 1;
        return new Response(JSON.stringify({ model: "test/model", choices: [{ message: { content: "{\"reason\":\"ok\"}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const responseSchema = z.object({ reason: z.string() });
    const first = await provider.analyze({ purpose: "test", systemPrompt: "json", userPrompt: "one", responseSchema });
    const cached = await provider.analyze({ purpose: "test", systemPrompt: "json", userPrompt: "one", responseSchema });
    const limited = await provider.analyze({ purpose: "test", systemPrompt: "json", userPrompt: "two", responseSchema });
    expect(first.value).toEqual({ reason: "ok" });
    expect(cached.cached).toBe(true);
    expect(limited.errorCode).toBe("LOCAL_DAILY_RATE_LIMIT");
    expect(calls).toBe(1);
  });
});
