import { networkInterfaces } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TypedEmitter } from "tiny-typed-emitter";

import {
  decodeAdvertisement,
  deriveDailyProjectHash,
  deriveStateHash,
  encodeAdvertisement,
} from "./ble-codec.js";

/**
 * The discovery controller — the single owner of BLE peer discovery
 * (docs/ble-discovery.md §4/§6). Native engines (Kotlin in the FGS,
 * Swift in-process on iOS) are dumb radio drivers commanded over the
 * control socket; the front end observes and controls through the
 * app-services RPC. This class owns everything in between:
 *
 * - **Lifecycle**: `setEnabled(true)` starts core's local-peer TCP
 *   server, composes the advertisement, and broadcasts `ble-start`;
 *   the enabled flag + project persist to disk so an FGS restart
 *   resumes discovery with no main process involved.
 * - **Composition**: daily project hash (from the project public ID),
 *   content state hash (sorted doc versionIds of observations +
 *   tracks), doc count, own IPv4 + port. Recomposed on `$sync` state
 *   events (throttled), on an interval (IP changes, day rollover), and
 *   re-broadcast as `ble-advertise` when the payload changed.
 * - **Sightings** (`ble-sighting` frames): decoded, folded into the
 *   peer table (RSSI smoothing, cluster hysteresis, staleness expiry),
 *   and — for same-project peers with a differing state hash and a
 *   reachable ip:port — fed to `manager.connectLocalPeer`, throttled
 *   per peer. This is what keeps discovery→sync working while the
 *   main app process is dead.
 * - **Status** (`ble-status` frames): the engine's view of the radios
 *   (scanning/advertising/blockers), stored and surfaced.
 * - **Observability**: `getState()` snapshots + throttled
 *   `discovery-state` events, re-emitted by the services object so the
 *   front end gets them via `comapeoServicesClient.on(...)`.
 *
 * Battery/charging/flags are advertised as unknown/false in Phase 1 —
 * they matter for Phase 3 leader election; a native stamp of byte 13
 * is the planned mechanism.
 *
 * @typedef {object} DiscoveredPeer
 * @property {string} id `"<ip>:<port>"`, or `"ble:<sender address>"`
 * @property {boolean} sameProject
 * @property {boolean} hasDifferentSyncState
 * @property {number} rssi latest raw RSSI (dBm)
 * @property {boolean} inCluster
 * @property {number} lastSeenAt ms epoch
 * @property {string | null} address
 * @property {number} port
 *
 * @typedef {object} DiscoveryState
 * @property {boolean} enabled
 * @property {string | null} projectPublicId
 * @property {{ scanning: string, advertising: string, blockers: string[],
 *   lastError: { scope: string, code: string, message: string } | null }} ble
 * @property {DiscoveredPeer[]} peers
 */

const PERSIST_FILENAME = "ble-discovery.json";
const REFRESH_INTERVAL_MS = 60_000;
const SYNC_EVENT_REFRESH_MIN_INTERVAL_MS = 5_000;
const PEER_TIMEOUT_MS = 30_000;
const PEER_SWEEP_INTERVAL_MS = 15_000;
const EMIT_DEBOUNCE_MS = 300;
const CLUSTER_ENTER_RSSI = -60;
const CLUSTER_EXIT_RSSI = -66;
const RSSI_SMOOTHING = 0.3;
const DEFAULT_MIN_CONNECT_INTERVAL_MS = 30_000;
const CONNECT_ENTRY_TTL_MS = 10 * 60_000;

export class DiscoveryController extends TypedEmitter {
  #getManager;
  #broadcast;
  #storageDir;
  #now;
  #minConnectIntervalMs;
  #getInterfaces;

  #enabled = false;
  /** @type {string | null} */
  #projectPublicId = null;
  /** @type {import("./ble-codec.js").BleAdvertisement | null} */
  #own = null;
  /** @type {string | null} last broadcast payload (base64), for change detection */
  #ownPayloadB64 = null;
  #port = 0;
  /** @type {any} held project handle while enabled */
  #project = null;
  /** @type {(() => void) | null} unsubscribe from $sync events */
  #unsubscribeSync = null;

