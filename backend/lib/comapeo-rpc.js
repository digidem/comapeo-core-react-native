import { SocketMessagePort } from "./message-port.js";
import { ServerHelper } from "./server-helper.js";
import { createMapeoServer } from "@comapeo/ipc/server.js";
/** @import {MapeoManager} from '@comapeo/core' */

export class ComapeoRpcServer extends ServerHelper {
  /** @param {MapeoManager} manager */
  constructor(manager) {
    super((socket) => {
      const messagePort = new SocketMessagePort(socket);
      messagePort.start();
      const server = createMapeoServer(
        manager,
        /** @type {Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'>} */ (
          messagePort
        ),
      );
      messagePort.on("close", () => server.close());
    });
  }
}
