import { decodeAdvertisement } from "./ble-codec.js";

/**
 * Backend half of BLE peer discovery (docs/ble-discovery.md §4).
 *
 * The Android FGS hosts the radios and forwards frames over the control
 * socket; this module owns the *policy*, so discovery keeps producing
 * sync connections while the main app process is dead:
 *
 * - `ble-own {payload}` — the advertisement the native engine is
 *   broadcasting for this device (null payload = advertising off).
 *   Decoded and kept as the baseline for connect decisions.
 * - `ble-sighting {payload, rssi, address}` — a (natively throttled)
 *   sighting of a peer advertisement. Decoded; relayed to control-
 *   socket observers as `ble-peer` (the main-process module surfaces
 *   these to JS for UI); and, when the peer is in the same project with
 *   a different sync state and a reachable ip:port, fed into
 *   `manager.connectLocalPeer` — rate-limited per peer.
 * - `ble-error {scope, code, message}` — native radio failure, relayed
 *   verbatim as a broadcast so the UI hears about it.
 *
 * Auto-connect requires an own-advertisement (for the project-hash
 * comparison); scan-only devices still get `ble-peer` relays but no
 * automatic connections.
 */

/** Floor between connectLocalPeer calls for one peer. Reconnect churn
 * is cheap but not free; sightings repeat every ~1s while in range. */
const DEFAULT_MIN_CONNECT_INTERVAL_MS = 30_000;

/** Forget connect-throttle entries after this long; also the pruning
 * horizon that keeps the map bounded under BLE MAC/IP churn. */
const CONNECT_ENTRY_TTL_MS = 10 * 60_000;

/**
 * @param {object} options
 * @param {() => (undefined | {
 *   connectLocalPeer: (peer: {
 *     address: string, port: number, name: string,
 *   }) => void,
 * })} options.getManager Late-bound: the manager doesn't exist until
 *   the rootkey handshake completes; sightings before then are relayed
 *   but can't connect.
 * @param {(frame: { type: string } & import("type-fest").JsonObject) => void} options.broadcast
 * @param {number} [options.minConnectIntervalMs]
 * @param {() => number} [options.now]
 */
export function createBleDiscovery({
  getManager,
  broadcast,
  minConnectIntervalMs = DEFAULT_MIN_CONNECT_INTERVAL_MS,
  now = Date.now,
}) {
  /** @type {import("./ble-codec.js").BleAdvertisement | null} */
  let own = null;
  /** @type {Map<string, number>} */
  const lastConnectAt = new Map();

  /** @param {string} base64 */
  const decodeBase64Payload = (base64) => {
    let bytes;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      return null;
    }
    return decodeAdvertisement(bytes);
  };

  /** @param {Record<string, unknown>} message */
  function handleOwn(message) {
    if (message.payload === null || message.payload === undefined) {
      own = null;
      return;
    }
    if (typeof message.payload !== "string") return;
    own = decodeBase64Payload(message.payload);
  }

  /** @param {Record<string, unknown>} message */
  function handleSighting(message) {
    if (
      typeof message.payload !== "string" ||
      typeof message.rssi !== "number" ||
      typeof message.address !== "string"
    ) {
      console.warn("Ignoring malformed ble-sighting frame");
      return;
    }
    const decoded = decodeBase64Payload(message.payload);
    // The native scan filter only matches the 2-byte "CM" prefix;
    // foreign 0xFFFF payloads land here and are dropped by the decoder.
    if (decoded === null) return;

    broadcast({
      type: "ble-peer",
      payload: message.payload,
      rssi: message.rssi,
      address: message.address,
    });
    maybeConnect(decoded);
  }

  /** @param {import("./ble-codec.js").BleAdvertisement} peer */
  function maybeConnect(peer) {
    const manager = getManager();
    if (!manager || own === null) return;
    if (peer.projectHash !== own.projectHash) return;
    // Equal hash ⇒ (within 2^-32) same sync state ⇒ nothing to exchange.
    if (peer.stateHash === own.stateHash) return;
    if (peer.address === null || peer.port === 0) return;

    const key = `${peer.address}:${peer.port}`;
    const t = now();
    const last = lastConnectAt.get(key);
    if (last !== undefined && t - last < minConnectIntervalMs) return;
    prune(t);
    lastConnectAt.set(key, t);
    try {
      manager.connectLocalPeer({
        address: peer.address,
        port: peer.port,
        // core@7 keys local connections by discovery-server name, which
        // the advertisement can't carry — synthetic stable stand-in.
        // (See docs/ble-discovery.md §4 on the mDNS-duplicate caveat.)
        name: `ble:${key}`,
      });
    } catch (e) {
      // Non-fatal: connection failures are normal (peer left, network
      // changed); the throttle stops this from spamming.
      console.warn(`ble: connectLocalPeer(${key}) threw`, e);
    }
  }

  /** @param {number} t */
  function prune(t) {
    for (const [key, at] of lastConnectAt) {
      if (t - at > CONNECT_ENTRY_TTL_MS) lastConnectAt.delete(key);
    }
  }

  /** @param {Record<string, unknown>} message */
  function handleError(message) {
    if (
      typeof message.scope !== "string" ||
      typeof message.code !== "string" ||
      typeof message.message !== "string"
    ) {
      console.warn("Ignoring malformed ble-error frame");
      return;
    }
    broadcast({
      type: "ble-error",
      scope: message.scope,
      code: message.code,
      message: message.message,
    });
  }

  return { handleOwn, handleSighting, handleError };
}
