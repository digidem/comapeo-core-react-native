/**
 * Shared PII scrubber and forbidden-metric filter
 * for the RN side. The Node side keeps a hand-mirrored copy in
 * `backend/before-send.js` (the two run in different module systems —
 * ESM-via-rollup vs the RN bundle — so a build-time copy isn't
 * practical). Keep the two regex lists in lock-step; each file points
 * at the other.
 *
 * Scrubbing is defence-in-depth: the real fix is to never capture
 * sensitive data at the call site. This net catches a malicious or
 * buggy host (and our own mistakes) before a payload leaves the device.
 *
 * What it redacts (and the false-positive trade-off):
 *   - Explicit `rootKey=…` markers (key=value / json / prose). A broad
 *     "any 22+-char base64url run" rule is deliberately NOT enabled — see
 *     the SCRUB_PATTERNS note below — so bare rootKeys/keys/project-ids
 *     with no marker are currently unscrubbed.
 *   - Object fields whose KEY is lat/lng/latitude/longitude are redacted
 *     regardless of value type — a numeric `{latitude: 12.3}` is the most
 *     likely capture shape and value-only scrubbing would miss it.
 *   - `lat=`/`lng=`/`latitude:`/`longitude:` markers redact the numeric
 *     value that follows. A sentence like "latitude: unknown" is
 *     redacted to "latitude: [redacted]" — harmless over-redaction.
 *   - HTTP breadcrumb URLs are reduced to host-only, dropping path +
 *     query: "https://cloud.comapeo.app/projects/abc?token=x"
 *     → "https://cloud.comapeo.app". We lose the path detail but keep
 *     "all requests to host X are failing" diagnosability.
 */

const REDACTED = "[redacted]";

/**
 * Patterns that, when matched anywhere in a string, get the match
 * replaced with `[redacted]`. Global so every occurrence in a field is
 * scrubbed.
 */
