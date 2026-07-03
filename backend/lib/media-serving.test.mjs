import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createComapeoCoreClient,
  closeComapeoCoreClient,
} from "@comapeo/ipc/client.js";

import { SocketMessagePort } from "./message-port.js";
import { connectSocket, socketPath } from "./test-helpers.mjs";

// End-to-end test of the media-serving contract the native layers depend
// on, with zero knowledge of how it's implemented: boot the real backend
// entry (`index.js`) exactly as native does (same argv contract), drive
// the real control-socket handshake, store a blob through the public RPC
// API, and then fetch it back the way `MediaContentProvider` (Android)
// and `MediaFetcher` (iOS) do — a raw HTTP/1.0 GET over the media Unix
// domain socket, body delimited by EOF.
//
// What this pins down:
//   1. `$blobs.getUrl()` returns a *relative* path (core is URL-agnostic;
//      the RN side prepends the platform-native base URL).
//   2. That path, requested over `media.sock` with HTTP/1.0, returns the
//      exact bytes that were stored, with a usable Content-Type.
//   3. HTTP/1.0 framing holds: no Transfer-Encoding, connection closes at
//      end of body (the native clients read until EOF).
//   4. A request for a missing blob fails with a non-2xx status rather
//      than hanging or closing without a response.

const BACKEND_DIR = fileURLToPath(new URL("..", import.meta.url));
const INDEX_PATH = join(BACKEND_DIR, "index.js");

// Smallest valid PNG (1×1 transparent pixel) — a real decodable image so
// the stored blob is representative of what apps serve to <Image>.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Timeout for the backend to reach "ready" (includes DB migrations). */
const READY_TIMEOUT_MS = 60_000;

/**
 * Boot `index.js` like native does and complete the control handshake.
 * Resolves once the backend broadcasts `ready` (manager built, RPC and
 * media sockets bound). Registers teardown on the test context.
 *
 * @param {import('node:test').TestContext} t
 */
async function bootBackend(t) {
  const storageDir = mkdtempSync(join(tmpdir(), "comapeo-media-test-"));
  t.after(() => rmSync(storageDir, { recursive: true, force: true }));

  const comapeoSocketPath = socketPath();
  const controlSocketPath = socketPath();
  const mediaSocketPath = socketPath();

  const child = spawn(
    process.execPath,
    [
      INDEX_PATH,
      comapeoSocketPath,
      controlSocketPath,
      storageDir,
      "", // default config path (unset)
      "", // online style URL (unset)
      mediaSocketPath,
    ],
    { cwd: BACKEND_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  // The control socket only exists once the backend binds it — poll
  // connect like native's waitForFile+connect-retry loop.
  const controlSocket = await connectWithRetry(t, controlSocketPath);
  const controlPort = new SocketMessagePort(controlSocket);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Backend not ready in ${READY_TIMEOUT_MS}ms.\n${output}`),
      );
    }, READY_TIMEOUT_MS);
    controlPort.addEventListener("message", ({ data }) => {
      if (data?.type === "ready") {
        clearTimeout(timer);
        resolve(undefined);
      } else if (data?.type === "error") {
        clearTimeout(timer);
        reject(new Error(`Backend error (${data.phase}): ${data.message}`));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited with code ${code}.\n${output}`));
    });
  });
  controlPort.start();
  controlPort.postMessage({
    type: "init",
    rootKey: randomBytes(16).toString("base64"),
  });
  await ready;

  const rpcSocket = await connectSocket(t, comapeoSocketPath);
  const rpcPort = new SocketMessagePort(rpcSocket);
  const client = createComapeoCoreClient(rpcPort);
  rpcPort.start();
  t.after(() => closeComapeoCoreClient(client));

  return { client, mediaSocketPath, storageDir, controlPort };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} path
 * @returns {Promise<net.Socket>}
 */
async function connectWithRetry(t, path, { timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await connectSocket(t, path);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Issue a raw HTTP/1.0 GET over the media UDS — byte-for-byte what the
 * native clients send — and read the response to EOF.
 *
 * @param {string} mediaSocketPath
 * @param {string} pathAndQuery
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer, rawHead: string }>}
 */
async function httpGetOverUds(mediaSocketPath, pathAndQuery) {
  const socket = net.connect(mediaSocketPath);
  await once(socket, "connect");
  socket.write(
    `GET ${pathAndQuery} HTTP/1.0\r\n` +
      `Host: localhost\r\n` +
      `Connection: close\r\n` +
      `\r\n`,
  );
  /** @type {Buffer[]} */
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await once(socket, "end");
  socket.destroy();
  const raw = Buffer.concat(chunks);
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1, "response has a complete header section");
  const rawHead = raw.subarray(0, headerEnd).toString("latin1");
  const [statusLine, ...headerLines] = rawHead.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }
  return { status, headers, body: raw.subarray(headerEnd + 4), rawHead };
}

test(
  "blobs stored via RPC are served over the media UDS with HTTP/1.0 framing",
  { timeout: 120_000 },
  async (t) => {
    const { client, mediaSocketPath, storageDir } = await bootBackend(t);

    const projectId = await client.createProject({ name: "media-test" });
    const project = await client.getProject(projectId);

    const pngPath = join(storageDir, "fixture.png");
    writeFileSync(pngPath, PNG_1X1);
    const created = await project.$blobs.create(
      { original: pngPath },
      { mimeType: "image/png" },
    );

    const url = await project.$blobs.getUrl({
      driveId: created.driveId,
      type: created.type,
      variant: "original",
      name: created.name,
    });

    // The URL-agnostic contract: core hands back a relative path; it has
    // no idea what scheme/authority the platform serves it under.
    assert.match(
      url,
      /^\/blobs\//,
      `expected a relative /blobs/ path, got: ${url}`,
    );

    const ok = await httpGetOverUds(mediaSocketPath, url);
    assert.equal(ok.status, 200, `GET ${url} → ${ok.rawHead}`);
    assert.match(ok.headers["content-type"] ?? "", /^image\/png/);
    assert.deepEqual(ok.body, PNG_1X1, "served bytes match stored bytes");
    // HTTP/1.0 request → body must be EOF-delimited, never chunked (the
    // native clients have no chunked decoder).
    assert.notEqual(ok.headers["transfer-encoding"], "chunked");

    // Missing blob: a definite non-2xx response, not a hang or bare close.
    const missing = await httpGetOverUds(
      mediaSocketPath,
      url.replace(created.name, "0000000000000000"),
    );
    assert.ok(
      missing.status >= 400,
      `expected an error status, got ${missing.status}`,
    );
  },
);

test(
  "backend fails fast when the media socket argv slot is missing",
  { timeout: 60_000 },
  async (t) => {
    const storageDir = mkdtempSync(join(tmpdir(), "comapeo-media-test-"));
    t.after(() => rmSync(storageDir, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [INDEX_PATH, socketPath(), socketPath(), storageDir, "", ""],
      { cwd: BACKEND_DIR, stdio: "ignore" },
    );
    t.after(() => child.kill("SIGKILL"));
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
  },
);
