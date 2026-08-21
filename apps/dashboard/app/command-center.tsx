"use client";

import { useCallback, useEffect, useState } from "react";

interface ComponentHealth { component: string; status: "healthy" | "degraded" | "disabled" | "unknown"; detail: string; latencyMs: number | null }
interface SystemStatus { executionMode: string; network: string; killSwitchActive: boolean; watcherPaused: boolean; lastProcessedSlot: string | null; queueLagMs: number | null; live: null | { status: string; activeSubscriptions: number; desiredSubscriptions: number; reconnectCount: number }; providerBudgets: Array<{ provider: string; calls: number; rateLimited: number; retries: number; averageLatencyMs: number | null; degraded: boolean }>; components: ComponentHealth[] }
interface Wallet { id: string; publicKey: string; status: string; dataConfidence: number | null; metrics: null | { sampleSize: number; earlyEntryScore: number | null; copyabilityScore: number | null; crowdingScore: number | null } }
interface Signal { id: string; sourceWallet: string; tokenMint: string; detectedAt: string; decision: string; antiCrowdingScore: number | null; rejectionReasons: string[]; walletScore: { total: number } }
interface Position { id: string; tokenMint: string; triggerWallet: string; simulatedEntryPriceUsd: string | null; simulatedUsdAmount: string; markPriceUsd: string | null; unrealizedPnlUsd: string | null; state: string; openedAt: string; exitRecommendation: string | null }
interface Copyability { id: string; sourceWallet: string; sourceTransactionSignature: string; tokenMint: string; status: "KNOWN" | "PARTIAL" | "UNKNOWN"; sourceEffectivePrice: string | null; followerQuotedPrice: string | null; entryPriceDeteriorationBps: number | null; detectionLatencyMs: number | null; totalFollowerLatencyMs: number | null; confidence: string; reasons: string[] }
interface TokenRisk { id: string; tokenMint: string; totalRisk: number; confidence: string; reasonCodes: string[] }
interface Notification { id: string; category: string; status: string; createdAt: string; errorCode: string | null }

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const compact = (value: string): string => value.length > 12 ? `${value.slice(0, 5)}...${value.slice(-4)}` : value;
const percent = (value: number | null): string => value === null ? "Unknown" : `${Math.round(value * 100)}%`;
const milliseconds = (value: number | null): string => value === null ? "Unknown" : `${value} ms`;

function Dot({ state }: { state: string }): React.ReactElement { return <span className={`dot ${state}`} aria-hidden="true" />; }

