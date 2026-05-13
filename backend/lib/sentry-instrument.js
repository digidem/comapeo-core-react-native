// Single point of contact for Sentry instrumentation in the Node backend.
//
// loader.mjs stashes the live `@sentry/node` namespace + config on
// globalThis when `--sentryDsn` is present. This module reads from
// globalThis (instead of statically importing `@sentry/node`) so the
// rollup chunk stays unloaded for consumers without Sentry. When Sentry
// is off, every export here is a no-op — call sites can stay
// unconditional and read like the boot story they describe.

import os from "node:os";
import fs from "node:fs";

/** @type {any} */
const Sentry = /** @type {any} */ (globalThis).__comapeoSentry ?? null;
/** @type {{ rpcArgsBytes: number, captureApplicationData: boolean } | null} */
const config =
  /** @type {any} */ (globalThis).__comapeoSentryConfig ?? null;

export const enabled = Sentry !== null;

/**
 * Wrap a boot phase: span + throw-error tagging with `.phase = name`
 * for `handleFatal` attribution. `name` is the wire phase
 * (`NodeJSService.kt` / `NodeJSService.swift` taxonomy). Span `op`/`name`
 * defaults to `boot.<name>`; override via `options.op` when the
 * dashboard label diverges from the wire phase. `options.span = false`
 * skips span creation but keeps the phase tag — for reliably-fast
 * phases that would only add trace noise.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ op?: string, span?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function bootPhase(name, fn, options) {
  const op = options?.op ?? `boot.${name}`;
  if (!Sentry || options?.span === false) {
    try {
      return await fn();
    } catch (e) {
      throw Object.assign(/** @type {any} */ (e), { phase: name });
    }
  }
  // `op` matches `name` so Discover renders the phase identifier as
  // `span.name`. Filter all boot spans with `op:boot.*`.
  return Sentry.startSpan(
    { name: op, op },
    async (/** @type {any} */ span) => {
      try {
        const r = await fn();
        span?.setStatus?.({ code: 1, message: "ok" });
        return r;
      } catch (e) {
        span?.setStatus?.({ code: 2, message: "internal_error" });
        throw Object.assign(/** @type {any} */ (e), { phase: name });
      }
    },
  );
}

/**
 * Capture a fatal error with the boot phase + a best-effort
 * device-context snapshot. `@sentry/node` doesn't synthesise device
 * context the way sentry-cocoa / sentry-android do, so OOM and
 * disk-full crashes have no `device.free_memory` / `device.free_storage`
 * in the Sentry UI without this. Field names match Sentry's standard
 * device-context schema so they render alongside the platform-side
 * values.
 *
 * Never throws. No-op when Sentry is off.
 *
 * @param {string} phase
 * @param {Error} err
 * @param {{ storageDir?: string, source?: string }} [opts]
 */
export function captureFatal(phase, err, opts = {}) {
  if (!Sentry) return;
  try {
    const deviceCtx = readDeviceMemoryAndStorage(opts.storageDir);
    Sentry.captureException(err, {
      tags: {
        phase,
        layer: "node",
        ...(opts.source ? { source: opts.source } : {}),
      },
      ...(deviceCtx ? { contexts: { device: deviceCtx } } : {}),
    });
  } catch (captureErr) {
    console.error("Failed to capture Sentry event", captureErr);
  }
}

/**
 * Flush pending Sentry events. Resolves to `true` when off so callers
 * can `await` unconditionally.
 *
 * @param {number} maxMs
 * @returns {Promise<boolean>}
 */
export function flush(maxMs) {
  if (!Sentry) return Promise.resolve(true);
  return Sentry.flush(maxMs).catch(() => false);
}

/**
 * Install the sink that loader.mjs's forwarding transport pushes
 * envelopes into. Frames captured before this call sit in a 100-item
 * ring buffer in loader.mjs and drain into the sink on registration.
 *
 * No-op when Sentry is off.
 *
 * @param {(frame: { type: string } & import("type-fest").JsonObject) => void} sink
 */
export function setSink(sink) {
  if (!Sentry) return;
  const installer = /** @type {any} */ (globalThis).__comapeoSentrySetSink;
  if (typeof installer === "function") installer(sink);
}

/**
 * Build the `onRequestHook` that `ComapeoRpcServer` installs. Returns
 * `undefined` when Sentry is off so the server stays unaware of the
 * integration.
 *
 * RPC args carry potential PII (observation fields, attachment paths)
 * so capture is opt-in via the `--sentryRpcArgsBytes` flag (read here
 * from `__comapeoSentryConfig`). Errors are NOT rethrown —
 * rpc-reflector already sends the error response from inside `next`,
 * and an unhandled rejection would funnel into `handleFatal` and kill
 * the process for a routine RPC error.
 *
 * @returns {((request: any, next: any) => void) | undefined}
 */
export function makeRpcHook() {
  if (!Sentry) return undefined;
  const rpcArgsBytes = config?.rpcArgsBytes ?? 0;
  return (request, next) => {
    const sentryTrace = request.metadata?.["sentry-trace"];
    const baggage = request.metadata?.baggage;
    /** @type {Record<string, unknown>} */
    const attributes = { "rpc.method": request.method.join(".") };
    if (rpcArgsBytes > 0) {
      try {
        const stringified = JSON.stringify(request.args);
        attributes["rpc.args"] =
          stringified.length > rpcArgsBytes
            ? stringified.slice(0, rpcArgsBytes)
            : stringified;
      } catch {
        attributes["rpc.args"] = "<unserializable>";
      }
    }
    Sentry.continueTrace({ sentryTrace, baggage }, () => {
      Sentry.startSpan(
        {
          op: "rpc",
          name: request.method.join("."),
          forceTransaction: true,
          attributes,
        },
        /** @param {{ setStatus(s: { code: number, message?: string }): void }} span */
        async (span) => {
          try {
            await next(request);
            span.setStatus({ code: 1, message: "ok" });
          } catch (error) {
            span.setStatus({ code: 2, message: "internal_error" });
            Sentry.captureException(error, {
              tags: { layer: "node", op: "rpc" },
            });
          }
        },
      );
    });
  };
}

/**
 * Capture an arbitrary exception (escape hatch — prefer `bootPhase` /
 * `captureFatal` / `makeRpcHook`). Currently used only by the temporary
 * smoke-test hook in `index.js`.
 *
 * @param {Error} err
 */
export function captureException(err) {
  if (!Sentry) return;
  Sentry.captureException(err);
}

/**
 * @param {string} [storageDir]
 * @returns {Record<string, number> | null}
 */
function readDeviceMemoryAndStorage(storageDir) {
  try {
    /** @type {Record<string, number>} */
    const ctx = {
      memory_size: os.totalmem(),
      free_memory: os.freemem(),
    };
    if (storageDir) {
      try {
        const stats = fs.statfsSync(storageDir);
        ctx.storage_size = stats.bsize * stats.blocks;
        ctx.free_storage = stats.bsize * stats.bavail;
      } catch {
        // statfs unsupported / path missing — omit storage fields only.
      }
    }
    return ctx;
  } catch {
    return null;
  }
}
