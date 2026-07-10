// Pure assertion core for scripts/sentry-tripwire.mjs. No network and no
// process state: it takes Sentry event payloads (the JSON returned by
// `GET /api/0/projects/{org}/{project}/events/{id}/json/`) and returns
// failures/warnings, so it is unit-testable with fixture JSON
// (see sentry-tripwire-core.test.mjs).
//
// The expected boot-trace shape is documented in
// docs/sentry-integration.md §7.3.2 and checked manually in
// docs/sentry-release-smoke.md — keep the three in sync.

/** Child span ops expected inside the native `comapeo.boot` transaction. */
const NATIVE_BOOT_SPANS = {
  android: ["boot.fgs-launch", "boot.node-spawn", "boot.rootkey-load"],
  ios: ["boot.node-spawn", "boot.rootkey-load"],
};

/**
 * Node-side boot spans arrive as their own transaction events in the same
 * trace (they are root spans in the Node SDK), not as child spans of
 * `comapeo.boot`.
 */
const NODE_BOOT_TRANSACTIONS = ["boot.loader-init", "boot.manager-init"];

// Mirrors the scrub patterns in backend/before-send.js /
// src/sentry-scrub.ts. A match in an event that reached Sentry means the
// scrubbers missed it (or were never installed).
const PII_STRING_PATTERNS = [
  /\broot[_-]?key\b\s*["']?\s*[:=]\s*[^\s,;&"']+/gi,
  /\b(?:latitude|longitude|lat|lng|lon)\b\s*["']?\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
];

/** Object keys that must never carry an unredacted value. */
const PII_KEY_PATTERN = /^(rootkey|root_key|lat|lng|lon|latitude|longitude)$/i;

const REDACTED = "[redacted]";

/**
 * Discover query for finding the boot transaction of a specific run.
 * Exactly one of `traceId` / `environment` must be set.
 *
 * @param {{ traceId?: string, environment?: string }} selector
 * @returns {string}
 */
export function buildDiscoveryQuery({ traceId, environment }) {
  if ((traceId ? 1 : 0) + (environment ? 1 : 0) !== 1) {
    throw new Error("Pass exactly one of traceId / environment");
  }
  const marker = traceId ? `trace:${traceId}` : `environment:${environment}`;
  return `transaction:comapeo.boot ${marker}`;
}

/**
 * Event payloads carry tags as `[[key, value], ...]`, `[{key, value}, ...]`
 * (API-processed form), or a plain object depending on which endpoint and
 * SDK produced them. Normalise to a plain object.
 *
 * @param {any} payload
 * @returns {Record<string, string>}
 */
export function normalizeTags(payload) {
  const tags = payload?.tags;
  /** @type {Record<string, string>} */
  const out = {};
  if (!tags) return out;
  if (Array.isArray(tags)) {
    for (const entry of tags) {
      if (Array.isArray(entry) && entry.length >= 2) {
        out[String(entry[0])] = String(entry[1]);
      } else if (entry && typeof entry === "object" && "key" in entry) {
        out[String(entry.key)] = String(entry.value);
      }
    }
    return out;
  }
  if (typeof tags === "object") {
    for (const [k, v] of Object.entries(tags)) out[k] = String(v);
  }
  return out;
}

/**
 * `op`s of the child spans in a transaction payload.
 *
 * @param {any} payload
 * @returns {string[]}
 */
export function spanOps(payload) {
  if (!Array.isArray(payload?.spans)) return [];
  return payload.spans
    .map((/** @type {any} */ s) => s?.op)
    .filter((/** @type {unknown} */ op) => typeof op === "string");
}

/**
 * PII markers found anywhere in an event payload. Walks every string
 * value (rootkey/coordinate markers inside messages, span descriptions,
 * breadcrumbs, ...) and every object key (a raw `rootKey` / `lat` field
 * that the scrubbers should have redacted). Returns bounded
 * `path: snippet` descriptions so the report shows what leaked without
 * re-leaking much.
 *
 * @param {unknown} value
 * @param {string} [path]
 * @param {string[]} [found]
 * @param {number} [depth]
 * @returns {string[]}
 */
export function findPii(value, path = "$", found = [], depth = 0) {
  if (depth > 30 || found.length >= 20) return found;
  if (typeof value === "string") {
    for (const pattern of PII_STRING_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of value.matchAll(pattern)) {
        if (match[0].includes(REDACTED)) continue;
        found.push(`${path}: ${match[0].slice(0, 60)}`);
      }
    }
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findPii(v, `${path}[${i}]`, found, depth + 1));
    return found;
  }
  for (const [k, v] of Object.entries(value)) {
    const childPath = `${path}.${k}`;
    if (PII_KEY_PATTERN.test(k) && v != null && v !== REDACTED) {
      found.push(`${childPath}: unredacted value under a sensitive key`);
    }
    findPii(v, childPath, found, depth + 1);
  }
  return found;
}

