"use client";

import { useCallback, useEffect, useState } from "react";

interface ComponentHealth { component: string; status: "healthy" | "degraded" | "disabled" | "unknown"; detail: string; latencyMs: number | null }
interface SystemStatus { executionMode: string; network: string; killSwitchActive: boolean; lastProcessedSlot: string | null; queueLagMs: number | null; components: ComponentHealth[] }
interface Wallet { id: string; publicKey: string; status: string; dataConfidence: number | null; metrics: null | { sampleSize: number; earlyEntryScore: number | null; copyabilityScore: number | null; crowdingScore: number | null } }
interface Signal { id: string; sourceWallet: string; tokenMint: string; detectedAt: string; decision: string; antiCrowdingScore: number | null; rejectionReasons: string[]; walletScore: { total: number } }
interface Position { id: string; tokenMint: string; triggerWallet: string; simulatedEntryPriceUsd: string | null; simulatedUsdAmount: string; markPriceUsd: string | null; unrealizedPnlUsd: string | null; state: string; openedAt: string; exitRecommendation: string | null }
interface Copyability { id: string; sourceWallet: string; sourceTransactionSignature: string; tokenMint: string; status: "KNOWN" | "PARTIAL" | "UNKNOWN"; sourceEffectivePrice: string | null; followerQuotedPrice: string | null; entryPriceDeteriorationBps: number | null; detectionLatencyMs: number | null; totalFollowerLatencyMs: number | null; confidence: string; reasons: string[] }

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const compact = (value: string): string => value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
const percent = (value: number | null): string => value === null ? "Unknown" : `${Math.round(value * 100)}%`;
const milliseconds = (value: number | null): string => value === null ? "Unknown" : `${value} ms`;

function Dot({ state }: { state: string }): React.ReactElement { return <span className={`dot ${state}`} aria-hidden="true" />; }

