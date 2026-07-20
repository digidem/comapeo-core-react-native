import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscoveryController } from "./ble-discovery.js";
import {
  decodeAdvertisement,
  deriveDailyProjectHash,
  encodeAdvertisement,
} from "./ble-codec.js";

/**
 * The discovery controller against a fake manager and broadcast sink:
 * lifecycle + composition (ble-start payload contents, change-only
 * re-broadcast), the auto-connect decision matrix + throttle, peer
 * table maintenance, status handling, and disk persistence/resume.
 */

const PID = "test-project-public-id";

/**
 * @param {{ observations?: { versionId: string }[],
 *   tracks?: { versionId: string }[] }} [docs]
 */
function makeProject({ observations = [], tracks = [] } = {}) {
  /** @type {Set<(state: object) => void>} */
  const syncListeners = new Set();
  return {
    observation: { getMany: async () => observations },
    track: { getMany: async () => tracks },
    $sync: {
      /** @param {string} name @param {(state: object) => void} fn */
      on: (name, fn) => name === "sync-state" && syncListeners.add(fn),
      /** @param {string} name @param {(state: object) => void} fn */
      off: (name, fn) => name === "sync-state" && syncListeners.delete(fn),
    },
    emitSyncState: () => syncListeners.forEach((fn) => fn({})),
    syncListeners,
  };
}

/**
 * @param {{ project?: ReturnType<typeof makeProject>,
 *   projects?: { projectId: string, status: string }[],
 *   port?: number }} [options]
 */
function harness({ project = makeProject(), projects, port = 4242 } = {}) {
  /** @type {{ type: string, payload?: string }[]} */
  const broadcasts = [];
  /** @type {object[]} */
  const connects = [];
  let nowMs = 1_000_000;
  const manager = {
    listProjects: async () =>
      projects ?? [{ projectId: PID, status: "joined" }],
    /** @param {string} id */
    getProject: async (id) => {
      assert.equal(id, PID);
      return project;
    },
    startLocalPeerDiscoveryServer: async () => ({ name: "x", port }),
    /** @param {object} peer */
    connectLocalPeer: (peer) => connects.push(peer),
  };
  const controller = new DiscoveryController({
    getManager: () => manager,
    broadcast: (frame) => broadcasts.push(frame),
    storageDir: mkdtempSync(join(tmpdir(), "ble-test-")),
    now: () => nowMs,
    getInterfaces: () =>
      /** @type {ReturnType<import("node:os")["networkInterfaces"]>} */ (
        /** @type {unknown} */ ({
          lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
          wlan0: [{ family: "IPv4", address: "192.168.1.5", internal: false }],
        })
      ),
  });
  return {
    controller,
    manager,
    project,
    broadcasts,
    connects,
    /** @param {number} t */
    setNow: (t) => (nowMs = t),
    getNow: () => nowMs,
    ownPayload: () =>
      broadcasts.findLast((f) => f.type === "ble-start" || f.type === "ble-advertise")
        ?.payload,
  };
}

/**
 * Build a peer sighting payload relative to the controller's own ad.
 * @param {any} own
 * @param {object} [overrides]
 */
function peerPayload(own, overrides = {}) {
  return encodeAdvertisement({
    ...own,
    address: "192.168.1.20",
    port: 9000,
    stateHash: (own.stateHash ^ 0xffffffff) >>> 0,
    ...overrides,
  }).toString("base64");
}

test("setEnabled(true) starts the server and broadcasts a decodable ble-start", async () => {
  const h = harness({
    project: makeProject({
      observations: [{ versionId: "b/1" }, { versionId: "a/1" }],
      tracks: [{ versionId: "c/2" }],
    }),
  });
  await h.controller.api.setEnabled(true);

  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.broadcasts[0].type, "ble-start");
  const own = decodeAdvertisement(Buffer.from(h.broadcasts[0].payload, "base64"));
  assert.equal(own.address, "192.168.1.5");
  assert.equal(own.port, 4242);
  assert.equal(own.totalBlocks, 3);
  assert.equal(
    own.projectHash,
    deriveDailyProjectHash(Buffer.from(PID, "utf8"), new Date(h.getNow())),
  );
  assert.equal(h.controller.getState().enabled, true);
  assert.equal(h.controller.getState().projectPublicId, PID);
  assert.equal(h.project.syncListeners.size, 1);
  h.controller.close();
});

test("resolves the sole joined project and rejects ambiguity", async () => {
  const none = harness({ projects: [] });
  await assert.rejects(() => none.controller.api.setEnabled(true), /no joined project/);

  const many = harness({
    projects: [
      { projectId: PID, status: "joined" },
      { projectId: "other", status: "joined" },
    ],
  });
  await assert.rejects(() => many.controller.api.setEnabled(true), /multiple projects/);
  // Explicit selection works.
  await many.controller.api.setEnabled(true, { projectPublicId: PID });
  assert.equal(many.controller.getState().projectPublicId, PID);
  many.controller.close();
});

test("connects a same-project peer with differing state, with per-peer throttle", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));

  const sight = () =>
    h.controller.handleSighting({
      payload: peerPayload(own),
      rssi: -50,
      address: "AA:BB",
    });
  sight();
  assert.deepEqual(h.connects, [
    { address: "192.168.1.20", port: 9000, name: "ble:192.168.1.20:9000" },
  ]);

  h.setNow(h.getNow() + 10_000);
  sight(); // within throttle window
  assert.equal(h.connects.length, 1);
  h.setNow(h.getNow() + 25_000);
  sight(); // window elapsed
  assert.equal(h.connects.length, 2);
  h.controller.close();
});