export function CommandCenter(): React.ReactElement {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [copyability, setCopyability] = useState<Copyability[]>([]);
  const [tokenRisk, setTokenRisk] = useState<TokenRisk[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [selected, setSelected] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const paths = ["system/status", "wallets", "signals", "positions", "copyability/recent?limit=20", "token-risk/recent?limit=20", "notifications?limit=20"];
      const responses = await Promise.all(paths.map(async (path) => fetch(`${apiUrl}/api/${path}`)));
      if (!responses.every((response) => response.ok)) throw new Error("API unavailable");
      const [nextStatus, nextWallets, nextSignals, nextPositions, nextCopyability, nextRisk, nextNotifications] = await Promise.all(responses.map(async (response) => response.json() as Promise<unknown>));
      setStatus(nextStatus as SystemStatus); setWallets(nextWallets as Wallet[]); setSignals(nextSignals as Signal[]);
      setPositions(nextPositions as Position[]); setCopyability(nextCopyability as Copyability[]); setTokenRisk(nextRisk as TokenRisk[]); setNotifications(nextNotifications as Notification[]);
      setSelected((current) => current ?? (nextPositions as Position[])[0]?.id ?? null);
      setConnection("live");
    } catch { setConnection("offline"); }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource(`${apiUrl}/api/stream`);
    stream.addEventListener("snapshot", () => { setConnection("live"); void refresh(); });
    stream.onerror = () => setConnection("offline");
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { stream.close(); window.clearInterval(timer); };
  }, [refresh]);

  const position = positions.find((item) => item.id === selected) ?? null;
  const post = async (path: string): Promise<Response> => fetch(`${apiUrl}/api/${path}`, { method: "POST" });
  const act = async (operation: "wait" | "recalculate" | "authorize-paper-sell"): Promise<void> => {
    if (position === null) return;
    setActionMessage("Submitting...");
    const response = await post(`positions/${position.id}/${operation}`);
    setActionMessage(response.ok ? operation === "authorize-paper-sell" ? "Paper sell authorized and recorded." : "Action recorded." : "Action rejected. Check API health.");
    await refresh();
  };
  const manualControl = async (): Promise<void> => {
    if (position === null) return;
    const operation = position.state === "manual_control" ? "system-control" : "manual-control";
    const response = await post(`positions/${position.id}/${operation}`);
    setActionMessage(response.ok ? operation === "manual-control" ? "Manual control enabled and audited." : "System control restored and audited." : "Control transition rejected.");
    await refresh();
  };
  const runtimeAction = async (path: string): Promise<void> => { await post(`runtime/${path}`); await refresh(); };

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brandmark">S</span><div><strong>Signal Deck</strong><small>Solana wallet intelligence</small></div></div>
      <div className="status-strip">
        <span className="status-pill"><Dot state={connection === "live" ? "healthy" : connection === "offline" ? "degraded" : "unknown"} />{connection}</span>
        <span className="status-pill">Network <b>{status?.network ?? "Unknown"}</b></span>
        <span className="mode-pill">{status?.executionMode ?? "PAPER"} / SIMULATED</span>
        <button className="status-pill" onClick={() => void runtimeAction(status?.watcherPaused ? "watcher/resume" : "watcher/pause")}>Watcher <b>{status?.watcherPaused ? "PAUSED" : status?.live?.status ?? "Unknown"}</b></button>
        <button className={`status-pill ${status?.killSwitchActive ? "danger" : ""}`} onClick={() => void runtimeAction(status?.killSwitchActive ? "shadow/restore" : "shadow/kill")}>Kill <b>{status?.killSwitchActive ? "ACTIVE" : "Ready"}</b></button>
      </div>
    </header>

    <section className="hero"><div><p className="eyebrow">OBSERVATION TERMINAL</p><h1>Follow the signal.<br/><span>Measure the delay.</span></h1><p>Continuous, latency-adjusted wallet intelligence with explicit unknowns and durable shadow records.</p></div><div className="hero-stat"><small>Execution posture</small><strong>Shadow only</strong><span>No signer or broadcast path installed</span></div></section>

    <section className="grid two-one">
      <article className="panel"><PanelHeader title="Live intelligence feed" meta={`${signals.length} signals`} /><div className="feed-head"><span>Wallet / token</span><span>Score</span><span>Crowding</span><span>Decision</span><span>Detected</span></div>{signals.length === 0 ? <Empty text="No normalized signals yet. The runtime never substitutes demo trades." /> : signals.map((signal) => <div className="feed-row" key={signal.id}><span><b>{compact(signal.sourceWallet)}</b><small>{compact(signal.tokenMint)}</small></span><Score value={signal.walletScore.total}/><span>{percent(signal.antiCrowdingScore)}</span><span className={`decision ${signal.decision.toLowerCase()}`}>{signal.decision}</span><time>{new Date(signal.detectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}</article>
      <article className="panel health-panel"><PanelHeader title="System health" meta="SSE live" />{(status?.components ?? []).map((item) => <div className="health-row" key={item.component}><span><Dot state={item.status}/>{item.component.replace("_", " ")}</span><b>{item.status}</b><small>{item.latencyMs === null ? item.detail : `${item.latencyMs} ms`}</small></div>)}{status === null && <Empty text="Waiting for API health telemetry."/>}<div className="telemetry"><span>Subscriptions<b>{status?.live === null || status?.live === undefined ? "Unknown" : `${status.live.activeSubscriptions}/${status.live.desiredSubscriptions}`}</b></span><span>Reconnects<b>{status?.live?.reconnectCount ?? "Unknown"}</b></span><span>Last slot<b>{status?.lastProcessedSlot ?? "Unknown"}</b></span><span>Provider calls<b>{status?.providerBudgets.reduce((sum, item) => sum + item.calls, 0) ?? "Unknown"}</b></span></div></article>
    </section>

    <section className="grid equal">
      <article className="panel"><PanelHeader title="Token risk" meta={`${tokenRisk.length} evaluations`} />{tokenRisk.slice(0, 8).map((risk) => <div className="health-row" key={risk.id}><span>{compact(risk.tokenMint)}</span><b className={risk.totalRisk >= .6 ? "negative" : "positive"}>{Math.round(risk.totalRisk * 100)}%</b><small>{risk.confidence} / {risk.reasonCodes[0] ?? "clear"}</small></div>)}{tokenRisk.length === 0 && <Empty text="No token risk evaluation is stored yet." />}</article>
      <article className="panel"><PanelHeader title="Durable alerts" meta={`${notifications.length} deliveries`} />{notifications.slice(0, 8).map((item) => <div className="health-row" key={item.id}><span>{item.category.replaceAll("_", " ")}</span><b className={item.status === "FAILED" ? "negative" : "positive"}>{item.status}</b><small>{item.errorCode ?? new Date(item.createdAt).toLocaleTimeString()}</small></div>)}{notifications.length === 0 && <Empty text="No notification delivery has been recorded." />}</article>
    </section>

    <section className="panel copyability-panel"><PanelHeader title="Copyability ledger" meta={`${copyability.length} recent evaluations`} /><div className="copy-head"><span>Source / token</span><span>Source price</span><span>Follower quote</span><span>Deterioration</span><span>Detection</span><span>Total latency</span><span>Confidence</span></div>{copyability.map((item) => <div className="copy-row" key={item.id}><span><b>{compact(item.sourceWallet)}</b><small>{compact(item.tokenMint)} / {compact(item.sourceTransactionSignature)}</small></span><span>{item.sourceEffectivePrice ?? "Unknown"}</span><span>{item.followerQuotedPrice ?? "Unknown"}</span><span className={item.entryPriceDeteriorationBps !== null && item.entryPriceDeteriorationBps > 0 ? "negative" : "positive"}>{item.entryPriceDeteriorationBps === null ? "Unknown" : `${item.entryPriceDeteriorationBps} bps`}</span><span>{milliseconds(item.detectionLatencyMs)}</span><span>{milliseconds(item.totalFollowerLatencyMs)}</span><span><i className={`confidence ${item.status.toLowerCase()}`}>{item.confidence}</i><small>{item.status === "KNOWN" ? "Complete observation" : item.reasons.join(", ") || item.status}</small></span></div>)}{copyability.length === 0 && <Empty text="No copyability evaluation is stored yet. Missing quotes and timings remain explicitly unknown." />}</section>

    <section className="grid equal">
      <article className="panel"><PanelHeader title="Tracked wallets" meta={`${wallets.length} tracked`} /><div className="table-scroll"><table><thead><tr><th>Wallet</th><th>Status</th><th>Samples</th><th>Early</th><th>Copyable</th><th>Crowding</th><th>Confidence</th></tr></thead><tbody>{wallets.map((wallet) => <tr key={wallet.id}><td className="mono">{compact(wallet.publicKey)}</td><td><span className="tag">{wallet.status}</span></td><td>{wallet.metrics?.sampleSize ?? "-"}</td><td>{percent(wallet.metrics?.earlyEntryScore ?? null)}</td><td>{percent(wallet.metrics?.copyabilityScore ?? null)}</td><td>{percent(wallet.metrics?.crowdingScore ?? null)}</td><td>{percent(wallet.dataConfidence)}</td></tr>)}</tbody></table>{wallets.length === 0 && <Empty text="Track a wallet through the API to begin observation." />}</div></article>
      <article className="panel"><PanelHeader title="Shadow positions" meta={`${positions.filter((item) => item.state !== "closed").length} open`} /><div className="positions">{positions.map((item) => <button className={`position-row ${selected === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelected(item.id)}><span className="token-icon">S</span><span><b>{compact(item.tokenMint)}</b><small>via {compact(item.triggerWallet)}</small></span><span><small>Entry</small>{item.simulatedEntryPriceUsd === null ? "Unknown" : `$${item.simulatedEntryPriceUsd}`}</span><span><small>Mark</small>{item.markPriceUsd === null ? "Unknown" : `$${item.markPriceUsd}`}</span><span className={item.unrealizedPnlUsd?.startsWith("-") ? "negative" : "positive"}>{item.unrealizedPnlUsd === null ? "P/L unknown" : `$${item.unrealizedPnlUsd}`}</span></button>)}{positions.length === 0 && <Empty text="Approved signals appear here only after verified shadow-price input." />}</div></article>
    </section>

    <section className="panel detail"><PanelHeader title="Position control" meta={position === null ? "No selection" : `State: ${position.state}`} /><div className="detail-grid"><div><small>Selected token</small><strong>{position === null ? "-" : compact(position.tokenMint)}</strong><p>{position?.exitRecommendation ?? "No exit recommendation. A recommendation never authorizes a sale."}</p></div><div className="controls"><button disabled={position === null || position.state === "closed"} className="sell" onClick={() => void act("authorize-paper-sell")}>SELL PAPER</button><button disabled={position === null || position.state === "closed"} onClick={() => void act("wait")}>WAIT</button><button disabled={position === null || position.state === "closed"} onClick={() => void act("recalculate")}>RECALCULATE</button><button disabled={position === null || position.state === "closed"} onClick={() => void manualControl()}>{position?.state === "manual_control" ? "SYSTEM CONTROL" : "MANUAL CONTROL"}</button></div></div>{actionMessage !== null && <p className="action-message" role="status">{actionMessage}</p>}</section>
    <footer><span>Signal Deck</span><span>Simulation environment / unknown data remains unknown</span></footer>
  </main>;
}

function PanelHeader({ title, meta }: { title: string; meta: string }): React.ReactElement { return <div className="panel-head"><h2>{title}</h2><span>{meta}</span></div>; }
function Empty({ text }: { text: string }): React.ReactElement { return <div className="empty"><span>o</span><p>{text}</p></div>; }
function Score({ value }: { value: number }): React.ReactElement { return <span className="score"><i style={{ "--score": `${value}%` } as React.CSSProperties}/><b>{value.toFixed(0)}</b></span>; }
