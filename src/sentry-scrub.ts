/**
 * Shared PII scrubber (Phase 9b.1 / §9b.5) and forbidden-metric filter
 * (§11.8) for the RN side. The Node side keeps a hand-mirrored copy in
 * `backend/before-send.js` (the two run in different module systems —
 * ESM-via-rollup vs the RN bundle — so a build-time copy isn't
 * practical). Keep the two regex lists in lock-step; each file points
 * at the other.
 *
 * Scrubbing is defence-in-depth: the real fix is to never capture
 * sensitive data at the call site. This net catches a malicious or
 * buggy host (and our own mistakes) before a payload leaves the device.
 *
 * False-positive trade-off (documented per the §9b.1 requirement):
 *   - The 22-char base64 pattern matches CoMapeo rootKey / project-id
 *     shapes, but ALSO any unrelated 22-char base64 token (some JWT
 *     segments, git blob fragments, nonces). We accept the occasional
 *     over-redaction of a harmless token because the cost of leaking a
 *     real project secret is far higher than the cost of a `[redacted]`
 *     in a log line. Example matches:
 *       "aGVsbG8td29ybGQtMTIzNA"  → redacted (real rootkey shape)
 *       "bm90LWEtcmVhbC1rZXktMQ"  → redacted (harmless, false positive)
 *   - `lat=`/`lng=`/`latitude:`/`longitude:` markers redact the numeric
 *     value that follows. A sentence like "latitude: unknown" is
 *     redacted to "latitude: [redacted]" — harmless over-redaction.
 *   - HTTP breadcrumb URLs are reduced to host-only, dropping path +
 *     query (§9b.5): "https://cloud.comapeo.app/projects/abc?token=x"
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
  // Explicit rootKey markers (key=value, json, prose).
  /\broot[_-]?key\b\s*["']?\s*[:=]\s*\S+/gi,
  // 22-char URL-safe base64 (rootKey / hashed project-id shape). Bounded
  // by non-base64 chars so we don't bite into longer strings mid-token.
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g,
  // Latitude / longitude markers followed by a number.
  /\b(?:lat|lng|latitude|longitude)\b\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
];

/** Tag names/values that must never ride on a metric (§11.8). */
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

/** Reused for forbidden tag *values* — base64-22 / lat-lng shapes. */
const FORBIDDEN_METRIC_VALUE_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/,
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
    // Not a parseable URL — fall back to the string scrubber.
    return scrubString(url);
  }
}

type Json = unknown;

function scrubValue(value: Json): Json {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}

type AnyRecord = Record<string, unknown>;

/**
 * Walk every text field of a Sentry event and scrub it (§9b.1):
 * message, exception values, extra, contexts, breadcrumb messages +
 * data, span descriptions + attributes. Mutates and returns the event.
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

  const breadcrumbs = event.breadcrumbs as AnyRecord[] | undefined;
  if (Array.isArray(breadcrumbs)) {
    for (const crumb of breadcrumbs) {
      if (typeof crumb.message === "string") {
        crumb.message = scrubString(crumb.message);
      }
      if (crumb.data && typeof crumb.data === "object") {
        crumb.data = scrubValue(crumb.data) as AnyRecord;
      }
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
 * Scrub an HTTP breadcrumb's URL down to host-only (§9b.5). Other
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
  return crumb;
}

/**
 * `true` when a metric should be dropped: its name or any tag name is on
 * the forbidden list, or any tag value matches a forbidden pattern
 * (§11.8 defensive gate).
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