  /** @type {Map<string, DiscoveredPeer & { smoothedRssi: number }>} */
  #peers = new Map();
  #ble = {
    scanning: "stopped",
    advertising: "stopped",
    /** @type {string[]} */
    blockers: [],
    /** @type {{ scope: string, code: string, message: string } | null} */
    lastError: null,
  };
  /** @type {Map<string, number>} */
  #lastConnectAt = new Map();

  /** @type {ReturnType<typeof setInterval> | null} */
  #refreshTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  #sweepTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #emitTimer = null;
  #lastSyncRefreshAt = 0;

  /**
   * The RPC-facing surface, exposed as `comapeoServices.discovery`.
   * Bound so rpc-reflector can call the methods detached.
   */
  api = {
    /** @returns {Promise<DiscoveryState>} */
    getState: async () => this.getState(),
    /**
     * @param {boolean} enabled
     * @param {{ projectPublicId?: string }} [opts]
     */
    setEnabled: async (enabled, opts) => {
      if (enabled) {
        await this.#start(opts?.projectPublicId);
      } else {
        this.#stop();
      }
    },
  };

  /**
   * @param {object} options
   * @param {() => any} options.getManager Late-bound MapeoManager.
   * @param {(frame: { type: string } & import("type-fest").JsonObject) => void} options.broadcast
   * @param {string} options.storageDir For the persisted enabled flag.
   * @param {() => number} [options.now]
   * @param {number} [options.minConnectIntervalMs]
   * @param {() => ReturnType<typeof networkInterfaces>} [options.getInterfaces]
   */
  constructor({
    getManager,
    broadcast,
    storageDir,
    now = Date.now,
    minConnectIntervalMs = DEFAULT_MIN_CONNECT_INTERVAL_MS,
    getInterfaces = networkInterfaces,
  }) {
    super();
    this.#getManager = getManager;
    this.#broadcast = broadcast;
    this.#storageDir = storageDir;
    this.#now = now;
    this.#minConnectIntervalMs = minConnectIntervalMs;
    this.#getInterfaces = getInterfaces;
  }

  /** @returns {DiscoveryState} */
  getState() {
    return {
      enabled: this.#enabled,
      projectPublicId: this.#projectPublicId,
      ble: {
        scanning: this.#ble.scanning,
        advertising: this.#ble.advertising,
        blockers: [...this.#ble.blockers],
        lastError: this.#ble.lastError,
      },
      peers: [...this.#peers.values()].map(
        ({ smoothedRssi: _smoothed, ...peer }) => ({ ...peer }),
      ),
    };
  }

  /**
   * Call once the manager exists (post-`construct`): resumes discovery
   * if it was enabled when the process last died — the piece that
   * makes an FGS restart self-heal without the main app process.
   */
  onManagerReady() {
    const persisted = this.#readPersisted();
    if (!persisted?.enabled) return;
    this.#start(persisted.projectPublicId ?? undefined).catch((e) => {
      console.warn("ble: failed to resume discovery", e);
    });
  }

  /** Stop timers/subscriptions (process shutdown). */
  close() {
    this.#teardownRuntime();
  }

  /**
   * `ble-sighting` from a native engine.
   * @param {Record<string, unknown>} message
   */
  handleSighting(message) {
    if (
      typeof message.payload !== "string" ||
      typeof message.rssi !== "number" ||
      typeof message.address !== "string"
    ) {
      console.warn("Ignoring malformed ble-sighting frame");
      return;
    }
    let decoded = null;
    try {
      decoded = decodeAdvertisement(Buffer.from(message.payload, "base64"));
    } catch {
      decoded = null;
    }
    // The native filters only match the "CM" prefix (or the service
    // UUID); foreign or corrupt payloads are dropped here.
    if (decoded === null) return;

    this.#updatePeer(decoded, message.rssi, message.address);
    this.#maybeConnect(decoded);
    this.#scheduleEmit();
  }

  /**
   * `ble-status` from a native engine.
   * @param {Record<string, unknown>} message
   */
  handleStatus(message) {
    if (
      typeof message.scanning !== "string" ||
      typeof message.advertising !== "string" ||
      !Array.isArray(message.blockers)
    ) {
      console.warn("Ignoring malformed ble-status frame");
      return;
    }
    this.#ble.scanning = message.scanning;
    this.#ble.advertising = message.advertising;
    this.#ble.blockers = message.blockers.filter(
      /** @returns {b is string} */ (b) => typeof b === "string",
    );
    const err = /** @type {Record<string, unknown> | undefined} */ (
      message.lastError
    );
    this.#ble.lastError =
      err &&
      typeof err.scope === "string" &&
      typeof err.code === "string" &&
      typeof err.message === "string"
        ? { scope: err.scope, code: err.code, message: err.message }
        : null;
    this.#scheduleEmit();
  }

  /** @param {string} [projectPublicId] */
  async #start(projectPublicId) {
    const manager = this.#getManager();
    if (!manager) {
      throw new Error("Cannot enable discovery before the backend is ready");
    }
    const pid = projectPublicId ?? (await this.#soleJoinedProjectId(manager));
    const project = await manager.getProject(pid);

    // From here on we are committed; tear down any previous run first
    // (setEnabled(true) with a different project is a restart).
    this.#teardownRuntime();
    this.#enabled = true;
    this.#projectPublicId = pid;
    this.#project = project;
    this.#writePersisted();

    const { port } = await manager.startLocalPeerDiscoveryServer();
    this.#port = port;
    await this.#refreshAdvertisement("ble-start");

    const onSyncState = () => {
      const t = this.#now();
      if (t - this.#lastSyncRefreshAt < SYNC_EVENT_REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      this.#lastSyncRefreshAt = t;
      this.#refreshAdvertisement().catch((e) =>
        console.warn("ble: advertisement refresh failed", e),
      );
    };
    project.$sync.on("sync-state", onSyncState);
    this.#unsubscribeSync = () => project.$sync.off("sync-state", onSyncState);

    this.#refreshTimer = setInterval(() => {
      // Covers IP changes, UTC-day rollover, and doc edits that produce
      // no sync-state event. Only re-broadcasts when the payload moved.
      this.#refreshAdvertisement().catch((e) =>
        console.warn("ble: advertisement refresh failed", e),
      );
    }, REFRESH_INTERVAL_MS);
    this.#refreshTimer.unref?.();
    this.#sweepTimer = setInterval(
      () => this.#sweepStalePeers(),
      PEER_SWEEP_INTERVAL_MS,
    );
    this.#sweepTimer.unref?.();
    this.#scheduleEmit();
  }

  #stop() {
    this.#teardownRuntime();
    this.#enabled = false;
    // Deliberately does NOT stop core's local-peer TCP server: mDNS (or
    // a host-driven flow) may share it, and an idle listener is cheap.
    this.#writePersisted();
    this.#broadcast({ type: "ble-stop" });
    this.#peers.clear();
    this.#ble.scanning = "stopped";
    this.#ble.advertising = "stopped";
    this.#ble.blockers = [];
    this.#scheduleEmit();
  }

  #teardownRuntime() {
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#refreshTimer = null;
    this.#sweepTimer = null;
    this.#project = null;
    this.#own = null;
    this.#ownPayloadB64 = null;
  }

  /** @param {any} manager */
  async #soleJoinedProjectId(manager) {
    const projects = await manager.listProjects();
    const joined = projects.filter(
      (/** @type {{ status?: string }} */ p) => p.status === "joined",
    );
    if (joined.length === 1) return joined[0].projectId;
    throw new Error(
      joined.length === 0
        ? "Cannot enable discovery: no joined project"
        : "Cannot enable discovery: multiple projects — pass opts.projectPublicId",
    );
  }

  /** @param {"ble-start" | "ble-advertise"} [frameType] */
  async #refreshAdvertisement(frameType = "ble-advertise") {
    const project = this.#project;
    const pid = this.#projectPublicId;
    if (!this.#enabled || !project || pid === null) return;

    const [observations, tracks] = await Promise.all([
      project.observation.getMany({ includeDeleted: true }),
      project.track.getMany({ includeDeleted: true }),
    ]);
    /** @type {string[]} */
    const versionIds = [];
    for (const doc of observations) versionIds.push(String(doc.versionId));
    for (const doc of tracks) versionIds.push(String(doc.versionId));
    versionIds.sort();

    /** @type {import("./ble-codec.js").BleAdvertisement} */
    const ad = {
      projectHash: deriveDailyProjectHash(
        Buffer.from(pid, "utf8"),
        new Date(this.#now()),
      ),
      totalBlocks: versionIds.length,
      stateHash: deriveStateHash(versionIds.join("\n")),
      batteryPercent: null,
      charging: false,
      isHotspotLeader: false,
      hasWifi: false,
      inviteMode: false,
      address: this.#pickIpv4(),
      port: this.#port,
    };
    const payloadB64 = encodeAdvertisement(ad).toString("base64");
    // A start frame always ships (it also switches the radios on);
    // refreshes only re-broadcast on change.
    if (frameType === "ble-advertise" && payloadB64 === this.#ownPayloadB64) {
      return;
    }
    this.#own = ad;
    this.#ownPayloadB64 = payloadB64;
    this.#broadcast({ type: frameType, payload: payloadB64 });
    this.#scheduleEmit();
  }

  /** @returns {string | null} */
  #pickIpv4() {
    const interfaces = this.#getInterfaces();
    /** @type {string | null} */
    let fallback = null;
    for (const [name, addresses] of Object.entries(interfaces)) {
      for (const addr of addresses ?? []) {
        const isV4 = addr.family === "IPv4" || /** @type {unknown} */ (addr.family) === 4;
        if (!isV4 || addr.internal) continue;
        // Prefer WiFi/AP-looking interfaces; remember anything else.
        if (/^(wlan|en|ap|swlan)/.test(name)) return addr.address;
        fallback = fallback ?? addr.address;
      }
    }
    return fallback;
  }

  /**
   * @param {import("./ble-codec.js").BleAdvertisement} ad
   * @param {number} rssi
   * @param {string} senderAddress
   */
  #updatePeer(ad, rssi, senderAddress) {
    const id =
      ad.address !== null && ad.port !== 0
        ? `${ad.address}:${ad.port}`
        : `ble:${senderAddress}`;
    const previous = this.#peers.get(id);
    const smoothedRssi =
      previous === undefined
        ? rssi
        : RSSI_SMOOTHING * rssi + (1 - RSSI_SMOOTHING) * previous.smoothedRssi;
    const inCluster = previous?.inCluster
      ? smoothedRssi >= CLUSTER_EXIT_RSSI
      : smoothedRssi >= CLUSTER_ENTER_RSSI;
    this.#peers.set(id, {
      id,
      sameProject:
        this.#own !== null && ad.projectHash === this.#own.projectHash,
      hasDifferentSyncState:
        this.#own !== null && ad.stateHash !== this.#own.stateHash,
      rssi,
      smoothedRssi,
      inCluster,
      lastSeenAt: this.#now(),
      address: ad.address,
      port: ad.port,
    });
  }

  /** @param {import("./ble-codec.js").BleAdvertisement} peer */
  #maybeConnect(peer) {
    const manager = this.#getManager();
    const own = this.#own;
    if (!this.#enabled || !manager || own === null) return;
    if (peer.projectHash !== own.projectHash) return;
    // Equal hash ⇒ (within 2^-32) same content ⇒ nothing to exchange.
    if (peer.stateHash === own.stateHash) return;
    if (peer.address === null || peer.port === 0) return;

    const key = `${peer.address}:${peer.port}`;
    const t = this.#now();
    const last = this.#lastConnectAt.get(key);
    if (last !== undefined && t - last < this.#minConnectIntervalMs) return;
    for (const [k, at] of this.#lastConnectAt) {
      if (t - at > CONNECT_ENTRY_TTL_MS) this.#lastConnectAt.delete(k);
    }
    this.#lastConnectAt.set(key, t);
    try {
      manager.connectLocalPeer({
        address: peer.address,
        port: peer.port,
        // core@7 keys local connections by discovery-server name, which
        // the advertisement can't carry — synthetic stable stand-in
        // (docs/ble-discovery.md §4 has the mDNS-duplicate caveat).
        name: `ble:${key}`,
      });
    } catch (e) {
      console.warn(`ble: connectLocalPeer(${key}) threw`, e);
    }
  }

  #sweepStalePeers() {
    const cutoff = this.#now() - PEER_TIMEOUT_MS;
    let changed = false;
    for (const [id, peer] of this.#peers) {
      if (peer.lastSeenAt < cutoff) {
        this.#peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.#scheduleEmit();
  }

  #scheduleEmit() {
    if (this.#emitTimer !== null) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      this.emit("discovery-state", this.getState());
    }, EMIT_DEBOUNCE_MS);
    this.#emitTimer.unref?.();
  }

  #persistPath() {
    return join(this.#storageDir, PERSIST_FILENAME);
  }

  /** @returns {{ enabled?: boolean, projectPublicId?: string | null } | null} */
  #readPersisted() {
    try {
      return JSON.parse(readFileSync(this.#persistPath(), "utf8"));
    } catch {
      return null;
    }
  }

  #writePersisted() {
    try {
      mkdirSync(this.#storageDir, { recursive: true });
      writeFileSync(
        this.#persistPath(),
        JSON.stringify({
          enabled: this.#enabled,
          projectPublicId: this.#projectPublicId,
        }),
      );
    } catch (e) {
      console.warn("ble: failed to persist discovery state", e);
    }
  }
}
