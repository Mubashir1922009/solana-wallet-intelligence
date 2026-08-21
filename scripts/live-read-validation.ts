const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const wsUrl = process.env.SOLANA_WS_URL ?? "wss://api.mainnet-beta.solana.com";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const capturedSignature = "yRFQqLjGEVK9zHxghf9AYisRYQiT9y7oNaJxcYgjvPncZarZPUBTEC5o7ygj8YvhtG19rgzg8guG16r6HkHxbZ9";
const voteProgram = "Vote111111111111111111111111111111111111111";

async function rpc(method: string, params: unknown[]): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { result?: unknown; error?: { code?: number } };
    const result = body.result;
    return { method, ok: response.ok && body.error === undefined, httpStatus: response.status, latencyMs: Date.now() - started, rpcErrorCode: body.error?.code ?? null, summary: summarize(method, result) };
  } catch (error) { return { method, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.name : "unknown" }; }
}

function summarize(method: string, result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) return { resultPresent: result !== null && result !== undefined };
  const envelope = result as { context?: { slot?: number }; value?: unknown; slot?: number };
  if (method === "getTokenLargestAccounts") return { slot: envelope.context?.slot ?? null, accountCount: Array.isArray(envelope.value) ? envelope.value.length : null };
  if (method === "getTokenSupply") return { slot: envelope.context?.slot ?? null, valuePresent: envelope.value !== undefined };
  if (method === "getAccountInfo") return { slot: envelope.context?.slot ?? null, accountPresent: envelope.value !== null && envelope.value !== undefined };
  return { slot: envelope.slot ?? null, resultPresent: true };
}

async function websocketValidation(): Promise<Record<string, unknown>> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    let subscriptionId: number | null = null;
    let settled = false;
    const finish = (result: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (subscriptionId !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "logsUnsubscribe", params: [subscriptionId] }));
      socket.close(1000, "bounded-validation-complete");
      resolve({ method: "logsSubscribe", latencyMs: Date.now() - started, ...result });
    };
    const timeout = setTimeout(() => finish({ ok: false, error: "notification_timeout" }), 15_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [voteProgram] }, { commitment: "confirmed" }] })));
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { id?: number; result?: number; method?: string; params?: { result?: { context?: { slot?: number }; value?: { signature?: string } } } };
        if (payload.id === 1 && typeof payload.result === "number") subscriptionId = payload.result;
        if (payload.method === "logsNotification") finish({ ok: true, subscriptionEstablished: subscriptionId !== null, slot: payload.params?.result?.context?.slot ?? null, signaturePresent: typeof payload.params?.result?.value?.signature === "string" });
      } catch { finish({ ok: false, error: "malformed_message" }); }
    });
    socket.addEventListener("error", () => finish({ ok: false, error: "websocket_error" }));
  });
}

async function main(): Promise<void> {
  const results = [];
  results.push(await rpc("getTokenSupply", [usdcMint, { commitment: "confirmed" }]));
  results.push(await rpc("getTokenLargestAccounts", [usdcMint, { commitment: "confirmed" }]));
  results.push(await rpc("getAccountInfo", [usdcMint, { commitment: "confirmed", encoding: "jsonParsed" }]));
  results.push(await rpc("getTransaction", [capturedSignature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]));
  results.push(await websocketValidation());
  console.info(JSON.stringify({ network: "mainnet-beta", readOnly: true, calls: results }, null, 2));
}

void main();
