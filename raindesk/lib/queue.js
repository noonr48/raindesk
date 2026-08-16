'use strict';

/**
 * One generation at a time: jobs run on a serial promise chain, so exactly one
 * ComfyUI job is in flight per server. Job state lives in a Map keyed by id:
 *   { id, status: 'pending' | 'done' | 'error', imageUrl?, error?, meta }
 * 'pending' covers queued-and-running (contract status set is exactly those 3).
 */

const MAX_JOBS = 200;
const MAX_PENDING = 4; // bounded pending depth: each pending job pins up to ~40MB of PNG buffers

class GenQueue {
  constructor({ store = null } = {}) {
    this._tail = Promise.resolve();
    this._jobs = new Map();
    this._seq = 0;
    this._pendingCount = 0;
    this._store = store;
    if (store && typeof store.list === 'function') {
      try {
        for (const job of store.list({ limit: 500 })) {
          const n = Number(job && job.id);
          if (Number.isInteger(n) && n > this._seq) this._seq = n;
        }
      } catch (_e) { /* persistence is optional */ }
    }
  }

  _persist(job) {
    if (!this._store || typeof this._store.upsert !== 'function') return;
    try { this._store.upsert(job); } catch (_e) { /* job execution must not depend on telemetry persistence */ }
  }

  /** Enqueue fn; returns the job id immediately. fn's result may carry imageUrl. */
  submit(fn, meta = {}) {
    const id = String(++this._seq);
    if (this._pendingCount >= MAX_PENDING) {
      // reject immediately as a settled error job (never throws; client sees
      // a friendly message on its first poll instead of pinning buffers)
      const job = { id, type: 'generation', status: 'error', phase: 'rejected', error: 'generation queue is full — try again in a moment', createdAt: Date.now(), meta };
      this._jobs.set(id, job);
      this._persist(job);
      this._prune();
      return id;
    }
    const job = { id, type: 'generation', status: 'pending', phase: 'queued', createdAt: Date.now(), meta };
    this._jobs.set(id, job);
    this._persist(job);
    this._pendingCount += 1;
    // _run never rejects, so the chain cannot break for later jobs.
    this._tail = this._tail.then(() => this._run(job, fn));
    this._prune();
    return id;
  }

  async _run(job, fn) {
    if (job.status === 'cancelled') {
      this._pendingCount -= 1;
      this._persist(job);
      return;
    }
    job.phase = 'running';
    job.startedAt = Date.now();
    this._persist(job);
    const setPhase = (phase) => {
      if (job.status !== 'pending') return;
      job.phase = String(phase || 'running').slice(0, 128);
      this._persist(job);
    };
    try {
      const result = await fn({ setPhase, jobId: job.id });
      job.result = result || null;
      if (result && typeof result === 'object' && result.imageUrl) job.imageUrl = result.imageUrl;
      if (result && typeof result === 'object' && result.takeId) job.takeId = result.takeId;
      if (result && typeof result === 'object' && result.resultAssetSha) job.resultAssetSha = result.resultAssetSha;
      if (result && typeof result === 'object' && result.comfyUrl) job.comfyUrl = result.comfyUrl;
      job.status = 'done';
      job.phase = 'complete';
      job.finishedAt = Date.now();
    } catch (e) {
      job.status = 'error';
      job.phase = 'failed';
      job.error = (e && e.message) ? String(e.message) : String(e);
      job.finishedAt = Date.now();
    }
    this._pendingCount -= 1;
    this._persist(job);
  }

  /** Cancel only a job that has not begun. Running GPU work is not lied about. */
  cancel(id) {
    const job = this.get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.status !== 'pending') return { ok: false, reason: 'settled', job };
    if (job.phase !== 'queued') return { ok: false, reason: 'running', job };
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.finishedAt = Date.now();
    this._persist(job);
    return { ok: true, job };
  }

  get(id) {
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    return this._jobs.get(String(id)) || null;
  }

  /** Public JSON view of a job (GET /api/gen/{id}). */
  view(job) {
    if (!job) return null;
    const out = {
      id: job.id, status: job.status, phase: job.phase || null,
      createdAt: job.createdAt || null, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    };
    if (job.status === 'done' && job.imageUrl) out.imageUrl = job.imageUrl;
    if (job.status === 'done' && typeof job.comfyUrl === 'string') out.comfyUrl = job.comfyUrl;
    else if (job.status === 'done' && job.result && typeof job.result.comfyUrl === 'string') out.comfyUrl = job.result.comfyUrl;
    if (job.status === 'done' && typeof job.takeId === 'string') out.takeId = job.takeId;
    else if (job.status === 'done' && job.result && typeof job.result.takeId === 'string') out.takeId = job.result.takeId;
    if (job.status === 'done' && typeof job.resultAssetSha === 'string') out.resultAssetSha = job.resultAssetSha;
    else if (job.status === 'done' && job.result && typeof job.result.resultAssetSha === 'string') out.resultAssetSha = job.result.resultAssetSha;
    if (job.status === 'error') out.error = job.error || 'generation failed';
    if (job.status === 'cancelled') out.error = 'generation cancelled before it started';
    return out;
  }

  /** Drop oldest settled jobs past the cap; pending jobs are never dropped. */
  _prune() {
    if (this._jobs.size <= MAX_JOBS) return;
    for (const [key, job] of this._jobs) {
      if (this._jobs.size <= MAX_JOBS) break;
      if (job.status !== 'pending') this._jobs.delete(key);
    }
  }
}

module.exports = { GenQueue, MAX_JOBS, MAX_PENDING };
