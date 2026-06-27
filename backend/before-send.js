// Node-side PII scrubber (Phase 9b.1 / §9b.5) and forbidden-metric
// filter (§11.8). Hand-mirrored from `src/sentry-scrub.ts` on the RN
// side — the two run in different module systems (rollup-bundled ESM
// here, the RN bundle there) so a build-time copy isn't practical. Keep
// the two regex lists in lock-step; each file points at the other.
//
// Wired as a `Sentry.addEventProcessor` in `lib/sentry.js`'s `init`, so
// the same scrubbing + drop behaviour runs on Node-side events before
// they leave the FGS.
//
// Mirrored from `src/sentry-scrub.ts`. The broad base64-22 token rule (to
// catch bare rootKeys / public keys / project ids) is intentionally NOT
// enabled here either — it over-matched Sentry's own 32-hex trace_ids,
// PascalCase exception type names, and error_class metric tags, redacting
// data we need. Pending a narrower design agreed with the team; bare tokens
// are unscrubbed until then. Object fields keyed
// lat/lng/latitude/longitude are redacted regardless of value type; lat/lng
// markers redact the trailing number; HTTP breadcrumb URLs reduce to host-only.

const REDACTED = "[redacted]";

/** @type {RegExp[]} */
const SCRUB_PATTERNS = [
  /\broot[_-]?key\b\s*["']?\s*[:=]\s*\S+/gi,
  /\b(?:lat|lng|latitude|longitude)\b\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
];

/** Object keys whose value is a raw coordinate — redacted regardless of type. */
const SENSITIVE_KEY_PATTERN = /^(lat|lng|latitude|longitude)$/i;

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

/** @type {RegExp[]} */
const FORBIDDEN_METRIC_VALUE_PATTERNS = [
  /\b(?:lat|lng|latitude|longitude)\b\s*[:=]\s*-?\d+(?:\.\d+)?/i,
];

/** @param {string} input */
export function scrubString(input) {
  let out = input;
  for (const pattern of SCRUB_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Reduce an HTTP(S) URL to scheme + host. @param {string} url */
export function scrubUrlToHost(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return scrubString(url);
  }
}

/** @param {unknown} value @returns {unknown} */
function scrubValue(value) {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : scrubValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Walk every text field of a Sentry event and scrub it (§9b.1):
 * message, exception values, extra, contexts, request, breadcrumb
 * messages + data, span descriptions + attributes. HTTP breadcrumb and
 * request URLs reduce to host-only (§9b.5). Mutates and returns the event (event-processor
 * contract). Returns the event (never drops here — call-site capture is
 * the real fix; this is the net).
 *
 * @param {any} event
 * @returns {any}
 */
export function scrubEvent(event) {
  if (typeof event.message === "string") {
    event.message = scrubString(event.message);
  }

  if (event.exception && Array.isArray(event.exception.values)) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") ex.value = scrubString(ex.value);
      if (typeof ex.type === "string") ex.type = scrubString(ex.type);
    }
  }

  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubValue(event.extra);
  }
  if (event.contexts && typeof event.contexts === "object") {
    event.contexts = scrubValue(event.contexts);
  }

  if (event.request && typeof event.request === "object") {
    const req = event.request;
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

  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      scrubBreadcrumb(crumb);
    }
  }

  if (Array.isArray(event.spans)) {
    for (const span of event.spans) {
      if (typeof span.description === "string") {
        span.description = scrubString(span.description);
      }
      if (span.data && typeof span.data === "object") {
        span.data = scrubValue(span.data);
      }
    }
  }

  return event;
}

/**
 * Scrub one breadcrumb in place: HTTP URL → host-only (§9b.5), message
 * → string-scrubbed, data → recursively scrubbed.
 *
 * @param {any} crumb
 * @returns {any}
 */
export function scrubBreadcrumb(crumb) {
  if (
    (crumb.category === "http" ||
      crumb.category === "xhr" ||
      crumb.category === "fetch") &&
    crumb.data &&
    typeof crumb.data === "object"
  ) {
    if (typeof crumb.data.url === "string") {
      crumb.data.url = scrubUrlToHost(crumb.data.url);
    }
  }
  if (typeof crumb.message === "string") {
    crumb.message = scrubString(crumb.message);
  }
  if (crumb.data && typeof crumb.data === "object") {
    crumb.data = scrubValue(crumb.data);
  }
  return crumb;
}

/**
 * `true` when a metric should be dropped: its name or any tag name is on
 * the forbidden list, or any tag value matches a forbidden pattern
 * (§11.8 defensive gate).
 *
 * @param {string} name
 * @param {Record<string, string | number | boolean>} attributes
 */
export function isForbiddenMetric(name, attributes) {
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