test("does not connect on state match, project mismatch, missing ip:port, or when disabled", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));

  h.controller.handleSighting({
    payload: peerPayload(own, { stateHash: own.stateHash }),
    rssi: -50,
    address: "A",
  });
  h.controller.handleSighting({
    payload: peerPayload(own, { projectHash: (own.projectHash + 1) & 0xffff }),
    rssi: -50,
    address: "B",
  });
  h.controller.handleSighting({
    payload: peerPayload(own, { address: null, port: 0 }),
    rssi: -50,
    address: "C",
  });
  assert.equal(h.connects.length, 0);

  await h.controller.api.setEnabled(false);
  h.controller.handleSighting({
    payload: peerPayload(own),
    rssi: -50,
    address: "D",
  });
  assert.equal(h.connects.length, 0);
  assert.equal(h.broadcasts.at(-1).type, "ble-stop");
  h.controller.close();
});

test("maintains the peer table: keys, flags, and staleness", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));

  h.controller.handleSighting({
    payload: peerPayload(own),
    rssi: -40,
    address: "AA:BB",
  });
  h.controller.handleSighting({
    payload: peerPayload(own, { address: null, port: 0 }),
    rssi: -80,
    address: "CC:DD",
  });
  const peers = h.controller.getState().peers;
  assert.equal(peers.length, 2);
  const byId = Object.fromEntries(peers.map((p) => [p.id, p]));
  assert.ok(byId["192.168.1.20:9000"]);
  assert.ok(byId["ble:CC:DD"]);
  assert.equal(byId["192.168.1.20:9000"].sameProject, true);
  assert.equal(byId["192.168.1.20:9000"].hasDifferentSyncState, true);
  assert.equal(byId["192.168.1.20:9000"].inCluster, true); // −40 ≥ −60
  assert.equal(byId["ble:CC:DD"].inCluster, false);
  assert.ok(!("smoothedRssi" in byId["ble:CC:DD"]));
  h.controller.close();
});

test("re-broadcasts ble-advertise only when the payload changes", async () => {
  const project = makeProject({ observations: [{ versionId: "a/1" }] });
  const h = harness({ project });
  await h.controller.api.setEnabled(true);
  assert.equal(h.broadcasts.length, 1);

  // Same content → sync event triggers a refresh but no re-broadcast.
  project.emitSyncState();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.broadcasts.length, 1);

  // New doc + past the sync-refresh throttle → new ble-advertise.
  project.observation.getMany = async () => [
    { versionId: "a/1" },
    { versionId: "a/2" },
  ];
  h.setNow(h.getNow() + 10_000);
  project.emitSyncState();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.broadcasts.length, 2);
  assert.equal(h.broadcasts[1].type, "ble-advertise");
  const updated = decodeAdvertisement(Buffer.from(h.broadcasts[1].payload, "base64"));
  assert.equal(updated.totalBlocks, 2);
  h.controller.close();
});

test("stores engine status and surfaces it in state", async () => {
  const h = harness();
  h.controller.handleStatus({
    scanning: "unavailable",
    advertising: "unsupported",
    blockers: ["bluetooth-off", 42],
    lastError: { scope: "scan", code: "ERR_BLE_DISABLED", message: "off" },
  });
  const { ble } = h.controller.getState();
  assert.equal(ble.scanning, "unavailable");
  assert.equal(ble.advertising, "unsupported");
  assert.deepEqual(ble.blockers, ["bluetooth-off"]);
  assert.equal(ble.lastError.code, "ERR_BLE_DISABLED");
  h.controller.handleStatus({ scanning: "x" }); // malformed → ignored
  assert.equal(h.controller.getState().ble.scanning, "unavailable");
  h.controller.close();
});

test("emits throttled discovery-state events", async () => {
  const h = harness();
  /** @type {import("./ble-discovery.js").DiscoveryState[]} */
  const events = [];
  h.controller.on("discovery-state", (s) => events.push(s));
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));
  h.controller.handleSighting({ payload: peerPayload(own), rssi: -50, address: "A" });
  h.controller.handleSighting({ payload: peerPayload(own), rssi: -55, address: "A" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(events.length, 1); // debounced
  assert.equal(events[0].peers.length, 1);
  h.controller.close();
});

test("persists the enabled flag and resumes via onManagerReady", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ble-persist-"));
  /** @type {{ type: string, payload?: string }[]} */
  const broadcasts = [];
  const project = makeProject();
  const manager = {
    listProjects: async () => [{ projectId: PID, status: "joined" }],
    getProject: async () => project,
    startLocalPeerDiscoveryServer: async () => ({ name: "x", port: 7 }),
    connectLocalPeer: () => {},
  };
  const make = () =>
    new DiscoveryController({
      getManager: () => manager,
      broadcast: (f) => broadcasts.push(f),
      storageDir: dir,
      getInterfaces: () => ({}),
    });

  const first = make();
  await first.api.setEnabled(true);
  first.close();

  // "Process restart": a fresh controller resumes from disk.
  const second = make();
  second.onManagerReady();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(second.getState().enabled, true);
  assert.equal(
    broadcasts.filter((f) => f.type === "ble-start").length,
    2,
  );
  // No interfaces → advertised without an address, but still started.
  const own = decodeAdvertisement(
    Buffer.from(broadcasts.at(-1).payload, "base64"),
  );
  assert.equal(own.address, null);
  second.close();

  // Disabled state persists too.
  await second.api.setEnabled(false);
  const third = make();
  third.onManagerReady();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third.getState().enabled, false);
  third.close();
});
