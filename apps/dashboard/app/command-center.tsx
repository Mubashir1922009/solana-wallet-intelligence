"use client";

import { useCallback, useEffect, useState } from "react";

interface ComponentHealth { component: string; status: "healthy" | "degraded" | "disabled" | "unknown"; detail: string; latencyMs: number | null }
interface SystemStatus { executionMode: string; network: string; killSwitchActive: boolean; watcherPaused: boolean; activeChainProvider: string | null; lastProcessedSlot: string | null; queueLagMs: number | null; durability: { queueDepth: number; overdueJobs: number; oldestPendingAt: string | null; oldestPendingType: string | null }; database: null | { expected: string; current: string | null; ready: boolean }; runtimeSettings: { revision: number; updatedAt: string; updatedBy: string }; live: null | { status: string; activeSubscriptions: number; desiredSubscriptions: number; reconnectCount: number; shards?: Array<{ status: string; desiredSubscriptions: number; reconnectCount: number }> }; worker?: { health: "HEALTHY" | "STALE" | "OFFLINE"; lease: null | { workerId: string; heartbeatAt: string; queueDepth: number } }; providerBudgets: Array<{ provider: string; calls: number; rateLimited: number; retries: number; averageLatencyMs: number | null; degraded: boolean; health: string; lastSuccessAt: string | null }>; providerTelemetry: Array<{ provider: string; health: string; callsOrEvents: number | null; rateLimited: number | null; averageLatencyMs: number | null; lastSuccessAt: string | null; detail: string }>; components: ComponentHealth[] }
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
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "signed_out">("checking");
  const [password, setPassword] = useState("");
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [research, setResearch] = useState<{
    sampleSize: number | null;
    deterministicDecisionOutcomeSampleSize: number | null;
    followerEvidenceSampleSize: number | null;
    followerSourceEventCount: number | null;
    pendingOutcomes: number | null;
    candidates: Array<{ wallet: string; state: string; sampleSize: number; provisionalScore: number | null }>;
    candidateProgress: Array<{
      wallet: string; state: string; validFollowerSamples: number; requiredFollowerSamples: number;
      independentTokens: number; requiredIndependentTokens: number; score: number | null; crowding: number | null;
      historyCompleteness: string; nextPendingOutcome: string | null; latestSourceObservation: string | null;
      noRoute: number; missing: number; pendingOutcomes: number;
    }>;
  } | null>(null);
  const [security, setSecurity] = useState<{ activeSessions: number; events: Array<{ id: string; type: string; occurredAt: string }> } | null>(null);
  const [e2e, setE2e] = useState<{ status: string; completedAt?: string | null; decisions?: Record<string, number> | null; funnel?: Record<string, number | null>; dropReasons?: Record<string, number> | null } | null>(null);
  const [soak, setSoak] = useState<{ status: string; completedAt?: string | null; durationMs?: number | null; storeMode?: string | null } | null>(null);
  const [readiness, setReadiness] = useState<{ status: string; areas?: Record<string, { status: string; reasons: string[] }> | null } | null>(null);
  const csrf = (): string => window.sessionStorage.getItem("operator_csrf") ?? "";

  const refresh = useCallback(async () => {
    try {
      const paths = ["system/status", "wallets", "signals", "positions", "copyability/recent?limit=20", "token-risk/recent?limit=20", "notifications?limit=20", "research?limit=20", "security", "e2e/latest", "soak/latest", "readiness/latest"];
      const responses = await Promise.all(paths.map(async (path) => fetch(`${apiUrl}/api/${path}`, { credentials: "include" })));
      if (responses.some((response) => response.status === 401)) { setAuthState("signed_out"); return; }
      if (!responses.every((response) => response.ok)) throw new Error("API unavailable");
      const [nextStatus, nextWallets, nextSignals, nextPositions, nextCopyability, nextRisk, nextNotifications, nextResearch, nextSecurity, nextE2e, nextSoak, nextReadiness] = await Promise.all(responses.map(async (response) => response.json() as Promise<unknown>));
      setStatus(nextStatus as SystemStatus); setWallets(nextWallets as Wallet[]); setSignals(nextSignals as Signal[]);
      setPositions(nextPositions as Position[]); setCopyability(nextCopyability as Copyability[]); setTokenRisk(nextRisk as TokenRisk[]); setNotifications(nextNotifications as Notification[]);
      setResearch(nextResearch as typeof research); setSecurity(nextSecurity as typeof security); setE2e(nextE2e as typeof e2e); setSoak(nextSoak as typeof soak); setReadiness(nextReadiness as typeof readiness); setAuthState("authenticated");
      setSelected((current) => current ?? (nextPositions as Position[])[0]?.id ?? null);
      setConnection("live");
    } catch { setConnection("offline"); }
  }, []);

  useEffect(() => {
    void refresh();
    if (authState === "signed_out") return;
    const stream = new EventSource(`${apiUrl}/api/stream`, { withCredentials: true });
    stream.addEventListener("snapshot", () => { setConnection("live"); void refresh(); });
    stream.onerror = () => setConnection("offline");
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { stream.close(); window.clearInterval(timer); };
  }, [refresh, authState]);

  const position = positions.find((item) => item.id === selected) ?? null;
  const post = async (path: string): Promise<Response> => fetch(`${apiUrl}/api/${path}`, { method: "POST", credentials: "include", headers: { "x-csrf-token": csrf() } });
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
  const login = async (event: React.FormEvent): Promise<void> => { event.preventDefault(); setLoginMessage("Authenticating..."); const response = await fetch(`${apiUrl}/api/auth/login`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }); if (!response.ok) { setLoginMessage(response.status === 429 ? "Too many attempts. Wait before retrying." : "Credential rejected."); return; } const body = await response.json() as { csrfToken: string }; window.sessionStorage.setItem("operator_csrf", body.csrfToken); setPassword(""); setAuthState("authenticated"); setLoginMessage(null); await refresh(); };
  const logout = async (): Promise<void> => { await post("auth/logout"); window.sessionStorage.removeItem("operator_csrf"); setAuthState("signed_out"); };

  if (authState !== "authenticated") return <main className="login-shell"><section className="login-card"><span className="brandmark">S</span><p className="eyebrow">SINGLE OPERATOR / SHADOW ONLY</p><h1>Signal Deck</h1><p>Authenticate to access wallet intelligence, simulated positions, and remote shadow controls.</p><form onSubmit={(event) => void login(event)}><label htmlFor="operator-password">Operator password</label><input id="operator-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required/><button type="submit" disabled={authState === "checking"}>{authState === "checking" ? "CHECKING SESSION" : "ENTER COMMAND CENTER"}</button></form>{loginMessage !== null && <small role="status">{loginMessage}</small>}<footer>NO SIGNER / NO BROADCASTER / NO REAL MONEY</footer></section></main>;

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brandmark">S</span><div><strong>Signal Deck</strong><small>Solana wallet intelligence</small></div></div>
      <div className="status-strip">
        <span className="status-pill"><Dot state={connection === "live" ? "healthy" : connection === "offline" ? "degraded" : "unknown"} />{connection}</span>
        <span className="status-pill">Bot <b>{status?.killSwitchActive ? "KILLED" : status?.watcherPaused ? "PAUSED" : "RUNNING"}</b></span><span className="status-pill">Worker <b>{status?.worker?.health ?? "UNKNOWN"}</b></span>
        <span className="status-pill">Network <b>{status?.network ?? "Unknown"}</b></span>
        <span className="mode-pill">{status?.executionMode ?? "PAPER"} / SIMULATED</span>
        <button className="status-pill" onClick={() => void runtimeAction(status?.watcherPaused ? "watcher/resume" : "watcher/pause")}>Watcher <b>{status?.watcherPaused ? "PAUSED" : status?.live?.status ?? "Unknown"}</b></button>
        <button className={`status-pill ${status?.killSwitchActive ? "danger" : ""}`} onClick={() => void runtimeAction(status?.killSwitchActive ? "shadow/restore" : "shadow/kill")}>Kill <b>{status?.killSwitchActive ? "ACTIVE" : "Ready"}</b></button>
        <button className="status-pill" onClick={() => void logout()}>Session <b>LOGOUT</b></button>
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
    <section className="grid equal">
      <article className="panel"><PanelHeader title="Research calibration" meta={`follower N=${research?.followerEvidenceSampleSize ?? "Unknown"} / decision N=${research?.deterministicDecisionOutcomeSampleSize ?? research?.sampleSize ?? "Unknown"}`} /><div className="telemetry"><span>Source events<b>{research?.followerSourceEventCount ?? "Unknown"}</b></span><span>Pending outcomes<b>{research?.pendingOutcomes ?? "Unknown"}</b></span><span>Candidates<b>{research?.candidateProgress.length ?? research?.candidates.length ?? 0}</b></span></div>{(research?.candidateProgress ?? []).slice(0, 8).map((item) => <div className="health-row" key={item.wallet}><span>{compact(item.wallet)}</span><b>{item.state}</b><small>samples {item.validFollowerSamples}/{item.requiredFollowerSamples} / tokens {item.independentTokens}/{item.requiredIndependentTokens} / score {item.score === null ? "Unknown" : item.score.toFixed(1)}</small></div>)}{research?.candidateProgress.length === 0 && <Empty text="No prospective follower evidence has accumulated yet."/>}</article>
      <article className="panel"><PanelHeader title="Operator security" meta={`${security?.activeSessions ?? 0} active session`} />{(security?.events ?? []).slice(0, 8).map((item) => <div className="health-row" key={item.id}><span>{item.type.replaceAll("_", " ")}</span><b>audited</b><small>{new Date(item.occurredAt).toLocaleTimeString()}</small></div>)}{security?.events.length === 0 && <Empty text="No recent security events."/>}</article>
    </section>

    <section className="grid equal">
      <article className="panel"><PanelHeader title="Durability" meta={`settings r${status?.runtimeSettings.revision ?? "?"}`} /><div className="telemetry"><span>Queue depth<b>{status?.durability.queueDepth ?? "Unknown"}</b></span><span>Overdue jobs<b>{status?.durability.overdueJobs ?? "Unknown"}</b></span><span>Oldest pending<b>{status?.durability.oldestPendingType ?? "None"}</b></span><span>Worker lease<b>{status?.worker?.health ?? "Unknown"}</b></span></div><div className="health-row"><span>Runtime authority</span><b>{status?.runtimeSettings.updatedBy ?? "Unknown"}</b><small>{status?.runtimeSettings.updatedAt === undefined ? "Unknown" : new Date(status.runtimeSettings.updatedAt).toLocaleTimeString()}</small></div></article>
      <article className="panel"><PanelHeader title="Database / providers" meta={status?.database?.ready ? "READY" : "NOT READY"} /><div className="health-row"><span>Migration revision</span><b>{status?.database?.current ?? "Unknown"}</b><small>expected {status?.database?.expected ?? "Unknown"}</small></div><div className="health-row"><span>Active chain provider</span><b>{status?.activeChainProvider ?? "Unknown"}</b><small>{readiness?.areas?.PROVIDER?.status ?? "UNAVAILABLE"} readiness</small></div><div className="health-row"><span>Latest shadow E2E</span><b>{e2e?.status ?? "NOT RUN"}</b><small>{e2e?.funnel === undefined ? "funnel unavailable" : `${e2e.funnel.recentTokens ?? "?"} tokens / ${e2e.funnel.candidateSeeds ?? "?"} seeds / ${e2e.funnel.candidateHistorySuccess ?? "?"} histories / ${e2e.funnel.trackEligible ?? "?"} eligible`}</small></div><div className="health-row"><span>E2E drop reasons</span><b>{e2e?.dropReasons === null || e2e?.dropReasons === undefined ? "Unavailable" : Object.values(e2e.dropReasons).reduce((sum, count) => sum + count, 0)}</b><small>{e2e?.dropReasons === null || e2e?.dropReasons === undefined ? "not reported" : Object.entries(e2e.dropReasons).map(([reason, count]) => `${reason}=${count}`).join(" / ") || "none"}</small></div><div className="health-row"><span>Short staging soak</span><b>{soak?.status ?? "NOT RUN"}</b><small>{soak?.durationMs === undefined || soak.durationMs === null ? "no artifact" : `${soak.durationMs} ms / ${soak.storeMode ?? "unknown store"}`}</small></div>{(status?.providerTelemetry ?? []).map((provider) => <div className="health-row" key={provider.provider}><span><Dot state={provider.health.toLowerCase()}/>{provider.provider}</span><b>{provider.health}</b><small>429 {provider.rateLimited ?? "Unknown"} / {provider.averageLatencyMs === null ? provider.detail : `${provider.averageLatencyMs} ms`}</small></div>)}{status?.providerTelemetry.length === 0 && <Empty text="Provider telemetry has no observations yet."/>}</article>
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
