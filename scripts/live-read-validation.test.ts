import { describe, expect, it } from "vitest";
import { credentialedHeliusUrls, sanitizeSensitiveText } from "./live-read-validation.js";

describe("Helius validation safety", () => {
  it("keeps credentials only in in-memory endpoint URLs and redacts them from text", () => {
    const secret = "test-secret-value";
    const urls = credentialedHeliusUrls(secret);
    expect(urls.rpcUrl).toContain(secret);
    expect(urls.wsUrl).toContain(secret);
    const sanitized = sanitizeSensitiveText(`failure at ${urls.rpcUrl} and ${urls.wsUrl}`, secret);
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[REDACTED]");
  });
});
