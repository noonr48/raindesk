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
  constructor() {
    this._tail = Promise.resolve();
    this._jobs = new Map();
    this._seq = 0;
    this._pendingCount = 0;
  }

  /** Enqueue fn; returns the job id immediately. fn's result may carry imageUrl. */
  submit(fn, meta = {}) {
    const id = String(++this._seq);
    if (this._pendingCount >= MAX_PENDING) {
      // reject immediately as a settled error job (never throws; client sees
      // a friendly message on its first poll instead of pinning buffers)
      const job = { id, status: 'error', error: 'generation queue is full — try again in a moment', createdAt: Date.now(), meta };
      this._jobs.set(id, job);
      this._prune();
      return id;
    }
    const job = { id, status: 'pending', createdAt: Date.now(), meta };
    this._jobs.set(id, job);
    this._pendingCount += 1;
    // _run never rejects, so the chain cannot break for later jobs.
    this._tail = this._tail.then(() => this._run(job, fn));
    this._prune();
    return id;
  }

  async _run(job, fn) {
    try {
      const result = await fn();
      job.result = result || null;
      if (result && typeof result === 'object' && result.imageUrl) {
        job.imageUrl = result.imageUrl;
      }
      job.status = 'done';
      job.finishedAt = Date.now();
    } catch (e) {
      job.status = 'error';
      job.error = (e && e.message) ? String(e.message) : String(e);
      job.finishedAt = Date.now();
    }
    this._pendingCount -= 1;
  }

  get(id) {
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    return this._jobs.get(String(id)) || null;
  }

  /** Public JSON view of a job (GET /api/gen/{id}). */
  view(job) {
    if (!job) return null;
    const out = { id: job.id, status: job.status };
    if (job.status === 'done' && job.imageUrl) out.imageUrl = job.imageUrl;
    if (job.status === 'done' && job.result && typeof job.result.comfyUrl === 'string') out.comfyUrl = job.result.comfyUrl;
    if (job.status === 'error') out.error = job.error || 'generation failed';
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
