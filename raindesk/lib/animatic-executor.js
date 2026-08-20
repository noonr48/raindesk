'use strict';

/**
 * Bounded no-shell hand-off to animatic_timing_v1.
 *
 * Only an approved server-prepared invocation may enter this module. External
 * output stays untrusted until animatic-candidates validates and mirrors it.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const adapters = require('./production-adapters');
const ledger = require('./partner-invocation-ledger');
const snapshots = require('./animatic-snapshots');
const executionStore = require('./animatic-execution-store');
const candidates = require('./animatic-candidates');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const RUN_ROOT = path.join(DATA_DIR, 'animatic', 'external-runs');
const MAX_STDIO_BYTES = 1024 * 1024;
const inFlight = new Map();

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function approvedInvocation(id) {
  const key = text(id, 96);
  if (!key) throw new HttpError(400, 'invocationId is required');
  const entry = ledger.find(ledger.read(), key);
  if (!entry) throw new HttpError(404, 'no such animatic invocation');
  if (entry.origin !== 'server_prepared' || entry.adapterId !== 'animatic_timing_v1' ||
      entry.capabilityId !== 'animatic_timing' || entry.invocationBoundary !== 'external' ||
      entry.reviewRequired !== true || entry.creativeMutation !== true ||
      !entry.parentRequestId || !entry.sourceSnapshotDigest) {
    throw new HttpError(409, 'invocation is not an exact server-prepared animatic execution request');
  }
  if (!['approved', 'handed_off'].includes(entry.status)) throw new HttpError(409, 'animatic invocation is not approved for execution');
  return entry;
}

function parseResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const payload = JSON.parse(line);
      if (payload && typeof payload === 'object') return payload;
    } catch (_error) { /* keep looking for the terminal JSON line */ }
  }
  throw new HttpError(502, 'animatic worker did not return a valid terminal result');
}

