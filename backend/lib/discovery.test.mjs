import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscoveryController } from "./discovery.js";
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
 *   port?: number, sweepIntervalMs?: number }} [options]
 */
function harness({
  project = makeProject(),
  projects,
  port = 4242,
  sweepIntervalMs,
} = {}) {
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
    ...(sweepIntervalMs !== undefined ? { sweepIntervalMs } : {}),
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

  const bleFrames = h.broadcasts.filter((f) => f.type.startsWith("ble-"));
  assert.equal(bleFrames.length, 1);
  assert.equal(bleFrames[0].type, "ble-start");
  const own = decodeAdvertisement(Buffer.from(bleFrames[0].payload, "base64"));
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
  assert.ok(h.broadcasts.some((f) => f.type === "ble-stop"));
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
  const bleCount = () =>
    h.broadcasts.filter((f) => f.type.startsWith("ble-")).length;
  assert.equal(bleCount(), 1);

  // Same content → sync event triggers a refresh but no re-broadcast.
  project.emitSyncState();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bleCount(), 1);

  // New doc + past the sync-refresh throttle → new ble-advertise.
  project.observation.getMany = async () => [
    { versionId: "a/1" },
    { versionId: "a/2" },
  ];
  h.setNow(h.getNow() + 10_000);
  project.emitSyncState();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bleCount(), 2);
  const advertise = h.broadcasts.find((f) => f.type === "ble-advertise");
  const updated = decodeAdvertisement(Buffer.from(advertise.payload, "base64"));
  assert.equal(updated.totalBlocks, 2);
  h.controller.close();
});

test("stores engine status and surfaces it in state", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
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
  /** @type {import("./discovery.js").DiscoveryState[]} */
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

test("enable also starts DNS-SD with core's service name; disable stops it", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  assert.deepEqual(
    h.broadcasts.find((f) => f.type === "nsd-start"),
    { type: "nsd-start", name: "x", port: 4242 },
  );
  await h.controller.api.setEnabled(false);
  assert.ok(h.broadcasts.some((f) => f.type === "nsd-stop"));
  h.controller.close();
});

test("nsd-peer connects immediately with the real DNS-SD name, throttled, self-filtered", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);

  h.controller.handleNsdPeer({ name: "peer-a", address: "192.168.1.30", port: 7001 });
  assert.deepEqual(h.connects.at(-1), {
    address: "192.168.1.30",
    port: 7001,
    name: "peer-a",
  });
  const peer = h.controller.getState().peers.find((p) => p.id === "mdns:peer-a");
  assert.equal(peer.source, "mdns");
  assert.equal(peer.rssi, null);
  assert.equal(peer.sameProject, null);

  // Repeat within the throttle window → no second connect.
  const before = h.connects.length;
  h.controller.handleNsdPeer({ name: "peer-a", address: "192.168.1.30", port: 7001 });
  assert.equal(h.connects.length, before);

  // Our own registration echoed back → ignored entirely.
  h.controller.handleNsdPeer({ name: "x", address: "192.168.1.5", port: 4242 });
  assert.ok(!h.controller.getState().peers.some((p) => p.id === "mdns:x"));

  // Malformed → ignored.
  h.controller.handleNsdPeer({ name: "bad", address: "10.0.0.1", port: "80" });
  assert.ok(!h.controller.getState().peers.some((p) => p.id === "mdns:bad"));
  h.controller.close();
});

test("nsd-peer-lost prunes immediately", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  h.controller.handleNsdPeer({ name: "peer-a", address: "192.168.1.30", port: 7001 });
  assert.ok(h.controller.getState().peers.some((p) => p.id === "mdns:peer-a"));
  h.controller.handleNsdPeerLost({ name: "peer-a" });
  assert.ok(!h.controller.getState().peers.some((p) => p.id === "mdns:peer-a"));
  h.controller.close();
});

test("the sweep evicts stale BLE peers quickly but mDNS peers only after the long fallback TTL", async () => {
  // sweepIntervalMs is tiny so the real interval fires promptly; the
  // TTL comparison uses the injected clock, so we advance `now` to age
  // peers deterministically.
  const h = harness({ sweepIntervalMs: 10 });
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));
  h.controller.handleSighting({ payload: peerPayload(own), rssi: -50, address: "AA" });
  h.controller.handleNsdPeer({ name: "peer-a", address: "192.168.1.30", port: 7001 });

  // 45s later: past the 30s BLE TTL, well under the 5-min mDNS TTL.
  h.setNow(h.getNow() + 45_000);
  await new Promise((r) => setTimeout(r, 40));
  let ids = h.controller.getState().peers.map((p) => p.id);
  assert.ok(!ids.includes("192.168.1.20:9000"), "BLE peer swept");
  assert.ok(ids.includes("mdns:peer-a"), "mDNS peer survives the short TTL");

  // 6 min total: past the mDNS fallback TTL too.
  h.setNow(h.getNow() + 6 * 60_000);
  await new Promise((r) => setTimeout(r, 40));
  ids = h.controller.getState().peers.map((p) => p.id);
  assert.ok(!ids.includes("mdns:peer-a"), "mDNS peer swept after fallback TTL");
  h.controller.close();
});

