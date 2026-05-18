import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import { createAppRpcServer, createMapeoServer } from "@comapeo/ipc/server.js";

/** @import {MapeoManager} from '@comapeo/core' */

export class ComapeoRpcServer extends ServerHelper {
  /**
   * @param {MapeoManager} manager
   * @param {{ onRequestHook?: NonNullable<Parameters<typeof createMapeoServer>[2]>['onRequestHook'] }} [options]
   */
  constructor(manager, { onRequestHook } = {}) {
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

export class AppRpcServer extends ServerHelper {
  /**
   * @param {import('@comapeo/map-server').MapServer} mapServer
   */
  constructor(mapServer) {
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);
      messagePort.start();
      const server = createAppRpcServer(
        { mapServer },
        /** @type {Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'>} */ (
          messagePort
        ),
      );
      messagePort.on("close", () => server.close());
    });
  }
}
