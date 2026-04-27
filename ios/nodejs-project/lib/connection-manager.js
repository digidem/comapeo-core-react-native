import { once } from "node:events";

/**
 * @param {import('node:net').Server} server
 */
export function createConnectionManager(server) {
  /**
   * @type {Set<import('node:net').Socket>}
   */
  const connections = new Set();

  server.on("connection", handleConnection);

  async function closeAll() {
    const closePromises = [];
    for (const socket of connections) {
      socket.destroySoon();
      closePromises.push(once(socket, "close"));
    }
    await Promise.all(closePromises);
    server.off("connection", handleConnection);
    connections.clear();
  }

  /** @param {import('node:net').Socket} socket */
  function handleConnection(socket) {
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
    });
  }

  return {
    closeAll,
  };
}
