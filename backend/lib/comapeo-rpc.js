import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import * as metrics from "./metrics.js";
import {
  createComapeoCoreServer,
  createComapeoServicesServer,
} from "@comapeo/ipc/server.js";

/** @import {MapeoManager} from '@comapeo/core' */
/** @import {ComapeoServicesApi} from '@comapeo/ipc/server.js' */

export class ComapeoRpc extends ServerHelper {
  /**
   * @param {object} params
   * @param {MapeoManager} params.comapeoManager - The ComapeoManager instance to be used by the Comapeo Core RPC server.
   * @param {ComapeoServicesApi} params.comapeoServices - The app-provided services (e.g. map server) served alongside core.
   * @param {{ onRequestHook?: NonNullable<Parameters<typeof createComapeoCoreServer>[2]>['onRequestHook'] }} [options]
   */
  constructor({ comapeoManager, comapeoServices }, { onRequestHook } = {}) {
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);

      const coreServer = createComapeoCoreServer(
        comapeoManager,
        messagePort,
        onRequestHook ? { onRequestHook } : undefined,
      );

      const servicesServer = createComapeoServicesServer(
        comapeoServices,
        messagePort,
        onRequestHook ? { onRequestHook } : undefined,
      );

      messagePort.addEventListener("messageerror", (event) => {
        console.error("Client sent invalid message", event.data);
        metrics.ipcError(event.data?.name);
      });

      messagePort.addEventListener("close", () => {
        coreServer.close();
        servicesServer.close();
      });

      messagePort.start();
    });
  }
}
