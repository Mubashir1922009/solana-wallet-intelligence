import { newId } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { IntelligenceStore } from "./store.js";
import type { RuntimeJob, RuntimeJobType, WorkerLease } from "./runtime-domain.js";

export interface RuntimeJobHandler { (job: RuntimeJob): Promise<void> }
export type RuntimeJobHandlers = Partial<Record<RuntimeJobType, RuntimeJobHandler>>;

export function newRuntimeJob(type: RuntimeJobType, payload: JsonValue, runAt: string, idempotencyKey: string, maxAttempts = 5, createdAt = new Date().toISOString()): RuntimeJob {
  return { id: newId(), type, payload, status: "PENDING", runAt, createdAt, startedAt: null, completedAt: null, attempts: 0, maxAttempts: Math.max(1, Math.min(20, maxAttempts)), leaseOwner: null, leaseExpiresAt: null, lastError: null, idempotencyKey };
}

export interface DurableWorkerOptions {
  workerId: string;
  leaseMs?: number;
  batchSize?: number;
  retryBaseMs?: number;
  revision?: string;
  now?: () => Date;
}

export class DurableRuntimeWorker {
  private leader = false;
  private startedAt: string | null = null;
  constructor(private readonly store: IntelligenceStore, private readonly handlers: RuntimeJobHandlers, private readonly options: DurableWorkerOptions) {}

  async acquireLeadership(): Promise<boolean> {
    const now = this.now();
    this.startedAt ??= now;
    this.leader = await this.store.acquireWorkerLease(this.lease("STARTING", now, 0, 0), now);
    return this.leader;
  }

  async heartbeat(lastProcessedSlot: bigint | null, activeSubscriptions: number): Promise<boolean> {
    if (!this.leader) return false;
    const now = this.now();
    const depth = await this.store.countPendingRuntimeJobs(now);
    this.leader = await this.store.heartbeatWorkerLease(this.lease("HEALTHY", now, activeSubscriptions, depth, lastProcessedSlot));
    return this.leader;
  }

  async runOnce(): Promise<{ claimed: number; completed: number; failed: number }> {
    if (!this.leader && !await this.acquireLeadership()) return { claimed: 0, completed: 0, failed: 0 };
    const now = this.now();
    const expires = new Date(Date.parse(now) + (this.options.leaseMs ?? 30_000)).toISOString();
    const jobs = await this.store.claimRuntimeJobs(this.options.workerId, now, expires, this.options.batchSize ?? 10);
    let completed = 0; let failed = 0;
    for (const job of jobs) {
      const handler = this.handlers[job.type];
      try {
        if (handler === undefined) throw new Error("JOB_HANDLER_UNAVAILABLE");
        await handler(job);
        if (await this.store.completeRuntimeJob(job.id, this.options.workerId, this.now())) completed += 1;
      } catch (error) {
        const code = sanitizeError(error);
        const delay = Math.min(3_600_000, (this.options.retryBaseMs ?? 1_000) * 2 ** Math.max(0, job.attempts - 1));
        await this.store.failRuntimeJob(job.id, this.options.workerId, this.now(), new Date(Date.parse(this.now()) + delay).toISOString(), code);
        failed += 1;
      }
    }
    return { claimed: jobs.length, completed, failed };
  }

  async restorePositionMonitoring(intervalMs: number): Promise<number> {
    const now = Date.parse(this.now()); let scheduled = 0;
    for (const position of await this.store.listPositions()) {
      if (position.state === "closed") continue;
      const due = new Date(Math.max(now, Date.parse(position.updatedAt) + intervalMs)).toISOString();
      const result = await this.store.enqueueRuntimeJob(newRuntimeJob("POSITION_MARK", { positionId: position.id }, due, `position-mark:${position.id}:${due}`, 8));
      if (result === "inserted") scheduled += 1;
    }
    return scheduled;
  }

  async stop(): Promise<void> { await this.store.releaseWorkerLease(this.options.workerId, this.now()); this.leader = false; }
  isLeader(): boolean { return this.leader; }
  private now(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
  private lease(status: WorkerLease["status"], now: string, activeSubscriptions: number, queueDepth: number, lastProcessedSlot: bigint | null = null): WorkerLease {
    return { role: "SHADOW_RUNTIME", workerId: this.options.workerId, startedAt: this.startedAt ?? now, heartbeatAt: now, leaseExpiresAt: new Date(Date.parse(now) + (this.options.leaseMs ?? 30_000)).toISOString(), status, lastProcessedSlot, activeSubscriptions, queueDepth, revision: this.options.revision ?? null };
  }
}

export function workerHealth(lease: WorkerLease | null, now = new Date().toISOString()): "HEALTHY" | "STALE" | "OFFLINE" {
  if (lease === null) return "OFFLINE";
  return lease.leaseExpiresAt > now && lease.status !== "STOPPING" ? "HEALTHY" : "STALE";
}

function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN_JOB_ERROR";
  return error.message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 160) || error.name;
}
