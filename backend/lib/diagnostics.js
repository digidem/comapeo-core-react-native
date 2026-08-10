// Cause-level diagnostics for backend event-loop stalls (leaveProject
// timeout investigation). Three independent probes, all no-ops until
// `init()` runs with a live Sentry ref:
//
// 1. `profileRpc` — wraps selected long-running RPCs in a V8 sampling
//    CPU profile (`node:inspector`). The profiler samples on its own
//    thread, so it sees through a blocked main loop and names the
//    function holding it. Feature-detected: nodejs-mobile may be built
//    without the inspector, in which case this is a transparent no-op.
// 2. Sync-sqlite ledger — times every better-sqlite3 statement and
//    captures any that exceed a threshold, with the SQL text (our own
//    SQL strings, never bound parameters). Synchronous sqlite is the
//    top suspect for a blocked loop.
// 3. GC observer — breadcrumbs for long GC pauses so a collector stall
//    is distinguishable from sqlite and from application code.

import inspector from "node:inspector";
import { PerformanceObserver, performance } from "node:perf_hooks";

/** @type {typeof import("@sentry/node-core") | null} */
let Sentry = null;

// Sqlite statements ≥ breadcrumb threshold leave a trail; ≥ capture
// threshold create a fingerprinted warning event. Thresholds are high
// enough that indexing chatter never fires them.
const SQLITE_BREADCRUMB_MS = 1_000;
const SQLITE_CAPTURE_MS = 5_000;
const GC_BREADCRUMB_MS = 200;

// Profile RPCs that are known to block for long periods. `invite.accept`
// covers `addProject` (it runs inside accept).
const PROFILE_RPC_METHODS = new Set(["leaveProject", "invite.accept"]);
// A profiled RPC that hasn't returned by this deadline gets its profile
// captured mid-flight — round-1 field data showed these RPCs sometimes
// never complete before the app is killed.
const PROFILE_DEADLINE_MS = 45_000;
// Only capture the profile when the RPC was actually slow.
const PROFILE_CAPTURE_MS = 10_000;

/**
 * @param {{ Sentry: typeof import("@sentry/node-core") }} args
 */
export async function init(args) {
  Sentry = args.Sentry;
  // Eager availability check so every boot logs whether profiling is
  // possible on this node build (nodejs-mobile may lack the inspector).
  checkProfilerAvailable();
  observeGc();
  await installSqliteLedger();
}

// ── GC pauses ───────────────────────────────────────────────────────

function observeGc() {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < GC_BREADCRUMB_MS) continue;
        Sentry?.addBreadcrumb({
          category: "gc",
          level: "info",
          message: `GC pause ${Math.round(entry.duration)} ms`,
          data: {
            durationMs: Math.round(entry.duration),
            kind: /** @type {any} */ (entry).detail?.kind,
          },
        });
      }
    });
    obs.observe({ entryTypes: ["gc"] });
  } catch {
    // Older node without 'gc' entries — skip.
  }
}

// ── Sync-sqlite ledger ──────────────────────────────────────────────

async function installSqliteLedger() {
  /** @type {any} */
  let Database;
  try {
    ({ default: Database } = await import("better-sqlite3"));
  } catch {
    return;
  }

  /**
   * @param {string} op
   * @param {string} sql
   * @param {number} durationMs
   */
  const record = (op, sql, durationMs) => {
    if (durationMs < SQLITE_BREADCRUMB_MS || !Sentry) return;
    const sqlSnippet = String(sql).slice(0, 200);
    Sentry.addBreadcrumb({
      category: "sqlite.slow",
      level: "warning",
      message: `sqlite ${op} ${Math.round(durationMs)} ms: ${sqlSnippet}`,
      data: { op, durationMs: Math.round(durationMs) },
    });
    if (durationMs >= SQLITE_CAPTURE_MS) {
      Sentry.captureMessage("Slow synchronous sqlite statement", {
        level: "warning",
        fingerprint: ["slow-sqlite"],
        extra: { op, durationMs: Math.round(durationMs), sql: sqlSnippet },
      });
    }
  };

  /**
   * Wrap a synchronous method so its duration is recorded. Bound per
   * call site; the fast path is one `performance.now()` pair.
   *
   * @param {any} obj
   * @param {string} method
   * @param {string} op
   * @param {(args: unknown[]) => string} getSql
   */
  const wrap = (obj, method, op, getSql) => {
    const orig = obj[method];
    if (typeof orig !== "function") return;
    obj[method] = function (/** @type {unknown[]} */ ...args) {
      const start = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        const durationMs = performance.now() - start;
        if (durationMs >= SQLITE_BREADCRUMB_MS) {
          record(op, getSql(args), durationMs);
        }
      }
    };
  };

  wrap(Database.prototype, "exec", "exec", (args) => String(args[0]));
  wrap(Database.prototype, "pragma", "pragma", (args) => String(args[0]));

  // Statements: wrap what `prepare` returns. Statement methods live on a
  // per-class prototype, but instances tolerate shadowing; the source
  // SQL is bound into each wrapper.
  const origPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function (/** @type {string} */ sql) {
    const stmt = origPrepare.call(this, sql);
    for (const method of ["run", "get", "all"]) {
      wrap(stmt, method, method, () => sql);
    }
    return stmt;
  };
}

