import { test } from "node:test";
import assert from "node:assert/strict";

import * as Sentry from "@sentry/node";

import { init, rpcHook, setSink, flush } from "./sentry.js";
import { envelopeToFrame } from "./sentry-frame.js";

/**
 * End-to-end "is the Node Sentry layer alive" check. Drives the real
 * `@sentry/node` SDK through `sentry.js`'s `forwardingTransport` and
 * asserts that an envelope frame reaches the sink. If init silently
 * skips, if the transport doesn't get wired, if rpcHook returns
 * undefined when it shouldn't, or if the sink stops draining — this
 * test fails.
 *
 * Deliberately asserts on **presence**, not on op-name strings or
 * attribute shapes. Renaming `rpc.server` or adding new attributes
 * is a legitimate refactor that should not break this test; the
 * regression class to catch is "no envelope at all".
 */
test("rpcHook produces an envelope frame end-to-end via real @sentry/node", async () => {
  init({
    Sentry,
    argv: {
      sentryDsn: "https://x@sentry.io/1",
      sentryEnvironment: "test",
      sentryRelease: "0.0.0+test",
      sentrySampleRate: "1.0",
      sentryTracesSampleRate: "1.0",
      sentryRpcArgsBytes: "0",
      sentryEnableLogs: false,
      sentryBaggage: "",
      captureApplicationData: true,
    },
    envelopeToFrame,
  });

  const captured = [];
  setSink((frame) => captured.push(frame));

  const hook = rpcHook();
  assert.ok(hook, "rpcHook returned undefined — Sentry didn't initialise");

  // Wait for next() to be called from inside startSpan's async callback.
  // `hook` itself returns undefined, but the span only ends after the
  // inner async callback resolves — gate test resolution on that.
  let nextCalled = false;
  await new Promise((resolve) => {
    hook(
      {
        method: ["read", "doc"],
        args: [],
        metadata: {
          "sentry-trace":
            "12345678901234567890123456789012-1234567890123456-1",
          baggage: "",
        },
      },
      async () => {
        nextCalled = true;
        // setImmediate so startSpan has a tick after next() resolves
        // to call span.setStatus, end the span, and queue the envelope.
        setImmediate(resolve);
      },
    );
  });
  await flush(2000);

  assert.ok(nextCalled, "rpcHook did not invoke next()");
  assert.ok(
    captured.length > 0,
    "no envelope frame reached the sink — Node Sentry layer is silent",
  );

  await Sentry.close();
});
