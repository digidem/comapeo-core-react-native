import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import {
  createComapeoCoreServer,
  createComapeoServicesServer,
} from "@comapeo/ipc/server.js";
import StartStopStateMachine from "start-stop-state-machine";

/** @import {MapeoManager} from '@comapeo/core' */
/** @import {ListenOptions, MapServer} from '@comapeo/map-server' */
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

      messagePort.start();

      messagePort.addEventListener("messageerror", (event) => {
        console.error("Client sent invalid message", event.data);
      });

      messagePort.addEventListener("close", () => {
        coreServer.close();
        servicesServer.close();
      });
    });
  }
}

/**
 * Wrap the MapServer to make listen() idempotent and handle race conditions
 * with start/stop calls.
 *
 * @implements {MapServer}
 */
class MapServerApi {
  /** @param {ListenOptions} [opts] */
  #start = async (opts) => {
    return this.#mapServer.listen(opts);
  };

  #stop = async () => {
    return this.#mapServer.close();
  };

  #sm = new StartStopStateMachine({ start: this.#start, stop: this.#stop });
  #mapServer;

  /** @param {MapServer} mapServer */
  constructor(mapServer) {
    this.#mapServer = mapServer;
  }

  /** @param {ListenOptions} [opts] */
  async listen(opts) {
    return this.#sm.start(opts);
  }

  async close() {
    return this.#sm.stop();
  }
}