/**
 * @param {any} payload
 * @returns {string | undefined}
 */
function traceIdOf(payload) {
  return payload?.contexts?.trace?.trace_id;
}

/**
 * Assert the fetched trace has the expected shape. `payloads` should be
 * every transaction event found for one trace (the `comapeo.boot`
 * transaction plus the Node-side `boot.*` transactions).
 *
 * @param {any[]} payloads
 * @param {{
 *   platform?: "android" | "ios",
 *   environment?: string,
 *   release?: string,
 * }} [opts]
 * @returns {{ ok: boolean, failures: string[], warnings: string[], info: string[] }}
 */
export function evaluateBootTrace(payloads, opts = {}) {
  const platform = opts.platform ?? "android";
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const info = [];

  const boot = payloads.find(
    (p) =>
      p?.transaction === "comapeo.boot" ||
      p?.contexts?.trace?.op === "comapeo.boot",
  );

  if (!boot) {
    failures.push(
      `No comapeo.boot transaction among the ${payloads.length} fetched event(s)`,
    );
  } else {
    info.push(
      `comapeo.boot event ${boot.event_id ?? "?"} ` +
        `(release=${boot.release ?? "?"}, environment=${boot.environment ?? "?"})`,
    );

    if (boot.contexts?.trace?.op !== "comapeo.boot") {
      failures.push(
        `Boot transaction op is ${JSON.stringify(boot.contexts?.trace?.op)}, expected "comapeo.boot"`,
      );
    }

    const ops = spanOps(boot);
    for (const op of NATIVE_BOOT_SPANS[platform]) {
      if (!ops.includes(op)) {
        failures.push(
          `comapeo.boot is missing child span ${op} (has: ${ops.join(", ") || "none"})`,
        );
      }
    }
    if (platform === "android" && !ops.includes("boot.extract-assets")) {
      warnings.push(
        "boot.extract-assets span absent — expected only on the first boot " +
          "after an install/update, so re-check on a fresh install",
      );
    }

    const tags = normalizeTags(boot);
    const expectedProc = platform === "android" ? "fgs" : "main";
    if (tags.proc !== expectedProc) {
      failures.push(
        `Boot transaction tag proc=${JSON.stringify(tags.proc)}, expected "${expectedProc}"`,
      );
    }
    if (tags.layer !== "native") {
      failures.push(
        `Boot transaction tag layer=${JSON.stringify(tags.layer)}, expected "native"`,
      );
    }
    if (!tags["comapeo.rn"]) {
      failures.push("Boot transaction is missing the comapeo.rn version tag");
    }

    if (platform === "android") {
      const family = boot.contexts?.device?.family;
      if (family !== "Android") {
        failures.push(
          family === "Google"
            ? 'contexts.device.family is "Google" on the FGS boot transaction — ' +
                "the SentryFgsBridge device.family processor is not running"
            : `contexts.device.family is ${JSON.stringify(family)} on the FGS boot transaction, expected "Android"`,
        );
      }
    }

    const bootTraceId = traceIdOf(boot);
    for (const name of NODE_BOOT_TRANSACTIONS) {
      const nodeTx = payloads.find(
        (p) => p?.transaction === name && traceIdOf(p) === bootTraceId,
      );
      if (!nodeTx) {
        failures.push(
          `No ${name} transaction in trace ${bootTraceId ?? "?"} — ` +
            "the Node-side SDK produced nothing or lost the trace parent",
        );
      } else if (normalizeTags(nodeTx).layer !== "node") {
        failures.push(`${name} transaction is missing the layer=node tag`);
      }
    }
  }

  for (const payload of payloads) {
    const label = `${payload?.transaction ?? "?"} (${payload?.event_id ?? "?"})`;
    if (opts.environment && payload?.environment !== opts.environment) {
      failures.push(
        `${label}: environment=${JSON.stringify(payload?.environment)}, expected "${opts.environment}"`,
      );
    }
    if (opts.release && payload?.release !== opts.release) {
      failures.push(
        `${label}: release=${JSON.stringify(payload?.release)}, expected "${opts.release}"`,
      );
    }
    const pii = findPii(payload);
    if (pii.length > 0) {
      failures.push(`${label}: possible PII in event JSON: ${pii.join(" | ")}`);
    }
  }

  return { ok: failures.length === 0, failures, warnings, info };
}
