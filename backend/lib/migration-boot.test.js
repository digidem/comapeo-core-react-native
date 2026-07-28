/**
 * Integration tests for the backend boot + migration flow in `index.js`.
 *
 * Tests the ORCHESTRATION logic: low-space parking, retry mechanism,
 * migrating frames, fallback manager construction. The migration functions
 * themselves (`checkShouldMigrate`, `migrateStorage`) are tested in
 * `@comapeo/core` — those verify the core logic. These tests verify the
 * backend's boot sequence and IPC framing.
 *
 * Prerequisites: `cd backend && npm install`, better-sqlite3 built.
 *
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import FramedStream from "framed-stream";
import { socketPath, delay, waitFor } from "./test-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(__dirname, "..", "index.js");

/** Generate a random 16-byte rootkey and return strict base64 (22 + "=="). */
function makeRootKey() {
  return randomBytes(16).toString("base64");
}

/** Wait for a socket file to exist. */
async function waitForSocket(/** @type {string} */ path, /** @type {number} */ timeout = 10000) {
  await waitFor(
    async () => {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    { timeout, interval: 50, message: `socket ${path} to appear` },
  );
}

/**
 * Spawn the backend and return a handle with helpers.
 *
 * @param {{ storageDir?: string, availableDiskSpace?: number }} [opts]
 */
function spawnBackend({ storageDir, availableDiskSpace = 0 } = {}) {
  const comapeoSocket = socketPath();
  const controlSocket = socketPath();

  const child = spawn(
    "node",
    [
      INDEX_JS,
      comapeoSocket,
      controlSocket,
      storageDir || "",
      "", // defaultConfigPath (empty = no defaults)
      "", // defaultOnlineStyleUrl (empty = built-in fallback)
      String(availableDiskSpace),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    },
  );

  child.stdout.on("data", (/** @type {Buffer} */ d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on("data", (/** @type {Buffer} */ d) => process.stderr.write(`[backend] ${d}`));

  return {
    child,
    controlSocket,
    async shutdown() {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
      });
    },
  };
}

/**
 * Frame collector: wraps a FramedStream and collects all frames.
 * @param {FramedStream} framed
 */
function collectFrames(framed) {
  /** @type {any[]} */
  const frames = [];
  framed.on("data", /** @param {Buffer} buf */ (buf) => {
    frames.push(JSON.parse(buf.toString()));
  });

  /**
   * Wait for a frame matching the predicate.
   * @param {(frame: any) => boolean} predicate
   * @param {{ timeout?: number, message?: string }} [opts]
   */
  const wait = (predicate, { timeout = 10000, message = "frame" } = {}) => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const match = frames.find(predicate);
        if (match) {
          framed.pause();
          resolve(frames);
        } else if (Date.now() - start < timeout) {
          setTimeout(check, 20);
        } else {
          reject(new Error(`Timed out waiting for: ${message}\nCollected: ${JSON.stringify(frames)}`));
        }
      };
      check();
    });
  };

  return { frames, wait };
}

/**
 * Connect to the control socket. Sets up frame collection BEFORE the
 * server can replay frames on connect.
 *
 * @param {string} path
 */
async function connectControl(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const framed = new FramedStream(socket);
    const collector = collectFrames(framed);
    socket.once("connect", () => resolve({ socket, framed, collector }));
    socket.once("error", reject);
  });
}

/** Send a JSON message on a FramedStream. */
function sendFrame(/** @type {FramedStream} */ framed, /** @type {Record<string,unknown>} */ message) {
  framed.write(Buffer.from(JSON.stringify(message)));
}

// ---- Tests ----

test("boots and reaches ready (no migration needed)", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "comapeo-test-"));
  t.after(async () => rm(storageDir, { recursive: true, force: true }));

  const handle = spawnBackend({ storageDir });
  t.after(() => handle.shutdown());

  await waitForSocket(handle.controlSocket);
  const { socket, framed, collector } = await connectControl(handle.controlSocket);
  t.after(() => socket.destroy());

  await collector.wait(
    /** @type {(frame: any) => boolean} */ ((f) => f.type === "started"),
    { timeout: 10000, message: "backend 'started' frame" },
  );
  framed.pause();

  sendFrame(framed, { type: "init", rootKey: makeRootKey() });

  framed.resume();
  await collector.wait(
    /** @type {(frame: any) => boolean} */ ((f) => f.type === "ready"),
    { timeout: 30000, message: "backend 'ready' frame" },
  );

  const types = collector.frames.map(/** @type {(f: any) => string} */ ((f) => f.type));
  assert.ok(types.includes("started"), "should receive 'started'");
  assert.ok(types.includes("ready"), "should receive 'ready'");
  assert.ok(!types.includes("migrating"), "should not migrate fresh storage");
});

