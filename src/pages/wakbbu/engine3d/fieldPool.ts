import { computeField, FIELD_H, type FieldResult } from "./plateField";

/**
 * Runs the heavy per-ball precomputation off the touch path.
 * - Preferred: one Web Worker (a separate core; the page never waits on it).
 * - Fallback (worker unavailable): the main thread computes in idle slices (requestIdleCallback,
 *   setTimeout where Safari lacks it), a few rows at a time, so frames keep their budget.
 * Jobs run one at a time, highest priority first; bump() moves a ball the finger is already on to the front.
 */

type Job = {
  id: number;
  kind: "field" | "detail";
  priority: number;
  payload: { seeds?: Float32Array; seed?: number; w?: number; h?: number };
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
};

type IdleDeadline = { timeRemaining(): number };
const ric = (cb: (d: IdleDeadline) => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb, { timeout: 120 });
  else setTimeout(() => { const t0 = performance.now(); cb({ timeRemaining: () => Math.max(0, 6 - (performance.now() - t0)) }); }, 16);
};

/** Runs `fn` when the main thread is idle (requestIdleCallback; setTimeout on Safari). */
export function onIdle(fn: () => void) { ric(() => fn()); }

export type FieldTicket = { promise: Promise<FieldResult>; bump(): void; cancel(): void };

export class FieldPool {
  private worker: Worker | null = null;
  private workerFailed = false;
  private queue: Job[] = [];
  private running: Job | null = null;
  private nextId = 1;
  private disposed = false;

  constructor() {
    try {
      this.worker = new Worker(new URL("./plateField.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => this.onDone(e.data);
      this.worker.onerror = () => this.failWorker();
    } catch {
      this.workerFailed = true;
    }
  }

  field(seeds: Float32Array, priority = 0): FieldTicket {
    let job!: Job;
    const promise = new Promise<FieldResult>((resolve, reject) => {
      job = { id: this.nextId++, kind: "field", priority, payload: { seeds }, resolve: resolve as (r: unknown) => void, reject };
    });
    this.enqueue(job);
    return {
      promise,
      bump: () => { if (job.priority < 10) { job.priority = 10; this.queue.sort((a, b) => b.priority - a.priority); } },
      cancel: () => { const i = this.queue.indexOf(job); if (i >= 0) { this.queue.splice(i, 1); job.reject(new Error("cancelled")); } },
    };
  }

  detail(seed: number, w: number, h: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.enqueue({ id: this.nextId++, kind: "detail", priority: -1, payload: { seed, w, h }, resolve: resolve as (r: unknown) => void, reject });
    });
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate(); this.worker = null;
    for (const j of this.queue) j.reject(new Error("disposed"));
    this.queue = [];
  }

  private enqueue(job: Job) {
    if (this.disposed) { job.reject(new Error("disposed")); return; }
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
  }

  private pump() {
    if (this.running || !this.queue.length || this.disposed) return;
    const job = this.queue.shift()!;
    this.running = job;
    if (this.worker && !this.workerFailed) {
      // the worker gets a copy of the seeds; nothing the ball still needs is transferred away
      this.worker.postMessage(job.kind === "field" ? { id: job.id, kind: "field", seeds: job.payload.seeds!.slice() } : { id: job.id, kind: "detail", ...job.payload });
    } else {
      this.runOnMainThread(job);
    }
  }

  private onDone(msg: { id: number; ok: boolean; result?: unknown; error?: string }) {
    const job = this.running;
    if (!job || job.id !== msg.id) return;
    this.running = null;
    if (msg.ok) job.resolve(msg.result); else job.reject(new Error(msg.error));
    this.pump();
  }

  private failWorker() {
    // a worker that cannot load (old browser, CSP): redo the current job and the rest on the main thread
    this.workerFailed = true;
    this.worker?.terminate(); this.worker = null;
    const job = this.running;
    this.running = null;
    if (job) this.queue.unshift(job);
    this.pump();
  }

  /** Main-thread fallback: a few rows per idle slice so no frame loses more than a few ms. */
  private runOnMainThread(job: Job) {
    if (job.kind === "detail") {
      // ~50–400 ms in one go: not worth a main-thread stall; the flat placeholder stays (cosmetic only)
      job.reject(new Error("detail map skipped without a worker"));
      this.running = null; this.pump();
      return;
    }
    let y = 0;
    let res: FieldResult | undefined;
    const slice = (d: IdleDeadline) => {
      if (this.disposed) return;
      do {
        const y1 = Math.min(FIELD_H, y + 8);
        res = computeField(job.payload.seeds!, y, y1, res);
        y = y1;
      } while (y < FIELD_H && d.timeRemaining() > 3);
      if (y < FIELD_H) { ric(slice); return; }
      this.running = null;
      job.resolve(res);
      this.pump();
    };
    ric(slice);
  }
}
