import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SocketMessagePort } from "./message-port.js";
import { seedOldStorage } from "./seed-old-storage.js";
import { socketPath, waitFor, delay } from "./test-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(__dirname, "..", "index.js");

// 16 zero-padded bytes → 22 base64 chars + "==", matching the strict
// shape index.js's init handler validates.
const ROOT_KEY_B64 = Buffer.alloc(16, 1).toString("base64");

/**
 * Poll-connect to a unix socket until it accepts (the child hasn't bound
 * the control socket the instant it spawns).
 */
async function connectWhenListening(path, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const socket = net.connect(path);
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => {
          socket.destroy();
          reject(e);
        };
        socket.once("connect", () => {
          socket.removeListener("error", onErr);
          resolve();
        });
        socket.once("error", onErr);
      });
      return socket;
    } catch {
      if (Date.now() - start > timeout) {
        throw new Error(`timed out connecting to ${path}`);
      }
      await delay(100);
    }
  }
}

/**
 * Spawn `index.js` against a seeded storage dir and hand the caller a
 * connected control-socket port plus a message collector. Sends `init`
 * so boot proceeds to the migration check.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} storageDir Private storage root, already seeded.
 * @param {string} availableDiskSpaceArg 6th positional: free bytes (or "").
 */
async function startBackend(t, storageDir, availableDiskSpaceArg) {
  const controlPath = socketPath();
  const comapeoPath = socketPath();
  const args = [
    comapeoPath,
    controlPath,
    storageDir,
    "", // config
    "", // style url
    availableDiskSpaceArg,
  ];
  const child = spawn(process.execPath, [INDEX_JS, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const messages = [];
  const portPromise = (async () => {
    const socket = await connectWhenListening(controlPath);
    t.after(() => socket.destroy());
    const port = new SocketMessagePort(socket);
    port.addEventListener("message", (e) => messages.push(e.data));
    port.start();
    port.postMessage({ type: "init", rootKey: ROOT_KEY_B64 });
    return port;
  })();

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
  });

  await portPromise;

  /** @param {(m: any) => boolean} predicate */
  const waitForMessage = async (predicate, opts) => {
    await waitFor(() => messages.some(predicate), opts);
    return messages.find(predicate);
  };

  return { child, messages, waitForMessage, output: () => output };
}

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function seededStorageDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedOldStorage(dir, ROOT_KEY_B64);
  return dir;
}

test("migrates seeded old-format storage and reaches ready", async (t) => {
  const dir = await seededStorageDir(t, "comapeo-mig-");
  // Plenty of headroom: 10 GiB so the space check never trips.
  const { waitForMessage, messages } = await startBackend(
    t,
    dir,
    String(10 * 1024 ** 3),
  );

  const ready = await waitForMessage(
    (m) => m.type === "ready",
    { timeout: 90000, message: "ready after migration" },
  );
  assert.ok(ready, "expected a ready frame after migration");

  const migrating = messages.filter((m) => m.type === "migrating");
  assert.ok(migrating.length > 0, "expected at least one migrating frame");
  const [done, total] = String(migrating.at(-1).context).split("/");
  assert.equal(done, total, "final migrating frame reports all cores done");
});

test("emits a low-space frame when available disk space is insufficient", async (t) => {
  const dir = await seededStorageDir(t, "comapeo-lowspace-");
  // 1 free byte: requiredSpace (largestCore * 1.5) always >= 1, so the
  // check reports NO_SPACE instead of migrating.
  const { waitForMessage } = await startBackend(t, dir, "1");

  const lowSpace = await waitForMessage(
    (m) => m.type === "low-space",
    { timeout: 30000, message: "low-space frame" },
  );
  assert.ok(lowSpace, "expected a low-space frame");
  assert.equal(typeof lowSpace.spaceNeeded, "string");
  assert.ok(
    parseInt(lowSpace.spaceNeeded, 10) > 0,
    "spaceNeeded should be a positive byte count",
  );
});