export function CommandCenter(): React.ReactElement {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [copyability, setCopyability] = useState<Copyability[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [selected, setSelected] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [statusResponse, walletResponse, signalResponse, positionResponse, copyabilityResponse] = await Promise.all([
        fetch(`${apiUrl}/api/system/status`), fetch(`${apiUrl}/api/wallets`), fetch(`${apiUrl}/api/signals`), fetch(`${apiUrl}/api/positions`), fetch(`${apiUrl}/api/copyability/recent?limit=20`)
      ]);
      if (![statusResponse, walletResponse, signalResponse, positionResponse, copyabilityResponse].every((response) => response.ok)) throw new Error("API unavailable");
      setStatus(await statusResponse.json() as SystemStatus);
      setWallets(await walletResponse.json() as Wallet[]);
      setSignals(await signalResponse.json() as Signal[]);
      const nextPositions = await positionResponse.json() as Position[];
      setPositions(nextPositions);
      setCopyability(await copyabilityResponse.json() as Copyability[]);
      setSelected((current) => current ?? nextPositions[0]?.id ?? null);
      setConnection("live");
    } catch { setConnection("offline"); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => window.clearInterval(timer); }, [refresh]);

  const position = positions.find((item) => item.id === selected) ?? null;
  const act = async (operation: "wait" | "recalculate" | "authorize-paper-sell"): Promise<void> => {
    if (position === null) return;
    setActionMessage("Submitting…");
    try {
      const response = await fetch(`${apiUrl}/api/positions/${position.id}/${operation}`, { method: "POST" });
      if (!response.ok) throw new Error("Request rejected");
      setActionMessage(operation === "authorize-paper-sell" ? "Paper sell authorized and recorded." : "Action recorded.");
      await refresh();
    } catch { setActionMessage("Action could not be completed. Check API health."); }
  };

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brandmark">S</span><div><strong>Signal Deck</strong><small>Solana wallet intelligence</small></div></div>
      <div className="status-strip">
        <span className="status-pill"><Dot state={connection === "live" ? "healthy" : connection === "offline" ? "degraded" : "unknown"} />{connection}</span>
        <span className="status-pill">Network <b>{status?.network ?? "—"}</b></span>
        <span className="mode-pill">{status?.executionMode ?? "PAPER"} · SIMULATED</span>
        <span className={`status-pill ${status?.killSwitchActive ? "danger" : ""}`}>Kill switch <b>{status?.killSwitchActive ? "ACTIVE" : "Ready"}</b></span>
      </div>
    </header>

    <section className="hero">
      <div><p className="eyebrow">OBSERVATION TERMINAL</p><h1>Follow the signal.<br/><span>Measure the delay.</span></h1><p>Deterministic intelligence for latency-adjusted, anti-crowded wallet signals.</p></div>
      <div className="hero-stat"><small>Execution posture</small><strong>Paper only</strong><span>Live signing is not installed</span></div>
    </section>

    <section className="grid two-one">
      <article className="panel">
        <PanelHeader title="Live intelligence feed" meta={`${signals.length} signals`} />
        <div className="feed-head"><span>Wallet / token</span><span>Score</span><span>Crowding</span><span>Decision</span><span>Detected</span></div>
        {signals.length === 0 ? <Empty text="No normalized signals yet. Production API never substitutes demo trades." /> : signals.map((signal) =>
          <div className="feed-row" key={signal.id}><span><b>{compact(signal.sourceWallet)}</b><small>{compact(signal.tokenMint)}</small></span><Score value={signal.walletScore.total}/><span>{percent(signal.antiCrowdingScore)}</span><span className={`decision ${signal.decision.toLowerCase()}`}>{signal.decision}</span><time>{new Date(signal.detectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}
      </article>

      <article className="panel health-panel">
        <PanelHeader title="System health" meta="15s refresh" />
        {(status?.components ?? []).map((item) => <div className="health-row" key={item.component}><span><Dot state={item.status}/>{item.component.replace("_", " ")}</span><b>{item.status}</b><small>{item.latencyMs === null ? item.detail : `${item.latencyMs} ms`}</small></div>)}
        {status === null && <Empty text="Waiting for API health telemetry."/>}
        <div className="telemetry"><span>Last slot<b>{status?.lastProcessedSlot ?? "Unknown"}</b></span><span>Queue lag<b>{status?.queueLagMs === null || status?.queueLagMs === undefined ? "Unknown" : `${status.queueLagMs} ms`}</b></span></div>
      </article>
    </section>

    <section className="panel copyability-panel">
      <PanelHeader title="Copyability ledger" meta={`${copyability.length} recent evaluations`} />
      <div className="copy-head"><span>Source / token</span><span>Source price</span><span>Follower quote</span><span>Deterioration</span><span>Detection</span><span>Total latency</span><span>Confidence</span></div>
      {copyability.map((item) => <div className="copy-row" key={item.id}>
        <span><b>{compact(item.sourceWallet)}</b><small>{compact(item.tokenMint)} / {compact(item.sourceTransactionSignature)}</small></span>
        <span>{item.sourceEffectivePrice ?? "Unknown"}</span><span>{item.followerQuotedPrice ?? "Unknown"}</span>
        <span className={item.entryPriceDeteriorationBps !== null && item.entryPriceDeteriorationBps > 0 ? "negative" : "positive"}>{item.entryPriceDeteriorationBps === null ? "Unknown" : `${item.entryPriceDeteriorationBps} bps`}</span>
        <span>{milliseconds(item.detectionLatencyMs)}</span><span>{milliseconds(item.totalFollowerLatencyMs)}</span>
        <span><i className={`confidence ${item.status.toLowerCase()}`}>{item.confidence}</i><small>{item.status === "KNOWN" ? "Complete observation" : item.reasons.join(", ") || item.status}</small></span>
      </div>)}
      {copyability.length === 0 && <Empty text="No copyability evaluation is stored yet. Missing quotes and timings remain explicitly unknown." />}
    </section>

    <section className="grid equal">
      <article className="panel">
        <PanelHeader title="Tracked wallets" meta={`${wallets.length} tracked`} />
        <div className="table-scroll"><table><thead><tr><th>Wallet</th><th>Status</th><th>Samples</th><th>Early</th><th>Copyable</th><th>Crowding</th><th>Confidence</th></tr></thead><tbody>
          {wallets.map((wallet) => <tr key={wallet.id}><td className="mono">{compact(wallet.publicKey)}</td><td><span className="tag">{wallet.status}</span></td><td>{wallet.metrics?.sampleSize ?? "—"}</td><td>{percent(wallet.metrics?.earlyEntryScore ?? null)}</td><td>{percent(wallet.metrics?.copyabilityScore ?? null)}</td><td>{percent(wallet.metrics?.crowdingScore ?? null)}</td><td>{percent(wallet.dataConfidence)}</td></tr>)}
        </tbody></table>{wallets.length === 0 && <Empty text="Track a wallet through the API to begin observation." />}</div>
      </article>

      <article className="panel">
        <PanelHeader title="Paper positions" meta={`${positions.filter((item) => item.state !== "closed").length} open`} />
        <div className="positions">
          {positions.map((item) => <button className={`position-row ${selected === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelected(item.id)}><span className="token-icon">◈</span><span><b>{compact(item.tokenMint)}</b><small>via {compact(item.triggerWallet)}</small></span><span><small>Entry</small>${item.simulatedEntryPriceUsd}</span><span><small>Mark</small>{item.markPriceUsd === null ? "Unknown" : `$${item.markPriceUsd}`}</span><span className={item.unrealizedPnlUsd?.startsWith("-") ? "negative" : "positive"}>{item.unrealizedPnlUsd === null ? "P/L unknown" : `$${item.unrealizedPnlUsd}`}</span></button>)}
          {positions.length === 0 && <Empty text="Approved signals appear here only after verified paper-price input." />}
        </div>
      </article>
    </section>

    <section className="panel detail">
      <PanelHeader title="Position control" meta={position === null ? "No selection" : `State: ${position.state}`} />
      <div className="detail-grid">
        <div><small>Selected token</small><strong>{position === null ? "—" : compact(position.tokenMint)}</strong><p>{position?.exitRecommendation ?? "No exit recommendation. A recommendation never authorizes a sale."}</p></div>
        <div className="controls"><button disabled={position === null || position.state === "closed"} className="sell" onClick={() => void act("authorize-paper-sell")}>SELL PAPER</button><button disabled={position === null || position.state === "closed"} onClick={() => void act("wait")}>WAIT</button><button disabled={position === null || position.state === "closed"} onClick={() => void act("recalculate")}>RECALCULATE</button><button disabled title="Manual-control transition is reserved for the reviewed follow-up implementation">MANUAL CONTROL</button></div>
      </div>
      {actionMessage !== null && <p className="action-message" role="status">{actionMessage}</p>}
    </section>
    <footer><span>Signal Deck</span><span>Simulation environment · unknown data remains unknown</span></footer>
  </main>;
}

function PanelHeader({ title, meta }: { title: string; meta: string }): React.ReactElement { return <div className="panel-head"><h2>{title}</h2><span>{meta}</span></div>; }
function Empty({ text }: { text: string }): React.ReactElement { return <div className="empty"><span>◇</span><p>{text}</p></div>; }
function Score({ value }: { value: number }): React.ReactElement { return <span className="score"><i style={{ "--score": `${value}%` } as React.CSSProperties}/><b>{value.toFixed(0)}</b></span>; }
