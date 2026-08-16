import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getCurrentScope,
  getIsolationScope,
  withIsolationScope,
  withScope,
} from "@sentry/core";

import { setAlsAsyncContextStrategy } from "./als-async-context.js";

/**
 * The property that motivates the strategy at all: `@sentry/core`'s
 * default (synchronous stack) strategy cannot keep a forked scope
 * attached across an `await`, so two concurrent tasks would see each
 * other's scope data. Every span/scope in `sentry.js` — the RPC hook,
 * `withBootTrace`, `withSpan` — straddles an await, so this is the
 * behaviour the whole file exists to provide.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("withScope isolates concurrent awaited tasks from each other", async () => {
  setAlsAsyncContextStrategy();

  /**
   * Interleaves with its sibling: reads its own tag after the other has run.
   * @param {string} name
   */
  async function task(name) {
    return withScope(async (scope) => {
      scope.setTag("task", name);
      await tick();
      await tick();
      return getCurrentScope().getScopeData().tags.task;
    });
  }

  const [a, b] = await Promise.all([task("a"), task("b")]);
  assert.equal(a, "a");
  assert.equal(b, "b");
  // The fork must not leak into the ambient scope either.
  assert.equal(getCurrentScope().getScopeData().tags.task, undefined);
});

test("withIsolationScope forks independently across awaits", async () => {
  setAlsAsyncContextStrategy();

  /** @param {string} name */
  async function task(name) {
    return withIsolationScope(async (isolationScope) => {
      isolationScope.setTag("iso", name);
      await tick();
      return getIsolationScope().getScopeData().tags.iso;
    });
  }

  const [a, b] = await Promise.all([task("a"), task("b")]);
  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.equal(getIsolationScope().getScopeData().tags.iso, undefined);
});

test("a nested withScope inherits the enclosing scope's data", async () => {
  setAlsAsyncContextStrategy();

  const inner = await withScope(async (outerScope) => {
    outerScope.setTag("outer", "yes");
    await tick();
    return withScope(async () => {
      await tick();
      return getCurrentScope().getScopeData().tags.outer;
    });
  });

  assert.equal(inner, "yes");
});
