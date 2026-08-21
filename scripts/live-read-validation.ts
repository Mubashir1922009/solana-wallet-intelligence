import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const boundedHolderFixtureMint = "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A";
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const voteProgram = "Vote111111111111111111111111111111111111111";
const allowedMethods = new Set([
  "getLatestBlockhash",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getAccountInfo",
  "getMultipleAccounts",
  "getSignaturesForAddress",
  "getTransaction"
]);

export interface RpcValidationResult {
  method: string;
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  rpcErrorCode: number | null;
  resultPresent: boolean;
  retries: number;
  rateLimited: boolean;
  timedOut: boolean;
  malformed: boolean;
  summary: Record<string, unknown>;
}

export function credentialedHeliusUrls(apiKey: string, configuredRpcUrl?: string): { rpcUrl: string; wsUrl: string } {
  const rpc = new URL(configuredRpcUrl ?? "https://mainnet.helius-rpc.com");
  rpc.searchParams.set("api-key", apiKey);
  const ws = new URL("wss://mainnet.helius-rpc.com");
  ws.searchParams.set("api-key", apiKey);
  return { rpcUrl: rpc.toString(), wsUrl: ws.toString() };
}

export function sanitizeSensitiveText(value: string, secret: string): string {
  return value
    .replaceAll(secret, "[REDACTED]")
    .replace(/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, "$1[REDACTED]");
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImplementation: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<{ validation: RpcValidationResult; result: unknown }> {
  if (!allowedMethods.has(method)) throw new Error(`RPC method is outside the read-only validation allowlist: ${method}`);
  const started = performance.now();
  let retries = 0;
  let rateLimited = false;
  let timedOut = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImplementation(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${attempt}`, method, params }),
        signal: AbortSignal.timeout(10_000)
      });
      rateLimited ||= response.status === 429;
      const payload: unknown = await response.json();
      const envelope = isRecord(payload) ? payload : null;
      const rpcError = isRecord(envelope?.error) ? envelope.error : null;
      const malformed = envelope === null || (envelope.result === undefined && rpcError === null);
      const retryable = response.status === 429 || response.status >= 500;
      if ((!response.ok || rpcError !== null || malformed) && retryable && attempt < 2) {
        retries += 1;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(Math.max(retryAfterMs, 250 * attempt) + Math.round(Math.random() * 75));
        continue;
      }
      const result = envelope?.result;
      return {
        validation: {
          method,
          ok: response.ok && rpcError === null && !malformed,
          latencyMs: round(performance.now() - started),
          httpStatus: response.status,
          rpcErrorCode: typeof rpcError?.code === "number" ? rpcError.code : null,
          resultPresent: result !== null && result !== undefined,
          retries,
          rateLimited,
          timedOut,
          malformed,
          summary: summarize(method, result)
        },
        result
      };
    } catch (error) {
      timedOut ||= error instanceof DOMException && error.name === "TimeoutError";
      if (attempt < 2) {
        retries += 1;
        await sleep(250 * attempt + Math.round(Math.random() * 75));
        continue;
      }
    }
  }
  return {
    validation: {
      method,
      ok: false,
      latencyMs: round(performance.now() - started),
      httpStatus: null,
      rpcErrorCode: null,
      resultPresent: false,
      retries,
      rateLimited,
      timedOut,
      malformed: false,
      summary: {}
    },
    result: null
  };
}

function summarize(method: string, result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return { resultPresent: result !== null && result !== undefined };
  const context = isRecord(result.context) ? result.context : null;
  if (method === "getTokenLargestAccounts") return { slotPresent: typeof context?.slot === "number", accountCount: Array.isArray(result.value) ? result.value.length : null };
  if (method === "getTokenSupply") return { slotPresent: typeof context?.slot === "number", valuePresent: result.value !== undefined };
  if (method === "getAccountInfo") return { slotPresent: typeof context?.slot === "number", accountPresent: result.value !== null && result.value !== undefined };
  if (method === "getMultipleAccounts") return { slotPresent: typeof context?.slot === "number", accountCount: Array.isArray(result.value) ? result.value.length : null };
  return { resultPresent: true };
}

async function websocketValidation(wsUrl: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  return await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    let subscriptionId: number | null = null;
    let connectLatencyMs: number | null = null;
    let notifications = 0;
    let malformed = 0;
    let bytes = 0;
    let settled = false;
    const finish = (ok: boolean, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (subscriptionId !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "logsUnsubscribe", params: [subscriptionId] }));
      }
      socket.close(1000, "bounded-validation-complete");
      resolve({
        method: "logsSubscribe",
        ok,
        connectionSuccess: connectLatencyMs !== null,
        subscriptionEstablished: subscriptionId !== null,
        connectLatencyMs,
        totalLatencyMs: round(performance.now() - started),
        notifications,
        reconnects: 0,
        malformed,
        bytes,
        error
      });
    };
    const timeout = setTimeout(() => finish(subscriptionId !== null, subscriptionId === null ? "subscription_timeout" : null), 15_000);
    socket.addEventListener("open", () => {
      connectLatencyMs = round(performance.now() - started);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [voteProgram] }, { commitment: "confirmed" }] }));
    });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      bytes += Buffer.byteLength(text);
      try {
        const payload = JSON.parse(text) as { id?: number; result?: number; method?: string };
        if (payload.id === 1 && typeof payload.result === "number") subscriptionId = payload.result;
        if (payload.method === "logsNotification") {
          notifications += 1;
          finish(true, null);
        }
      } catch {
        malformed += 1;
      }
    });
    socket.addEventListener("error", () => finish(false, "websocket_error"));
    socket.addEventListener("close", () => finish(false, "websocket_closed_before_validation"));
  });
}

export async function runHeliusValidation(apiKey: string, configuredRpcUrl?: string): Promise<Record<string, unknown>> {
  const { rpcUrl, wsUrl } = credentialedHeliusUrls(apiKey, configuredRpcUrl);
  const calls: RpcValidationResult[] = [];
  const run = async (method: string, params: unknown[]): Promise<unknown> => {
    if (calls.length > 0) await new Promise((resolve) => setTimeout(resolve, 275));
    const result = await rpc(rpcUrl, method, params);
    calls.push(result.validation);
    return result.result;
  };

  await run("getLatestBlockhash", [{ commitment: "confirmed" }]);
  await run("getTokenSupply", [usdcMint, { commitment: "confirmed" }]);
  await run("getTokenLargestAccounts", [boundedHolderFixtureMint, { commitment: "confirmed" }]);
  await run("getAccountInfo", [usdcMint, { commitment: "confirmed", encoding: "jsonParsed" }]);
  await run("getMultipleAccounts", [[usdcMint, tokenProgram], { commitment: "confirmed", encoding: "jsonParsed" }]);
  const signatures = await run("getSignaturesForAddress", [voteProgram, { commitment: "confirmed", limit: 1 }]);
  const signature = Array.isArray(signatures) && isRecord(signatures[0]) && typeof signatures[0].signature === "string" ? signatures[0].signature : null;
  if (signature !== null) await run("getTransaction", [signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  else calls.push({ method: "getTransaction", ok: false, latencyMs: 0, httpStatus: null, rpcErrorCode: null, resultPresent: false, retries: 0, rateLimited: false, timedOut: false, malformed: false, summary: { skipped: "NO_SIGNATURE" } });
  const websocket = await websocketValidation(wsUrl);
  return {
    generatedAt: new Date().toISOString(),
    network: "mainnet-beta",
    provider: "HELIUS_STANDARD_RPC",
    readOnly: true,
    rateBudget: { maximumBurstRps: 4, interRequestDelayMs: 275, maximumAttempts: 2 },
    calls,
    websocket,
    totals: {
      attempted: calls.length,
      succeeded: calls.filter((call) => call.ok).length,
      rateLimited: calls.filter((call) => call.rateLimited).length,
      retries: calls.reduce((sum, call) => sum + call.retries, 0),
      timeouts: calls.filter((call) => call.timedOut).length,
      malformed: calls.filter((call) => call.malformed).length
    }
  };
}

function parseRetryAfter(value: string | null): number {
  if (value === null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") throw new Error("HELIUS_API_KEY is required");
  const report = await runHeliusValidation(apiKey, process.env.HELIUS_RPC_URL);
  const serialized = sanitizeSensitiveText(JSON.stringify(report, null, 2), apiKey);
  await mkdir("runtime/reports", { recursive: true });
  const artifact = `runtime/reports/helius-validation-${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}.json`;
  await writeFile(artifact, `${serialized}\n`, "utf8");
  console.info(serialized);
  console.info(`Artifact: ${artifact}`);
  const totals = report.totals as { attempted: number; succeeded: number };
  if (totals.succeeded !== totals.attempted || (report.websocket as { ok?: boolean }).ok !== true) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
