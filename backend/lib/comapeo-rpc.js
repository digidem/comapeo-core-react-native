import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import { createMapeoServer } from "@comapeo/ipc/server.js";
/** @import {MapeoManager} from '@comapeo/core' */

/**
 * RPC args carry potential PII (observation fields, attachment paths)
 * so capture is opt-in via `rpcArgsBytes`.
 *
 * Errors are NOT rethrown — rpc-reflector already sends the error
 * response from inside `next`, and an unhandled rejection here would
 * funnel into `handleFatal` and kill the process for a routine RPC
 * error.
 *
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
