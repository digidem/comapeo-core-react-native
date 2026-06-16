import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let counter = 0;

/** Short, collision-free unix socket path under the OS temp dir. */
export function socketPath() {
  return join(tmpdir(), `comapeo-test-${process.pid}-${counter++}.sock`);
}

/** @param {number} ms */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `predicate` until it returns truthy or the timeout elapses.
 *
 * @param {() => boolean} predicate
 * @param {{ timeout?: number, interval?: number, message?: string }} [opts]
 */
export async function waitFor(
  predicate,
  { timeout = 2000, interval = 10, message = "condition" } = {},
) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out: ${message}`);
    }
    await delay(interval);
  }
}

/**
 * Connect a client socket to a listening unix socket and resolve once
 * connected. Registers teardown on the test context.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} path
 * @returns {Promise<net.Socket>}
 */
export async function connectSocket(t, path) {
  const socket = net.connect(path);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.destroy());
  return socket;
}

/**
 * A pair of connected sockets (server end + client end) over an ephemeral
 * unix socket. Registers teardown on the test context.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ serverSocket: net.Socket, clientSocket: net.Socket }>}
 */
export async function connectedSocketPair(t) {
  const path = socketPath();
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(undefined));
  });
  const serverSocketPromise = new Promise((resolve) =>
    server.once("connection", resolve),
  );
  const clientSocket = await connectSocket(t, path);
  const serverSocket = /** @type {net.Socket} */ (await serverSocketPromise);
  server.close();
  t.after(() => serverSocket.destroy());
  return { serverSocket, clientSocket };
}
