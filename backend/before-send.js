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
// False-positive trade-off (documented per §9b.1, mirrored from
// `src/sentry-scrub.ts`): the 22-char base64 pattern matches rootKey /
// project-id shapes but also any unrelated 22-char base64 token; we
// accept the occasional over-redaction because leaking a real project
// secret costs far more than a stray `[redacted]`. lat/lng markers
// redact the trailing number. HTTP breadcrumb URLs reduce to host-only.

const REDACTED = "[redacted]";

/** @type {RegExp[]} */
const SCRUB_PATTERNS = [
  /\broot[_-]?key\b\s*["']?\s*[:=]\s*\S+/gi,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g,
  /\b(?:lat|lng|latitude|longitude)\b\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
];

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
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/,
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
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v);
    return out;
  }
  return value;
}

/**
 * Walk every text field of a Sentry event and scrub it (§9b.1):
 * message, exception values, extra, contexts, breadcrumb messages +
 * data, span descriptions + attributes. HTTP breadcrumb URLs reduce to
 * host-only (§9b.5). Mutates and returns the event (event-processor
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