// ── RPC CPU profiling ───────────────────────────────────────────────

let profilerAvailable = null;
let profiling = false;

function checkProfilerAvailable() {
  if (profilerAvailable !== null) return profilerAvailable;
  try {
    const session = new inspector.Session();
    session.connect();
    session.disconnect();
    profilerAvailable = true;
  } catch {
    profilerAvailable = false;
  }
  console.log(`diagnostics: CPU profiler available: ${profilerAvailable}`);
  return profilerAvailable;
}

/**
 * @param {inspector.Session} session
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<any>}
 */
function post(session, method, params) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (err, result) =>
      err ? reject(err) : resolve(result),
    );
  });
}

/**
 * Aggregate a V8 CPU profile into per-function self time and return the
 * top frames as display lines. Keeps the capture payload small — the
 * raw profile can be megabytes.
 *
 * @param {any} profile
 * @returns {string[]}
 */
export function summarizeProfile(profile) {
  /** @type {Map<number, any>} */
  const nodesById = new Map();
  for (const node of profile.nodes ?? []) nodesById.set(node.id, node);
  /** @type {Map<string, number>} */
  const selfTimeUs = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = nodesById.get(samples[i]);
    if (!node) continue;
    const cf = node.callFrame ?? {};
    const url = String(cf.url ?? "").split("/").slice(-2).join("/");
    const key = `${cf.functionName || "(anonymous)"} (${url}:${cf.lineNumber ?? "?"})`;
    selfTimeUs.set(key, (selfTimeUs.get(key) ?? 0) + (deltas[i] ?? 0));
  }
  return [...selfTimeUs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([key, us]) => `${Math.round(us / 1000)}ms ${key}`);
}

/**
 * Run `fn` under a CPU profile when `method` is in the profile set. On a
 * slow completion (≥ PROFILE_CAPTURE_MS) — or mid-flight at the
 * deadline if the call never returns — capture the top self-time
 * frames. Transparent pass-through when the profiler is unavailable,
 * Sentry is off, or another profile is already running.
 *
 * @param {string} method
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
export async function profileRpc(method, fn) {
  if (
    !Sentry ||
    !PROFILE_RPC_METHODS.has(method) ||
    profiling ||
    !checkProfilerAvailable()
  ) {
    return fn();
  }

  profiling = true;
  const session = new inspector.Session();
  const start = performance.now();
  let stopped = false;

  /** @param {string} status */
  const stopAndCapture = async (status) => {
    if (stopped) return;
    stopped = true;
    try {
      const { profile } = await post(session, "Profiler.stop");
      const durationMs = performance.now() - start;
      if (durationMs >= PROFILE_CAPTURE_MS) {
        Sentry?.captureMessage(`RPC profile: ${method}`, {
          level: "warning",
          fingerprint: ["rpc-profile", method],
          extra: {
            durationMs: Math.round(durationMs),
            status,
            topFramesBySelfTime: summarizeProfile(profile),
          },
        });
      }
    } catch {
      // Profile retrieval failed — nothing to capture.
    } finally {
      try {
        session.disconnect();
      } catch {
        /* already disconnected */
      }
      profiling = false;
    }
  };

  try {
    session.connect();
    await post(session, "Profiler.enable");
    // 1ms sampling: the profiled RPCs run for seconds-to-minutes, and
    // the finer grain names short-but-hot frames inside a stall.
    await post(session, "Profiler.setSamplingInterval", { interval: 1000 });
    await post(session, "Profiler.start");
  } catch {
    try {
      session.disconnect();
    } catch {
      /* noop */
    }
    profiling = false;
    return fn();
  }

  // If the RPC outlives the deadline, capture what we have — the timer
  // can only fire once the loop unblocks, which is exactly when the
  // profile becomes readable.
  const deadline = setTimeout(() => {
    stopAndCapture("still-running").catch(() => {});
  }, PROFILE_DEADLINE_MS);
  deadline.unref?.();

  try {
    return await fn();
  } finally {
    clearTimeout(deadline);
    stopAndCapture("completed").catch(() => {});
  }
}