test("stores nsd engine status separately from ble", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  h.controller.handleNsdStatus({
    browsing: "active",
    registered: "unavailable",
    blockers: ["no-network"],
    lastError: { scope: "register", code: "ERR_NSD_REGISTER", message: "boom" },
  });
  const { nsd, ble } = h.controller.getState();
  assert.equal(nsd.browsing, "active");
  assert.equal(nsd.registered, "unavailable");
  assert.deepEqual(nsd.blockers, ["no-network"]);
  assert.equal(nsd.lastError.code, "ERR_NSD_REGISTER");
  assert.equal(ble.scanning, "stopped"); // untouched
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
    Buffer.from(broadcasts.findLast((f) => f.type === "ble-start").payload, "base64"),
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

/**
 * A project mock whose `getMany` blocks until released, so a test can
 * park `#start` inside its compose await and interleave another call.
 */
function makeGatedProject() {
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  const project = makeProject();
  project.observation.getMany = async () => {
    await gate;
    return [];
  };
  return { project, release };
}

test("RACE: setEnabled(false) during #start's await does not re-arm the radios", async () => {
  const { project, release } = makeGatedProject();
  const h = harness({ project });

  const startPromise = h.controller.api.setEnabled(true); // parks in getMany
  await h.controller.api.setEnabled(false); // synchronous #stop
  release();
  await startPromise;
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.controller.getState().enabled, false);
  // The parked start must NOT have emitted ble-start / nsd-start after the stop.
  assert.ok(
    !h.broadcasts.some((f) => f.type === "ble-start"),
    `no ble-start expected, got ${JSON.stringify(h.broadcasts.map((f) => f.type))}`,
  );
  assert.ok(!h.broadcasts.some((f) => f.type === "nsd-start"));
  assert.equal(h.project.syncListeners.size, 0, "no leaked $sync listener");
  h.controller.close();
});

test("RACE: two overlapping setEnabled(true) leave exactly one live run", async () => {
  const g1 = makeGatedProject();
  const h = harness({ project: g1.project });
  // Second run uses a distinct gated project so we can prove only one wins.
  const g2 = makeGatedProject();
  h.manager.getProject = async () => {
    // First call → g1, subsequent → g2.
    return callCount++ === 0 ? g1.project : g2.project;
  };
  let callCount = 0;

  const p1 = h.controller.api.setEnabled(true);
  const p2 = h.controller.api.setEnabled(true);
  g1.release();
  g2.release();
  await Promise.all([p1, p2]);
  await new Promise((r) => setTimeout(r, 10));

  // Whichever committed last, only ONE run's listener/timers are live.
  const total = g1.project.syncListeners.size + g2.project.syncListeners.size;
  assert.equal(total, 1, "exactly one $sync listener across both runs");
  assert.equal(h.controller.getState().enabled, true);
  h.controller.close();
  assert.equal(
    g1.project.syncListeners.size + g2.project.syncListeners.size,
    0,
    "close() clears the live listener with none leaked",
  );
});

test("RACE: a start that throws after resolving leaves enabled=false and unpersisted", async () => {
  const h = harness();
  h.manager.startLocalPeerDiscoveryServer = async () => {
    throw new Error("bind failed");
  };
  await assert.rejects(() => h.controller.api.setEnabled(true), /bind failed/);
  assert.equal(h.controller.getState().enabled, false);
  assert.ok(!h.broadcasts.some((f) => f.type === "ble-start"));
  h.controller.close();
});

test("resume of a left project clears the persisted flag instead of looping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ble-left-"));
  /** @type {{ type: string, payload?: string }[]} */
  const broadcasts = [];
  let joined = true;
  const manager = {
    listProjects: async () => [
      { projectId: PID, status: joined ? "joined" : "left" },
    ],
    getProject: async () => makeProject(),
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

  joined = false; // user left the project between sessions
  const second = make();
  second.onManagerReady();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(second.getState().enabled, false);
  second.close();

  // The doomed flag was cleared, so a third boot does not retry.
  const before = broadcasts.filter((f) => f.type === "ble-start").length;
  const third = make();
  third.onManagerReady();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    broadcasts.filter((f) => f.type === "ble-start").length,
    before,
    "no further ble-start after the flag was cleared",
  );
  third.close();
});

test("explicit setEnabled with a non-joined project rejects", async () => {
  const h = harness({
    projects: [{ projectId: PID, status: "left" }],
  });
  await assert.rejects(
    () => h.controller.api.setEnabled(true, { projectPublicId: PID }),
    /not joined/,
  );
  assert.equal(h.controller.getState().enabled, false);
  h.controller.close();
});

test("frames arriving while disabled are dropped (no ghost peers)", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));
  await h.controller.api.setEnabled(false);

  h.controller.handleSighting({ payload: peerPayload(own), rssi: -50, address: "AA" });
  h.controller.handleNsdPeer({ name: "late", address: "192.168.1.9", port: 9 });
  h.controller.handleStatus({ scanning: "active", advertising: "active", blockers: [] });

  assert.equal(h.controller.getState().peers.length, 0);
  assert.equal(h.controller.getState().ble.scanning, "stopped");
  h.controller.close();
});

test("rejects NaN rssi and out-of-range nsd port", async () => {
  const h = harness();
  await h.controller.api.setEnabled(true);
  const own = decodeAdvertisement(Buffer.from(h.ownPayload(), "base64"));
  h.controller.handleSighting({ payload: peerPayload(own), rssi: NaN, address: "AA" });
  h.controller.handleNsdPeer({ name: "x", address: "10.0.0.1", port: 70000 });
  assert.equal(h.controller.getState().peers.length, 0);
  h.controller.close();
});