const SCRUB_PATTERNS: RegExp[] = [
  // Explicit rootKey markers (key=value, json, prose). The value stops at a
  // field delimiter (whitespace, `,;&`, quote) so co-located fields in a
  // compact string like `rootKey=abc,method=x` survive.
  /\broot[_-]?key\b\s*["']?\s*[:=]\s*[^\s,;&"']+/gi,
  // NOTE: a broad 22+-char URL-safe base64 rule (to catch bare rootKeys at
  // 22, public keys at 43, project ids at ~52) is intentionally NOT enabled
  // — it also matched Sentry's own 32-hex trace_ids, PascalCase exception
  // type names, and error_class metric tags, redacting data we need. Pending
  // a narrower design agreed with the team; bare tokens are unscrubbed until
  // then.
  // Latitude / longitude markers followed by a number.
  /\b(?:lat|lng|latitude|longitude)\b\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
];

/** Object keys whose value is a raw coordinate — redacted regardless of type. */
const SENSITIVE_KEY_PATTERN = /^(lat|lng|latitude|longitude)$/i;

/** Tag names/values that must never ride on a metric. */
const FORBIDDEN_METRIC_TAG_NAMES = new Set([
  "device.model",
  "device.id",
  "device.manufacturer",
  "os.version",
  "screen.resolution",
  "screen.density",
  "screen.dpi",
  "locale",
  "timezone",
  "project_id",
  "peer_id",
  "peer_count",
  "rootkey",
]);

/** Forbidden tag *values* — lat/lng shapes. (The broad base64-22 rule is
 *  held back here too; see the SCRUB_PATTERNS note above.) */
const FORBIDDEN_METRIC_VALUE_PATTERNS: RegExp[] = [
  /\b(?:lat|lng|latitude|longitude)\b\s*[:=]\s*-?\d+(?:\.\d+)?/i,
];

export function scrubString(input: string): string {
  let out = input;
  for (const pattern of SCRUB_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Reduce an HTTP(S) URL to scheme + host, dropping path/query/fragment. */
export function scrubUrlToHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Relative/opaque URL (no scheme/host) — new URL() throws. Drop the query
    // + fragment (where tokens ride), then string-scrub what remains. A plain
    // non-URL string has neither and passes through the string scrubber.
    return scrubString(url.replace(/[?#].*$/s, ""));
  }
}

type Json = unknown;

/** Max nesting depth walked before we stop (backstop against deep/hostile data). */
const MAX_SCRUB_DEPTH = 20;

function scrubValue(value: Json): Json {
  return scrubValueInner(value, new WeakSet(), 0);
}

function scrubValueInner(
  value: Json,
  seen: WeakSet<object>,
  depth: number,
): Json {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  // Breadcrumb data is scrubbed at add-time, before Sentry normalises cycles,
  // so guard against self-referential/over-deep data ourselves.
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_SCRUB_DEPTH) return "[Truncated]";
  seen.add(value);
  let out: Json;
  if (Array.isArray(value)) {
    out = value.map((v) => scrubValueInner(v, seen, depth + 1));
  } else {
    const record: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      record[k] = SENSITIVE_KEY_PATTERN.test(k)
        ? REDACTED
        : scrubValueInner(v, seen, depth + 1);
    }
    out = record;
  }
  seen.delete(value);
  return out;
}

type AnyRecord = Record<string, unknown>;

/**
 * Walk every text field of a Sentry event and scrub it:
 * message, exception values, extra, contexts, request, breadcrumb
 * messages + data, span descriptions + attributes. HTTP breadcrumb and
 * request URLs reduce to host-only. Mutates and returns the
 * event.
 */
export function scrubEvent(event: AnyRecord): AnyRecord {
  if (typeof event.message === "string") {
    event.message = scrubString(event.message);
  }

  const exception = event.exception as
    | { values?: AnyRecord[] }
    | undefined;
  if (exception?.values) {
    for (const ex of exception.values) {
      if (typeof ex.value === "string") ex.value = scrubString(ex.value);
      if (typeof ex.type === "string") ex.type = scrubString(ex.type);
    }
  }

  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubValue(event.extra) as AnyRecord;
  }
  if (event.contexts && typeof event.contexts === "object") {
    event.contexts = scrubValue(event.contexts) as AnyRecord;
  }

  if (event.request && typeof event.request === "object") {
    const req = event.request as AnyRecord;
    if (typeof req.url === "string") req.url = scrubUrlToHost(req.url);
    if (req.query_string != null) req.query_string = scrubValue(req.query_string);
    if (req.headers && typeof req.headers === "object") {
      req.headers = scrubValue(req.headers);
    }
    if (req.cookies && typeof req.cookies === "object") {
      req.cookies = scrubValue(req.cookies);
    }
    if (req.data != null) req.data = scrubValue(req.data);
  }

  const breadcrumbs = event.breadcrumbs as AnyRecord[] | undefined;
  if (Array.isArray(breadcrumbs)) {
    for (const crumb of breadcrumbs) {
      scrubBreadcrumb(crumb);
    }
  }

  const spans = event.spans as AnyRecord[] | undefined;
  if (Array.isArray(spans)) {
    for (const span of spans) {
      if (typeof span.description === "string") {
        span.description = scrubString(span.description);
      }
      if (span.data && typeof span.data === "object") {
        span.data = scrubValue(span.data) as AnyRecord;
      }
    }
  }

  return event;
}

/**
 * Scrub an HTTP breadcrumb's URL down to host-only. Other
 * breadcrumb categories pass through unchanged. Returns the (mutated)
 * breadcrumb, or `null` to drop — we never drop here, the host's chain
 * may.
 */
export function scrubBreadcrumb(crumb: AnyRecord): AnyRecord {
  if (
    (crumb.category === "http" || crumb.category === "xhr" || crumb.category === "fetch") &&
    crumb.data &&
    typeof crumb.data === "object"
  ) {
    const data = crumb.data as AnyRecord;
    if (typeof data.url === "string") {
      data.url = scrubUrlToHost(data.url);
    }
  }
  if (typeof crumb.message === "string") {
    crumb.message = scrubString(crumb.message);
  }
  if (crumb.data && typeof crumb.data === "object") {
    crumb.data = scrubValue(crumb.data) as AnyRecord;
  }
  return crumb;
}

/**
 * Scrub a structured log (the `Sentry.logger.*` channel): message
 * string-scrubbed, attributes recursively scrubbed. Wired as
 * `beforeSendLog` so logs get the same net as events/breadcrumbs.
 * Mutates and returns the log.
 */
export function scrubLog<T extends { message?: unknown; attributes?: unknown }>(
  log: T,
): T {
  if (typeof log.message === "string") {
    log.message = scrubString(log.message);
  }
  if (log.attributes && typeof log.attributes === "object") {
    log.attributes = scrubValue(log.attributes);
  }
  return log;
}

/**
 * `true` when a metric should be dropped: its name or any tag name is on
 * the forbidden list, or any tag value matches a forbidden pattern
 * (defensive gate).
 */
export function isForbiddenMetric(
  name: string,
  attributes: Record<string, string | number | boolean>,
): boolean {
  if (FORBIDDEN_METRIC_TAG_NAMES.has(name)) return true;
  for (const [tagName, tagValue] of Object.entries(attributes)) {
    if (FORBIDDEN_METRIC_TAG_NAMES.has(tagName)) return true;
    if (typeof tagValue === "string") {
      for (const pattern of FORBIDDEN_METRIC_VALUE_PATTERNS) {
        if (pattern.test(tagValue)) return true;
      }
    }
  }
  return false;
}
