import { test } from "node:test";
import assert from "node:assert/strict";

import { createBleDiscovery } from "./ble-discovery.js";

/**
 * The backend BLE policy layer: own-advertisement tracking, sighting
 * relay, the auto-connect decision (project match + state mismatch +
 * reachable ip:port) and its per-peer throttle — driven with encoded
 * frames and a fake manager, no radios and no real MapeoManager.
 */

const KNOWN_PAYLOAD_HEX = "434d0187cf0001e240deadbeefcc02c0a83101a8ca";

/**
 * Tweak fields of the known payload to build variants. Offsets per
 * docs/ble-discovery.md §3.
 *
 * @param {{ stateHash?: number, projectHash?: number, ipv4?: number[], port?: number }} [overrides]
 */
function payload(overrides = {}) {
  const bytes = Buffer.from(KNOWN_PAYLOAD_HEX, "hex");
  if (overrides.projectHash !== undefined) {
    bytes.writeUInt16BE(overrides.projectHash, 3);
  }
  if (overrides.stateHash !== undefined) {
    bytes.writeUInt32BE(overrides.stateHash >>> 0, 9);
  }
  if (overrides.ipv4 !== undefined) {
    Buffer.from(overrides.ipv4).copy(bytes, 15);
  }
  if (overrides.port !== undefined) {
    bytes.writeUInt16BE(overrides.port, 19);
  }
  return bytes.toString("base64");
}

/**
 * @param {{ manager?: null, minConnectIntervalMs?: number }} [options]
 *   `manager: null` simulates the pre-init window (no MapeoManager yet).
 */
function harness({ manager, ...options } = {}) {
  /** @type {object[]} */
  const broadcasts = [];
  /** @type {object[]} */
  const connects = [];
  const fakeManager =
    manager === null
      ? undefined
      : {
          /** @param {object} peer */
          connectLocalPeer: (peer) => connects.push(peer),
        };
  let nowMs = 0;
  const ble = createBleDiscovery({
    getManager: () => fakeManager,
    broadcast: (frame) => broadcasts.push(frame),
    now: () => nowMs,
    ...options,
  });
  return {
    ble,
    broadcasts,
    connects,
    /** @param {number} t */
    setNow: (t) => (nowMs = t),
  };
}

test("relays valid sightings as ble-peer broadcasts", () => {
  const { ble, broadcasts, connects } = harness();
  ble.handleSighting({ payload: payload(), rssi: -48, address: "AA:BB" });
  assert.deepEqual(broadcasts, [
    { type: "ble-peer", payload: payload(), rssi: -48, address: "AA:BB" },
  ]);
  // No own advertisement yet → relay only, no connect.
  assert.equal(connects.length, 0);
});

test("drops foreign payloads and malformed frames silently", () => {
  const { ble, broadcasts } = harness();
  ble.handleSighting({ payload: "AAAA", rssi: -48, address: "AA" });
  ble.handleSighting({ payload: 42, rssi: -48, address: "AA" });
  ble.handleSighting({ rssi: -48, address: "AA" });
  assert.equal(broadcasts.length, 0);
});

test("connects a same-project peer with a differing state hash", () => {
  const { ble, connects } = harness();
  ble.handleOwn({ payload: payload({ stateHash: 0x1111 }) });
  ble.handleSighting({
    payload: payload({ stateHash: 0x2222 }),
    rssi: -48,
    address: "AA:BB",
  });
  assert.deepEqual(connects, [
    { address: "192.168.49.1", port: 43210, name: "ble:192.168.49.1:43210" },
  ]);
});

test("does not connect on state match, project mismatch, or missing ip/port", () => {
  const { ble, connects } = harness();
  ble.handleOwn({ payload: payload({ stateHash: 0x1111 }) });

  // Same state — in sync.
  ble.handleSighting({ payload: payload({ stateHash: 0x1111 }), rssi: -1, address: "A" });
  // Different project.
  ble.handleSighting({
    payload: payload({ stateHash: 0x2222, projectHash: 0x0001 }),
    rssi: -1,
    address: "B",
  });
  // No address / no port.
  ble.handleSighting({
    payload: payload({ stateHash: 0x2222, ipv4: [0, 0, 0, 0] }),
    rssi: -1,
    address: "C",
  });
  ble.handleSighting({
    payload: payload({ stateHash: 0x2222, port: 0 }),
    rssi: -1,
    address: "D",
  });
  assert.equal(connects.length, 0);
});

test("clearing the own advertisement disables auto-connect", () => {
  const { ble, connects } = harness();
  ble.handleOwn({ payload: payload({ stateHash: 0x1111 }) });
  ble.handleOwn({ payload: null });
  ble.handleSighting({
    payload: payload({ stateHash: 0x2222 }),
    rssi: -1,
    address: "A",
  });
  assert.equal(connects.length, 0);
});

test("throttles repeat connects per peer, keyed by ip:port", () => {
  const { ble, connects, setNow } = harness({ minConnectIntervalMs: 30_000 });
  ble.handleOwn({ payload: payload({ stateHash: 0x1111 }) });
  const sight = () =>
    ble.handleSighting({
      payload: payload({ stateHash: 0x2222 }),
      rssi: -1,
      address: "AA:BB",
    });

  sight();
  setNow(10_000);
  sight(); // inside the window — suppressed
  assert.equal(connects.length, 1);

  setNow(31_000);
  sight(); // window elapsed — reconnect allowed
  assert.equal(connects.length, 2);

  // A different peer is not throttled by the first one's entry.
  ble.handleSighting({
    payload: payload({ stateHash: 0x2222, port: 9999 }),
    rssi: -1,
    address: "CC:DD",
  });
  assert.equal(connects.length, 3);
});

test("survives a missing manager and a throwing connectLocalPeer", () => {
  const noManager = harness({ manager: null });
  noManager.ble.handleOwn({ payload: payload({ stateHash: 0x1111 }) });
  noManager.ble.handleSighting({
    payload: payload({ stateHash: 0x2222 }),
    rssi: -1,
    address: "A",
  });
  assert.equal(noManager.broadcasts.length, 1); // relay still works

  const throwing = createBleDiscovery({
    getManager: () => ({
      connectLocalPeer: () => {
        throw new Error("nope");
      },
    }),
    broadcast: () => {},
  });
  throwing.handleOwn({ payload: payload({ stateHash: 0x1111 }) });
  // Must not throw.
  throwing.handleSighting({
    payload: payload({ stateHash: 0x2222 }),
    rssi: -1,
    address: "A",
  });
});

test("relays well-formed ble-error frames and drops malformed ones", () => {
  const { ble, broadcasts } = harness();
  ble.handleError({ scope: "scan", code: "ERR_BLE_SCAN", message: "boom" });
  ble.handleError({ scope: "scan" });
  assert.deepEqual(broadcasts, [
    { type: "ble-error", scope: "scan", code: "ERR_BLE_SCAN", message: "boom" },
  ]);
});
