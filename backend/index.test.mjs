import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import FramedStream from "framed-stream";

const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_THROW_FIXTURE = "lib/__fixtures__/runtime-throw.mjs";

/** Strict-base64 of 16 bytes — the only shape the init handler accepts. */
const VALID_ROOT_KEY = Buffer.alloc(16, 7).toString("base64");

/**
 * Spawn the backend (via the real `loader.mjs` entry, no Sentry DSN so
 * the SDK no-ops) and collect every control-socket frame plus the exit
 * code. `entry` lets a test swap in the runtime-throw fixture.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ entry?: string, privateStorageDir?: string }} [opts]
 */
async function spawnBackend(t, { entry = "loader.mjs", privateStorageDir } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "comapeo-index-test-"));
  const comapeoSocketPath = join(dir, "comapeo.sock");
  const controlSocketPath = join(dir, "control.sock");
  const storage = privateStorageDir ?? join(dir, "storage");

  const child = spawn(
    process.execPath,
    [entry, comapeoSocketPath, controlSocketPath, storage],
    { cwd: BACKEND_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );

  /** @type {string[]} */
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));

  /** @type {{ code: number | null }} */
  const exit = { code: null };
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      exit.code = code;
      resolve(undefined);
    });
  });

  t.after(() => {
    if (exit.code === null) child.kill("SIGKILL");
  });

  return { controlSocketPath, child, exit, exited, stderr };
}

/**
 * Connect a control-socket client, retrying until the server is
 * listening. Resolves once connected; frames accumulate in `frames`.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} path
 * @param {number} [timeoutMs]
 */
async function connectControlClient(t, path, timeoutMs = 5000) {
  const start = Date.now();
  /** @type {net.Socket} */
  let socket;
  for (;;) {
    try {
      socket = net.connect(path);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      break;
    } catch (err) {
      socket.destroy();
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  t.after(() => socket.destroy());

  /** @type {Array<Record<string, any>>} */
  const frames = [];
  const stream = new FramedStream(socket);
  stream.on("data", (buf) => {
    try {
      frames.push(JSON.parse(buf.toString()));
    } catch {
      // ignore non-JSON frames
    }
  });

  /** @param {Record<string, unknown>} message */
  const send = (message) => stream.write(Buffer.from(JSON.stringify(message)));

  return { frames, send };
}

/**
 * @param {Array<Record<string, any>>} frames
 * @param {(f: Record<string, any>) => boolean} predicate
 * @param {{ timeout?: number, message?: string }} [opts]
 */
async function waitForFrame(
  frames,
  predicate,
  { timeout = 6000, message = "frame" } = {},
) {
  const start = Date.now();
  for (;;) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeout) {
      throw new Error(`waitForFrame timed out: ${message}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("malformed init (non-string rootKey) broadcasts phase:init and exits non-zero", async (t) => {
  const backend = await spawnBackend(t);
  const { frames, send } = await connectControlClient(t, backend.controlSocketPath);

  send({ type: "init", rootKey: 12345 });

  const frame = await waitForFrame(frames, (f) => f.type === "error", {
    message: "error frame for malformed init",
  });
  assert.equal(frame.phase, "init");
  assert.match(frame.message, /must be a base64 string/);
  assert.equal(typeof frame.stack, "string");

  await backend.exited;
  assert.notEqual(backend.exit.code, 0, "process must exit non-zero");
});

test("a valid init is accepted; a second init after consumption is ignored", async (t) => {
  const backend = await spawnBackend(t);
  const { frames, send } = await connectControlClient(t, backend.controlSocketPath);

  // Valid first init -> consumed, boot proceeds past the init phase.
  send({ type: "init", rootKey: VALID_ROOT_KEY });
  // Second init carries a malformed rootKey: if it were NOT ignored it
  // would reject initPromise and broadcast a phase:init error.
  send({ type: "init", rootKey: 999 });

  // Give the second init time to be (correctly) ignored. The process may
  // still fail later in `construct` once the real manager spins up — but
  // it must never emit a phase:init error from the ignored second frame.
  await new Promise((r) => setTimeout(r, 1500));
  const initError = frames.find(
    (f) => f.type === "error" && f.phase === "init",
  );
  assert.equal(initError, undefined, "second init must not produce a phase:init error");
});

test("construct failure (storage path is a file) broadcasts phase:construct before exit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "comapeo-construct-test-"));
  const storageFile = join(dir, "not-a-dir");
  writeFileSync(storageFile, "x");

  const backend = await spawnBackend(t, { privateStorageDir: storageFile });
  const { frames, send } = await connectControlClient(t, backend.controlSocketPath);

  send({ type: "init", rootKey: VALID_ROOT_KEY });

  const frame = await waitForFrame(frames, (f) => f.type === "error", {
    message: "error frame for construct failure",
  });
  assert.equal(frame.phase, "construct");
  assert.equal(typeof frame.message, "string");

  await backend.exited;
  assert.notEqual(backend.exit.code, 0, "process must exit non-zero");
});

test("an uncaught throw mid-runtime broadcasts phase:runtime before exit", async (t) => {
  const backend = await spawnBackend(t, { entry: RUNTIME_THROW_FIXTURE });
  const { frames } = await connectControlClient(t, backend.controlSocketPath);

  const frame = await waitForFrame(frames, (f) => f.type === "error", {
    message: "error frame for runtime throw",
  });
  assert.equal(frame.phase, "runtime");
  assert.match(frame.message, /simulated runtime explosion/);

  await backend.exited;
  assert.notEqual(backend.exit.code, 0, "process must exit non-zero");
});
