import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import { createAppRpcServer, createMapeoServer } from "@comapeo/ipc/server.js";

/** @import {MapeoManager} from '@comapeo/core' */
/** @import {MapServer} from '@comapeo/map-server' */

export class ComapeoRpc extends ServerHelper {
  /**
   * @param {{comapeoManager: MapeoManager, mapServer: MapServer}} options
   * @param {{ onRequestHook?: NonNullable<Parameters<typeof createMapeoServer>[2]>['onRequestHook'] }} [options]
   */
  constructor({ comapeoManager, mapServer }, { onRequestHook } = {}) {
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);

      messagePort.start();

      const comapeoRpcServer = createMapeoServer(
        comapeoManager,
        /** @type {Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'>} */ (
          messagePort
        ),
        onRequestHook ? { onRequestHook } : undefined,
      );

      const mapRpcServer = createAppRpcServer(
        { mapServer },
        /** @type {Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'>} */ (
          messagePort
        ),
      );

      messagePort.on("close", () => {
        comapeoRpcServer.close();
        mapRpcServer.close();
      });
    });
  }
}