test.only("migration: emits migrating frames with progress", async (t) => {
  const { seedOldStorage } = await import("./seed-old-storage.js");
  const storageDir = await mkdtemp(join(tmpdir(), "comapeo-test-"));
  const rootKey = makeRootKey();
  await seedOldStorage(storageDir, rootKey);
  t.after(async () => rm(storageDir, { recursive: true, force: true }));

  // Pass 0 (unknown) so the backend uses the real disk — plenty of space.
  const handle = spawnBackend({ storageDir, availableDiskSpace: 400000 });
  t.after(() => handle.shutdown());

  await waitForSocket(handle.controlSocket);
  const { socket, framed, collector } = await connectControl(handle.controlSocket);
  t.after(() => socket.destroy());

  await collector.wait(
    /** @type {(frame: any) => boolean} */ ((f) => f.type === "started"),
    { timeout: 10000, message: "backend 'started' frame" },
  );
  framed.pause();

  sendFrame(framed, { type: "init", rootKey });

  // Backend should migrate and emit migrating frames with progress
  framed.resume();
  try {
    await collector.wait(
      /** @type {(frame: any) => boolean} */ ((f) => f.type === "ready"),
      { timeout: 60000, message: "backend 'ready' frame" },
    );
  } catch (err) {
    console.error(`[migration-test] Wait failed. Collected frames:`, collector.frames);
    throw err;
  }

  const migratingFrames = collector.frames.filter(
    /** @type {(f: any) => boolean} */ ((f) => f.type === "migrating"),
  );
  assert.ok(
    migratingFrames.length > 0,
    "should emit at least one 'migrating' frame",
  );

  // First migrating frame has no progress (initial broadcast before migrateStorage)
  assert.strictEqual(
    migratingFrames[0].progress,
    undefined,
    "first migrating frame should have no progress",
  );

  // Subsequent frames carry "done/total" progress strings
  /** @type {string[]} */
  const progressValues = migratingFrames
    .slice(1)
    .map(/** @type {(f: any) => string} */ ((f) => f.progress));

  assert.ok(
    progressValues.length > 0,
    "should emit migrating frames with progress",
  );

  // Each progress value should match "N/M" pattern
  const progressRe = /^\d+\/\d+$/;
  for (const val of progressValues) {
    assert.ok(
      progressRe.test(val),
      `progress "${val}" should match "N/M" pattern`,
    );
  }

  const types = collector.frames.map(
    /** @type {(f: any) => string} */ ((f) => f.type),
  );
  assert.ok(types.includes("started"), "should receive 'started'");
  assert.ok(types.includes("migrating"), "should receive 'migrating'");
  assert.ok(types.includes("ready"), "should reach 'ready' after migration");
});

test("low-space: broadcasts low-space, parks, resumes on retry", async (t) => {
  // Seed old-format storage so migration is triggered, then pass tiny
  // availableDiskSpace to force the low-space path.
  const { seedOldStorage } = await import("./seed-old-storage.js");
  const storageDir = await mkdtemp(join(tmpdir(), "comapeo-test-"));
  const rootKey = makeRootKey();
  await seedOldStorage(storageDir, rootKey);
  t.after(async () => rm(storageDir, { recursive: true, force: true }));

  // 420 bytes is below the threshold — checkShouldMigrate returns NO_SPACE
  const handle = spawnBackend({ storageDir, availableDiskSpace: 420 });
  t.after(() => handle.shutdown());

  await waitForSocket(handle.controlSocket);
  const { socket, framed, collector } = await connectControl(handle.controlSocket);
  t.after(() => socket.destroy());

  // Backend starts, we send init
  await collector.wait(
    /** @type {(frame: any) => boolean} */ ((f) => f.type === "started"),
    { timeout: 10000, message: "backend 'started' frame" },
  );
  framed.pause();

  sendFrame(framed, { type: "init", rootKey });

  // Backend should broadcast low-space and park (no ready)
  framed.resume();
  await collector.wait(
    /** @type {(frame: any) => boolean} */ ((f) => f.type === "low-space"),
    { timeout: 15000, message: "backend 'low-space' frame" },
  );

  // Verify no `ready` frame yet
  const preRetryTypes = collector.frames.map(/** @type {(f: any) => string} */ ((f) => f.type));
  assert.ok(
    !preRetryTypes.includes("ready"),
    "should NOT reach ready before retry",
  );

  // Send retry — backend re-runs with forceFallback=true
  framed.resume();
  sendFrame(framed, { type: "retry" });

  // Should reach ready after retry
  await collector.wait(
    /** @type {(frame: any) => boolean} */ ((f) => f.type === "ready"),
    { timeout: 30000, message: "backend 'ready' frame after retry" },
  );

  const types = collector.frames.map(/** @type {(f: any) => string} */ ((f) => f.type));
  assert.ok(types.includes("low-space"), "should receive 'low-space'");
  assert.ok(types.includes("ready"), "should reach ready after retry");
});
