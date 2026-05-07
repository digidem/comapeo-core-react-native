import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import { createMapeoServer } from "@comapeo/ipc/server.js";
/** @import {MapeoManager} from '@comapeo/core' */

/**
 * Per-request hook that wraps each RPC call in a Sentry transaction.
 * Mirrors `comapeo-mobile/src/backend/src/app.js` with one change:
 * `request.args` is not serialised by default. CoMapeo RPC args
 * routinely carry observation fields and attachment paths — PII
 * risk is high, so capture is opt-in via `rpcArgsBytes` (truncated
 * to that many chars when > 0).
 *
 * The hook does NOT rethrow after `captureException`. rpc-reflector
 * sends the error response from inside its own `handleRequest` (the
 * `next` we invoke); rethrowing here leaks an unhandled rejection
 * out of `onRequestHook`'s return, which `process.on('unhandledRejection')`
 * would then funnel into `handleFatal` and kill the process for what
 * is in fact a routine per-RPC error.
 *
 * @param {{ sentry: any, rpcArgsBytes: number }} options
 */
/**
 * @param {{ sentry: any, rpcArgsBytes: number }} options
 * @returns {NonNullable<Parameters<typeof createMapeoServer>[2]>['onRequestHook']}
 */
function makeSentryRequestHook({ sentry, rpcArgsBytes }) {
  return (request, next) => {
    const sentryTrace = request.metadata?.["sentry-trace"];
    const baggage = request.metadata?.baggage;
    /** @type {Record<string, unknown>} */
    const attributes = {
      "rpc.method": request.method.join("."),
    };
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
    sentry.continueTrace({ sentryTrace, baggage }, () => {
      sentry.startSpan(
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
            sentry.captureException(error, {
              tags: { layer: "node", op: "rpc" },
            });
          }
        },
      );
    });
  };
}

export class ComapeoRpcServer extends ServerHelper {
  /**
   * @param {MapeoManager} manager
   * @param {{ sentry?: any, rpcArgsBytes?: number }} [options]
   */
  constructor(manager, { sentry, rpcArgsBytes = 0 } = {}) {
    const onRequestHook = sentry
      ? makeSentryRequestHook({ sentry, rpcArgsBytes })
      : undefined;
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);
      messagePort.start();
      const server = createMapeoServer(
        manager,
        /** @type {Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'>} */ (
          messagePort
        ),
        onRequestHook ? { onRequestHook } : undefined,
      );
      messagePort.on("close", () => server.close());
    });
  }
}
