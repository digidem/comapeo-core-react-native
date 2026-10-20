import { once } from "node:events";

/** @typedef {{ localPort: number, remotePort: number }} MapServerPorts */
/**
 * @typedef {object} PausableMapServer
 * @property {() => Promise<void>} pauseListening
 * @property {() => Promise<MapServerPorts>} resumeListening
 */

/**
 * Closes the backend's TCP listeners when the app goes to the background and
 * reopens them, on the same ports, when it returns. iOS can reclaim a
 * suspended app's listening sockets, which leaves the blob/icon server and
 * map server refusing connections after resume while the process, and the
 * Unix-socket RPC, carry on as normal (Apple TN2277).
 *
 * Open connections are left alone, so a transfer survives a short app switch.
 * `foreground()` refreshes listeners whether or not `background()` reached
 * them: a server that started listening after the app was backgrounded (boot
 * still running) would otherwise keep a reclaimed socket.
 *
 * @param {object} opts
 * @param {import("node:net").Server} opts.fastifyServer core's blob/icon server
 * @param {(name: string, from: number, to: number) => void} opts.onPortChange
 *   called when a port was taken while paused and a random one is used instead
 */
export function createListenerLifecycle({ fastifyServer, onPortChange }) {
  /** @type {number | undefined} */
  let fastifyPort;
  /** @type {PausableMapServer | undefined} */
  let mapServer;
  /** @type {MapServerPorts | undefined} */
  let mapServerPorts;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serialize(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  // Read the port here, not when pausing: address() calls getsockname(),
  // which throws on a socket iOS has reclaimed.
  const recordFastifyPort = () => {
    const address = fastifyServer.address();
    if (address && typeof address === "object") fastifyPort = address.port;
  };
  if (fastifyServer.listening) recordFastifyPort();
  fastifyServer.on("listening", recordFastifyPort);

  function pauseFastify() {
    // Releases the port synchronously. 'close' waits for open connections,
    // so it is deliberately not awaited.
    if (fastifyServer.listening) fastifyServer.close();
  }

  async function resumeFastify() {
    if (fastifyPort === undefined || fastifyServer.listening) return;
    const previous = fastifyPort;
    const port = await relisten(fastifyServer, previous, "127.0.0.1");
    if (port !== previous) onPortChange("blob-server", previous, port);
  }

  async function resumeMapServer() {
    if (!mapServer) return;
    await mapServer.pauseListening();
    const ports = await mapServer.resumeListening();
    if (mapServerPorts) {
      if (ports.localPort !== mapServerPorts.localPort) {
        onPortChange(
          "map-server-local",
          mapServerPorts.localPort,
          ports.localPort,
        );
      }
      if (ports.remotePort !== mapServerPorts.remotePort) {
        onPortChange(
          "map-server-remote",
          mapServerPorts.remotePort,
          ports.remotePort,
        );
      }
    }
    mapServerPorts = ports;
  }

  return {
    /**
     * Register the map server once it is listening.
     *
     * @param {PausableMapServer} server
     * @param {MapServerPorts} ports
     */
    setMapServer(server, ports) {
      mapServer = server;
      mapServerPorts = ports;
    },
    /** Ports the map server is listening on, after any resume. */
    getMapServerPorts() {
      return mapServerPorts;
    },
    background() {
      return serialize(async () => {
        pauseFastify();
        await mapServer?.pauseListening();
      });
    },
    foreground() {
      return serialize(async () => {
        pauseFastify();
        // Independent: a failure to rebind one server must not leave the
        // other closed.
        const results = await Promise.allSettled([
          resumeFastify(),
          resumeMapServer(),
        ]);
        const failed = results.find((r) => r.status === "rejected");
        if (failed) throw failed.reason;
      });
    },
  };
}

/**
 * Listen on `port` again, or on a random port if it was taken while paused.
 *
 * @param {import("node:net").Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>} the port now in use
 */
async function relisten(server, port, host) {
  try {
    await listen(server, port, host);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EADDRINUSE") {
      throw err;
    }
    await listen(server, 0, host);
  }
  const address = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  return address.port;
}

/**
 * @param {import("node:net").Server} server
 * @param {number} port
 * @param {string} host
 */
async function listen(server, port, host) {
  server.listen(port, host);
  await once(server, "listening");
}
