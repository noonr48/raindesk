'use strict';

/** Persistent metadata for long-running Raindesk jobs. No image buffers here. */
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const MAX_JOBS = 1000;
function now() { return Date.now(); }
function emptyStore() { return { schemaVersion: 1, jobs: [], updatedAt: now() }; }
function atomicWrite(v) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${JOBS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, JOBS_PATH);
}
function read() {
  let raw;
  try { raw = fs.readFileSync(JOBS_PATH, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') { const s = emptyStore(); atomicWrite(s); return s; } throw e; }
  let s;
  try { s = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'job store is corrupt'); }
  if (!s || s.schemaVersion !== 1 || !Array.isArray(s.jobs)) throw new HttpError(500, 'job store is malformed');
  return s;
}
function clean(job) {
  return {
    id: String(job.id), type: String(job.type || 'generation').slice(0, 64),
    status: String(job.status || 'pending').slice(0, 32), phase: String(job.phase || '').slice(0, 128),
    createdAt: Number(job.createdAt) || now(), startedAt: Number(job.startedAt) || null, finishedAt: Number(job.finishedAt) || null,
    meta: job.meta && typeof job.meta === 'object' ? JSON.parse(JSON.stringify(job.meta)) : {},
    imageUrl: typeof job.imageUrl === 'string' ? job.imageUrl : null,
    takeId: typeof job.takeId === 'string' ? job.takeId.slice(0, 160) : null,
    resultAssetSha: typeof job.resultAssetSha === 'string' ? job.resultAssetSha.slice(0, 64) : null,
    comfyUrl: typeof job.comfyUrl === 'string' ? job.comfyUrl.slice(0, 4000) : null,
    error: typeof job.error === 'string' ? job.error.slice(0, 4000) : null,
  };
}
function upsert(job) {
  const s = read(); const value = clean(job); const i = s.jobs.findIndex((j) => j.id === value.id);
  if (i === -1) s.jobs.push(value); else s.jobs[i] = value;
  if (s.jobs.length > MAX_JOBS) s.jobs.splice(0, s.jobs.length - MAX_JOBS);
  s.updatedAt = now(); atomicWrite(s); return value;
}
function get(id) { return read().jobs.find((j) => j.id === String(id)) || null; }
function list({ shotId = null, limit = 100 } = {}) {
  let jobs = read().jobs;
  if (shotId) jobs = jobs.filter((j) => j.meta && j.meta.shotId === shotId);
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return jobs.slice(-n).reverse();
}
function recoverInterrupted() {
  const s = read(); let changed = 0;
  for (const job of s.jobs) {
    if (job.status === 'pending') {
      job.status = 'error'; job.phase = 'interrupted'; job.error = 'Raindesk restarted before this job finished'; job.finishedAt = now(); changed += 1;
    }
  }
  if (changed) { s.updatedAt = now(); atomicWrite(s); }
  return changed;
}
module.exports = { DATA_DIR, JOBS_PATH, MAX_JOBS, emptyStore, read, upsert, get, list, recoverInterrupted };
