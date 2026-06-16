import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import { createAppRpcServer, createMapeoServer } from "@comapeo/ipc/server.js";
import StartStopStateMachine from "start-stop-state-machine";

/** @import {MapeoManager} from '@comapeo/core' */
/** @import {ListenOptions, MapServer} from '@comapeo/map-server' */

export class ComapeoRpc extends ServerHelper {
  /**
   * @param {{comapeoManager: MapeoManager, mapServer: MapServer}} options
   * @param {{ onRequestHook?: NonNullable<Parameters<typeof createMapeoServer>[2]>['onRequestHook'] }} [options]
   */
  constructor({ comapeoManager, mapServer }, { onRequestHook } = {}) {
    // One wrapper shared across all connections: the underlying mapServer is a
    // single process-wide HTTP server, so its idempotent start/stop state must
    // be shared too. A per-connection wrapper would call mapServer.listen()
    // again on a reconnect and hit ERR_SERVER_ALREADY_LISTEN.
    const mapServerApi = new MapServerApi(mapServer);
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);

      const comapeoRpcServer = createMapeoServer(
        comapeoManager,
        messagePort,
        onRequestHook ? { onRequestHook } : undefined,
      );

      const mapRpcServer = createAppRpcServer({ mapServer: mapServerApi }, messagePort);

      messagePort.start();

      messagePort.addEventListener("messageerror", (event) => {
        console.error("Client sent invalid message", event.data);
      });

      messagePort.addEventListener("close", () => {
        comapeoRpcServer.close();
        mapRpcServer.close();
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