function runProcess(executable, args, { env, timeoutMs, onSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killedFor = null;
    let settled = false;
    let timer = null;

    function append(current, chunk) {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > MAX_STDIO_BYTES) {
        killedFor = 'stdio_limit';
        if (child) child.kill('SIGKILL');
        return next.subarray(0, MAX_STDIO_BYTES);
      }
      return next;
    }

    try {
      child = childProcess.spawn(executable, args, {
        shell: false,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ spawned: false, code: null, stdout: '', stderr: '', error, killedFor: 'spawn_failed' });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('spawn', () => {
      try { if (typeof onSpawn === 'function') onSpawn(child); }
      catch (error) {
        killedFor = 'handoff_rejected';
        child.kill('SIGKILL');
        stderr = append(stderr, Buffer.from(String(error && error.message ? error.message : error)));
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ spawned: false, code: null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), error, killedFor: killedFor || 'spawn_failed' });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        spawned: true,
        code,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        error: null,
        killedFor,
      });
    });
    timer = setTimeout(() => {
      killedFor = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function publicResult(execution, candidateRecord = null) {
  return {
    execution: executionStore.publicRow(execution),
    candidate: candidateRecord ? candidates.publicRecord(candidateRecord) : null,
  };
}

/** Synchronous authority + idempotency + run-begin prefix, shared by the
 *  awaited execute() and the detached start() paths. */
function beginRun(invocationId, { retry = false, env = process.env } = {}) {
  const invocation = approvedInvocation(invocationId);
  const runtime = adapters.configuredAnimaticRuntime(env);
  if (!runtime) throw new HttpError(503, 'animatic runtime is not completely configured');

  const existing = executionStore.latestForInvocation(invocation.id);
  if (existing) {
    if (existing.status === 'succeeded') {
      const candidate = existing.candidateId ? candidates.read(existing.candidateId) : null;
      return { kind: 'done', result: publicResult(existing, candidate) };
    }
    if (existing.status === 'running') return { kind: 'done', result: publicResult(existing, null) };
    if (['failed', 'interrupted'].includes(existing.status) && !retry) {
      throw new HttpError(409, 'previous animatic execution failed or was interrupted; explicit retry=true is required');
    }
  }

  if (!existing && invocation.status !== 'approved') {
    throw new HttpError(409, 'handed-off animatic invocation has no recoverable execution record');
  }
  if (existing && ['failed', 'interrupted'].includes(existing.status) && !['approved', 'handed_off'].includes(invocation.status)) {
    throw new HttpError(409, 'animatic invocation can no longer be retried');
  }

  // Re-read and integrity-check immediately before the external hand-off.
  const snapshot = snapshots.read(invocation.sourceSnapshotDigest);
  if (snapshot.adapter_id !== 'animatic_timing_v1' || snapshot.adapter_contract_version !== '0.2.0') {
    throw new HttpError(409, 'approved snapshot no longer satisfies the animatic adapter contract');
  }
  const snapshotFile = snapshots.snapshotPath(invocation.sourceSnapshotDigest);

  const localAttempt = executionStore.begin({
    invocationId: invocation.id,
    snapshotDigest: invocation.sourceSnapshotDigest,
  });
  const attemptRunRoot = path.join(RUN_ROOT, localAttempt.executionId);
  const projectRoot = path.join(runtime.projectRoot, localAttempt.executionId);
  fs.mkdirSync(attemptRunRoot, { recursive: true, mode: 0o700 });

  const args = [
    '--snapshot', snapshotFile,
    '--project-root', projectRoot,
    '--out-dir', attemptRunRoot,
  ];
  // Least-privilege child environment: a deliberate allowlist, never the
  // whole parent environment — tokens, credentials and unrelated application
  // configuration must not reach an external executor process. Universal
  // process keys (PATH/HOME/TMPDIR/locale) come from the parent only when the
  // configured runtime env does not carry them; every other key must be a
  // declared Raindesk/video-skill variable or an explicitly declared test fake.
  const UNIVERSAL_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
  const DECLARED_KEYS = [
    'RAINDESK_ANIMATIC_EXECUTOR', 'RAINDESK_ANIMATIC_PROJECT_ROOT',
    'RAINDESK_SOURCE_RIGHTS', 'RAINDESK_ANIMATIC_TIMEOUT_MS',
    'RAINDESK_ANIMATIC_FPS_NUM', 'RAINDESK_ANIMATIC_FPS_DEN',
    'SLOANE_VIDEO_ALLOWED_ROOTS',
    // Test fakes declared by the animatic test harness (executor tests +
    // browser smokes). Production never sets these.
    'FAKE_MODE', 'FAKE_SLEEP_MS', 'FAKE_COUNTER_FILE',
  ];
  const childEnv = {};
  for (const key of UNIVERSAL_KEYS) {
    if (env && env[key] != null) childEnv[key] = String(env[key]);
    else if (process.env[key] != null) childEnv[key] = String(process.env[key]);
  }
  for (const key of DECLARED_KEYS) {
    if (env && env[key] != null) childEnv[key] = String(env[key]);
  }
  childEnv.SLOANE_VIDEO_ALLOWED_ROOTS = runtime.projectRoot;
  return { kind: 'run', invocation, runtime, localAttempt, attemptRunRoot, args, childEnv };
}

/** Awaited external run + durable terminal recording on every path; shared
 *  by execute() (awaited) and start() (background). */
async function completeRun(run) {
  const { invocation, runtime, localAttempt, attemptRunRoot, args, childEnv } = run;
  const processResult = await runProcess(runtime.executable, args, {
    env: childEnv,
    timeoutMs: runtime.timeoutMs,
    onSpawn: () => {
      const current = ledger.find(ledger.read(), invocation.id);
      if (!current || !['approved', 'handed_off'].includes(current.status)) {
        throw new HttpError(409, 'animatic approval changed before process hand-off');
      }
      if (current.status === 'approved') ledger.setStatus(invocation.id, 'handed_off');
    },
  });

  if (!processResult.spawned) {
    const row = executionStore.update(localAttempt.executionId, {
      status: 'failed', errorCode: 'spawn_failed', error: processResult.error && processResult.error.message,
    });
    throw Object.assign(new HttpError(502, 'animatic worker could not be started'), { execution: executionStore.publicRow(row) });
  }
  if (processResult.killedFor || processResult.code !== 0) {
    const code = processResult.killedFor || `exit_${processResult.code}`;
    const row = executionStore.update(localAttempt.executionId, {
      status: 'failed', errorCode: code,
      error: `${processResult.stderr || ''}\n${processResult.stdout || ''}`.trim(),
    });
    throw Object.assign(new HttpError(502, 'animatic worker failed to produce a candidate'), { execution: executionStore.publicRow(row) });
  }

  let terminal;
  try { terminal = parseResult(processResult.stdout); }
  catch (error) {
    const row = executionStore.update(localAttempt.executionId, {
      status: 'failed', errorCode: 'malformed_result', error: processResult.stdout,
    });
    throw Object.assign(error, { execution: executionStore.publicRow(row) });
  }
  if (terminal.ok !== true || typeof terminal.run_dir !== 'string' || typeof terminal.attempt_id !== 'string' || typeof terminal.candidate_id !== 'string') {
    const row = executionStore.update(localAttempt.executionId, {
      status: 'failed', errorCode: 'malformed_result', error: JSON.stringify(terminal),
    });
    throw Object.assign(new HttpError(502, 'animatic worker terminal result is incomplete'), { execution: executionStore.publicRow(row) });
  }

  let imported;
  try {
    imported = candidates.importExternal({
      runRoot: attemptRunRoot,
      runDir: terminal.run_dir,
      invocationId: invocation.id,
      snapshotDigest: invocation.sourceSnapshotDigest,
      expectedAttemptId: terminal.attempt_id,
      expectedCandidateId: terminal.candidate_id,
    });
  } catch (error) {
    const row = executionStore.update(localAttempt.executionId, {
      status: 'failed', errorCode: 'invalid_external_output', error: error && error.message,
    });
    throw Object.assign(new HttpError(502, 'animatic worker output failed Raindesk validation'), { execution: executionStore.publicRow(row) });
  }

  const succeeded = executionStore.update(localAttempt.executionId, {
    status: 'succeeded',
    externalAttemptId: terminal.attempt_id,
    candidateId: terminal.candidate_id,
  });
  return publicResult(succeeded, imported);
}

async function executeOnce(invocationId, options = {}) {
  const run = beginRun(invocationId, options);
  if (run.kind === 'done') return run.result;
  return completeRun(run);
}

/** Detached start for async preview: performs the authority prefix and the
 *  durable run-begin synchronously, returns the running execution row
 *  immediately, and completes the external run in the background (terminal
 *  state is recorded durably on every path; the store is the source of
 *  truth for polling). In-flight dedup matches execute(): a repeated start
 *  returns the existing execution and never spawns twice. */
function start(invocationId, { retry = false, env = process.env } = {}) {
  const key = text(invocationId, 96);
  if (!key) throw new HttpError(400, 'invocationId is required');
  if (inFlight.has(key)) {
    const row = executionStore.latestForInvocation(key);
    return { execution: row ? executionStore.publicRow(row) : null, started: false };
  }
  const run = beginRun(key, { retry, env });
  if (run.kind === 'done') return { execution: run.result.execution, candidate: run.result.candidate, started: false };
  const background = completeRun(run)
    .catch((error) => { console.error('[animatic] background execution failed:', error && error.message); }) // eslint-disable-line no-console
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, background);
  return { execution: executionStore.publicRow(run.localAttempt), started: true };
}

function execute(invocationId, options = {}) {
  const key = text(invocationId, 96);
  if (!key) return Promise.reject(new HttpError(400, 'invocationId is required'));
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = executeOnce(key, options).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

module.exports = {
  DATA_DIR, RUN_ROOT, MAX_STDIO_BYTES, inFlight,
  approvedInvocation, parseResult, runProcess, publicResult, beginRun, completeRun, executeOnce, execute, start,
};
