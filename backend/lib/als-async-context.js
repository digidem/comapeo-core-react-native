// `AsyncLocalStorage`-backed async-context strategy for `@sentry/core`.
//
// `@sentry/core` ships a synchronous stack strategy by default, which
// cannot carry the current/isolation scope across an `await`. Node SDKs
// therefore install a strategy of their own; `@sentry/node-core` used the
// OpenTelemetry context manager for this, which is the single reason the
// whole OTel stack had to be bundled. This is the same strategy without
// OTel. It originated as an adaptation of `@sentry/vercel-edge`'s
// `async.ts` (MIT); note that vercel-edge has since replaced that file
// with a vendored OTel context manager, so upstream is no longer a
// reference for this code.
//
// Registered from `sentry-init.js`'s `init()` before the client is bound,
// so every `startSpan` / `withScope` / `continueTrace` in `sentry.js`
// keeps its context across the async boundaries in the RPC and boot paths.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  getDefaultCurrentScope,
  getDefaultIsolationScope,
  setAsyncContextStrategy,
} from "@sentry/core";

/** @typedef {import("@sentry/core").Scope} Scope */
/** @typedef {{ scope: Scope, isolationScope: Scope }} Scopes */

/**
 * Install the strategy on the global Sentry carrier. Idempotent in
 * effect — a second call simply replaces the strategy with an equivalent
 * one over a fresh store, which matters only if `init` runs twice (the
 * unit tests do exactly that).
 */
export function setAlsAsyncContextStrategy() {
  /** @type {AsyncLocalStorage<Scopes>} */
  const asyncStorage = new AsyncLocalStorage();

  /** @returns {Scopes} */
  function getScopes() {
    return (
      asyncStorage.getStore() ?? {
        scope: getDefaultCurrentScope(),
        isolationScope: getDefaultIsolationScope(),
      }
    );
  }

  // Deliberate divergence from the OTel strategy node-core installed:
  // the two isolation-scope methods carry the *current* scope through
  // by reference rather than cloning it, so a mutation inside
  // `withIsolationScope` would escape to the caller. That is the
  // classic ALS shape (and what vercel-edge shipped); it stays dormant
  // here because nothing in `backend/` mutates the current scope inside
  // `withIsolationScope` — every scope mutation we make goes through
  // `withScope`, `setTag`-on-a-span, or the initial scope.
  /** @type {import("@sentry/core").AsyncContextStrategy} */
  const strategy = {
    withScope(callback) {
      const { scope, isolationScope } = getScopes();
      const newScope = scope.clone();
      return asyncStorage.run({ scope: newScope, isolationScope }, () =>
        callback(newScope),
      );
    },
    withSetScope(scope, callback) {
      const { isolationScope } = getScopes();
      return asyncStorage.run({ scope, isolationScope }, () => callback(scope));
    },
    withIsolationScope(callback) {
      const { scope, isolationScope } = getScopes();
      const newIsolationScope = isolationScope.clone();
      return asyncStorage.run({ scope, isolationScope: newIsolationScope }, () =>
        callback(newIsolationScope),
      );
    },
    withSetIsolationScope(isolationScope, callback) {
      const { scope } = getScopes();
      return asyncStorage.run({ scope, isolationScope }, () =>
        callback(isolationScope),
      );
    },
    getCurrentScope: () => getScopes().scope,
    getIsolationScope: () => getScopes().isolationScope,
  };

  setAsyncContextStrategy(strategy);
}
