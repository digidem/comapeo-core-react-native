/**
 * Shim for the npm `undici` package, aliased in at bundle time.
 *
 * Node 24 embeds undici, so bundling the npm copy (389 KB, the largest package
 * in the backend bundle) only ships a second one. `fetch` is a global; `Agent`
 * has no public export, so it is recovered from the global dispatcher, which
 * Node installs only once its internal undici has initialised — hence the
 * `new Request()` below. `secret-stream-http` subclasses `Agent` at module
 * scope, so this has to resolve eagerly. We ship exactly one runtime
 * (nodejs-mobile 24), so a miss throws here instead of degrading silently.
 *
 * @module
 */

const GLOBAL_DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.1");

try {
  // Constructing the Request is the side effect: it makes Node initialise its
  // internal undici, which is what installs the global dispatcher read below.
  // eslint-disable-next-line no-new
  new Request("http://localhost/");
} catch {
  // Reported below, together with what the dispatcher slot ended up holding.
}

const dispatcher = /** @type {{ constructor?: unknown } | undefined} */ (
  /** @type {Record<symbol, unknown>} */ (
    /** @type {unknown} */ (globalThis)
  )[GLOBAL_DISPATCHER_KEY]
);

const AgentCandidate = dispatcher?.constructor;

if (
  typeof AgentCandidate !== "function" ||
  typeof AgentCandidate.prototype?.dispatch !== "function"
) {
  throw new Error(
    "undici-shim: could not recover undici's Agent from " +
      "globalThis[Symbol.for('undici.globalDispatcher.1')] (got " +
      `${typeof dispatcher}). This runtime does not expose a built-in undici ` +
      "the way nodejs-mobile 24 does — either restore the bundled undici " +
      "dependency or update this shim.",
  );
}

/** Node's built-in undici `Agent`. Honours the `connect` option. */
export const Agent = /** @type {typeof import("undici").Agent} */ (
  /** @type {unknown} */ (AgentCandidate)
);

/** Node's global `fetch`, which honours a per-request `dispatcher`. */
export const fetch = /** @type {typeof import("undici").fetch} */ (
  /** @type {unknown} */ (globalThis.fetch)
);
