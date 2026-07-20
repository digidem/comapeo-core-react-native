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
 * The discovery controller — the single owner of local peer discovery,
 * BLE **and** DNS-SD/mDNS (docs/ble-discovery.md §4/§6). Native engines
 * (Kotlin in the FGS, Swift in-process on iOS) are dumb drivers
 * commanded over the control socket; the front end observes and
 * controls through the app-services RPC. This class owns everything in
 * between:
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
 * - **DNS-SD** (supplemental to BLE, same lifecycle): `nsd-start
 *   {name, port}` commands the native mDNS engine to register
 *   `_comapeo._tcp` under core's discovery-server name AND to browse
 *   for peers; resolved services come back as `nsd-peer {name,
 *   address, port}` and connect immediately with their REAL DNS-SD
 *   instance name — core's native dedup key — throttled per peer.
 *   `nsd-peer-lost` prunes; `nsd-status` mirrors `ble-status`. mDNS
 *   carries no sync-state gossip, so unlike BLE it connects on
 *   presence alone (matching the pre-existing host-app behaviour it
 *   replaces).
 * - **Observability**: `getState()` snapshots + throttled
 *   `discovery-state` events, re-emitted by the services object so the
 *   front end gets them via `comapeoServicesClient.on(...)`.
 *
 * Battery/charging/flags are advertised as unknown/false in Phase 1 —
 * they matter for Phase 3 leader election; a native stamp of byte 13
 * is the planned mechanism.
 *
 * @typedef {object} DiscoveredPeer
 * @property {"ble" | "mdns"} source
 * @property {string} id `"<ip>:<port>"`, `"ble:<sender>"`, or `"mdns:<name>"`
 * @property {boolean | null} sameProject null = unknown (mDNS carries no gossip)
 * @property {boolean | null} hasDifferentSyncState null = unknown
 * @property {number | null} rssi latest raw RSSI (dBm); null for mDNS
 * @property {boolean} inCluster always false for mDNS
 * @property {number} lastSeenAt ms epoch
 * @property {string | null} address
 * @property {number} port
 *
 * @typedef {object} DiscoveryState
 * @property {boolean} enabled
 * @property {string | null} projectPublicId
 * @property {{ scanning: string, advertising: string, blockers: string[],
 *   lastError: { scope: string, code: string, message: string } | null }} ble
 * @property {{ browsing: string, registered: string, blockers: string[],
 *   lastError: { scope: string, code: string, message: string } | null }} nsd
 * @property {DiscoveredPeer[]} peers
 */

const PERSIST_FILENAME = "ble-discovery.json";
const REFRESH_INTERVAL_MS = 60_000;
const SYNC_EVENT_REFRESH_MIN_INTERVAL_MS = 5_000;
const PEER_TIMEOUT_MS = 30_000;
/** Fallback TTL for mDNS peers (removal is normally the `nsd-peer-lost`
 * event; this only catches silent disappearances). */
const MDNS_PEER_TIMEOUT_MS = 5 * 60_000;
const PEER_SWEEP_INTERVAL_MS = 15_000;
const EMIT_DEBOUNCE_MS = 300;
const CLUSTER_ENTER_RSSI = -60;
const CLUSTER_EXIT_RSSI = -66;
const RSSI_SMOOTHING = 0.3;
const DEFAULT_MIN_CONNECT_INTERVAL_MS = 30_000;
const CONNECT_ENTRY_TTL_MS = 10 * 60_000;

/** Enabling discovery for a project that isn't currently joined (left,
 * deleted, or an ambiguous auto-select). Distinguished so the resume
 * path can clear a permanently-invalid persisted flag. */
export class ProjectMembershipError extends Error {
  constructor(/** @type {string} */ message) {
    super(message);
    this.name = "ProjectMembershipError";
  }
}

export class DiscoveryController extends TypedEmitter {
  #getManager;
  #broadcast;
  #storageDir;
  #now;
  #minConnectIntervalMs;
  #getInterfaces;
  #sweepIntervalMs;

  #enabled = false;
  /** @type {string | null} */
  #projectPublicId = null;
  /** @type {import("./ble-codec.js").BleAdvertisement | null} */
  #own = null;
  /** @type {string | null} last broadcast payload (base64), for change detection */
  #ownPayloadB64 = null;
  #port = 0;
  /** DNS-SD instance name from core's discovery server. */
  #serviceName = "";
  /** @type {any} held project handle while enabled */
  #project = null;
  /** @type {(() => void) | null} unsubscribe from $sync events */
  #unsubscribeSync = null;

  /**
   * Monotonic lifecycle generation. Bumped at the start of every
   * `#start` and every `#stop`; an in-flight async `#start` captures its
   * generation and bails at each checkpoint if it has been superseded.
   * This serialises the two mutating entry points — without it, a
   * `setEnabled(false)` (or a second `setEnabled(true)`) that lands
   * while `#start` is awaiting the DB re-arms the radios after the stop
   * and leaks the first run's listeners/timers.
   */
  #generation = 0;

  /** smoothedRssi is BLE-internal (EMA input); absent on mDNS entries. */
  /** @type {Map<string, DiscoveredPeer & { smoothedRssi?: number }>} */
  #peers = new Map();
  #ble = {
    scanning: "stopped",
    advertising: "stopped",
    /** @type {string[]} */
    blockers: [],
    /** @type {{ scope: string, code: string, message: string } | null} */
    lastError: null,
  };
  #nsd = {
    browsing: "stopped",
    registered: "stopped",
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
   * @param {number} [options.sweepIntervalMs] Peer-sweep cadence; small
   *   values let tests drive the sweep against an injected `now`.
   */
  constructor({
    getManager,
    broadcast,
    storageDir,
    now = Date.now,
    minConnectIntervalMs = DEFAULT_MIN_CONNECT_INTERVAL_MS,
    getInterfaces = networkInterfaces,
    sweepIntervalMs = PEER_SWEEP_INTERVAL_MS,
  }) {
    super();
    this.#getManager = getManager;
    this.#broadcast = broadcast;
    this.#storageDir = storageDir;
    this.#now = now;
    this.#minConnectIntervalMs = minConnectIntervalMs;
    this.#getInterfaces = getInterfaces;
    this.#sweepIntervalMs = sweepIntervalMs;
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
      nsd: {
        browsing: this.#nsd.browsing,
        registered: this.#nsd.registered,
        blockers: [...this.#nsd.blockers],
        lastError: this.#nsd.lastError,
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
      // A left/deleted project can never resume — clear the flag so we
      // don't retry the doomed start on every boot. Transient failures
      // (e.g. a not-yet-ready dependency) keep the flag and retry next
      // boot.
      if (e instanceof ProjectMembershipError) {
        this.#enabled = false;
        this.#projectPublicId = null;
        this.#writePersisted();
      }
    });
  }

  /** Stop timers/subscriptions (process shutdown). Bumps the generation
   * so a resume `#start` still in flight aborts. */
  close() {
    this.#generation++;
    this.#teardownRuntime();
  }

  /**
   * `ble-sighting` from a native engine.
   * @param {Record<string, unknown>} message
   */
  handleSighting(message) {
    // Native engine stop is async; its last frames race the stop. Drop
    // anything that arrives while disabled so a straggler can't
    // resurrect a peer into a table the sweeper no longer tends.
    if (!this.#enabled) return;
    if (
      typeof message.payload !== "string" ||
      Number.isNaN(message.rssi) ||
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
    if (!this.#enabled) return;
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

  /**
   * `nsd-peer` from a native mDNS engine: a resolved `_comapeo._tcp`
   * service. Connects with the peer's real DNS-SD instance name so
   * core's name-keyed dedup works exactly as with host-driven mDNS.
   * @param {Record<string, unknown>} message
   */
  handleNsdPeer(message) {
    if (!this.#enabled) return;
    if (
      typeof message.name !== "string" ||
      typeof message.address !== "string" ||
      typeof message.port !== "number" ||
      !Number.isInteger(message.port) ||
      message.port <= 0 ||
      message.port > 65535
    ) {
      console.warn("Ignoring malformed nsd-peer frame");
      return;
    }
    // Engines filter their own registration, but belt-and-braces: an
    // mDNS reflector can echo our own service back.
    if (message.name === this.#serviceName) return;
    const { name, address, port } = message;
    this.#peers.set(`mdns:${name}`, {
      source: "mdns",
      id: `mdns:${name}`,
      sameProject: null,
      hasDifferentSyncState: null,
      rssi: null,
      inCluster: false,
      lastSeenAt: this.#now(),
      address,
      port,
    });
    this.#connectThrottled(address, port, name);
    this.#scheduleEmit();
  }

  /** @param {Record<string, unknown>} message */
  handleNsdPeerLost(message) {
    if (!this.#enabled) return;
    if (typeof message.name !== "string") return;
    if (this.#peers.delete(`mdns:${message.name}`)) this.#scheduleEmit();
  }

  /** @param {Record<string, unknown>} message */
  handleNsdStatus(message) {
    if (!this.#enabled) return;
    if (
      typeof message.browsing !== "string" ||
      typeof message.registered !== "string" ||
      !Array.isArray(message.blockers)
    ) {
      console.warn("Ignoring malformed nsd-status frame");
      return;
    }
    this.#nsd.browsing = message.browsing;
    this.#nsd.registered = message.registered;
    this.#nsd.blockers = message.blockers.filter(
      /** @returns {b is string} */ (b) => typeof b === "string",
    );
    const err = /** @type {Record<string, unknown> | undefined} */ (
      message.lastError
    );
    this.#nsd.lastError =
      err &&
      typeof err.scope === "string" &&
      typeof err.code === "string" &&
      typeof err.message === "string"
        ? { scope: err.scope, code: err.code, message: err.message }
        : null;
    this.#scheduleEmit();
  }

  /**
   * All async work runs against locals and re-checks the captured
   * generation after every await, so a concurrent `#stop`/`#start`
   * aborts this run before it mutates shared state or turns any radio
   * on. Nothing is committed (memory, disk, or broadcast) until every
   * step has succeeded and this run is still current — a failed start
   * therefore leaves `enabled` unchanged rather than stranding it
   * `true` with the radios off.
   *
   * @param {string} [projectPublicId]
   */
  async #start(projectPublicId) {
    const gen = ++this.#generation;
    const manager = this.#getManager();
    if (!manager) {
      throw new Error("Cannot enable discovery before the backend is ready");
    }
    const pid = await this.#resolveJoinedProjectId(manager, projectPublicId);
    if (gen !== this.#generation) return;

    const project = await manager.getProject(pid);
    if (gen !== this.#generation) return;

    const { name, port } = await manager.startLocalPeerDiscoveryServer();
    if (gen !== this.#generation) return;

    const { ad, payloadB64 } = await this.#composeAdvertisement(
      project,
      pid,
      port,
    );
    if (gen !== this.#generation) return;

    // Commit point: everything succeeded and we are still current. Tear
    // down any previous run, then atomically adopt this one.
    this.#teardownRuntime();
    this.#enabled = true;
    this.#projectPublicId = pid;
    this.#project = project;
    this.#port = port;
    this.#serviceName = name;
    this.#own = ad;
    this.#ownPayloadB64 = payloadB64;
    this.#writePersisted();
    this.#broadcast({ type: "ble-start", payload: payloadB64 });
    this.#broadcast({ type: "nsd-start", name, port });

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
      this.#sweepIntervalMs,
    );
    this.#sweepTimer.unref?.();
    this.#scheduleEmit();
  }

  #stop() {
    // Bump the generation so any in-flight `#start` aborts at its next
    // checkpoint instead of re-arming the radios after this stop.
    this.#generation++;
    this.#teardownRuntime();
    this.#enabled = false;
    // Deliberately does NOT stop core's local-peer TCP server: mDNS (or
    // a host-driven flow) may share it, and an idle listener is cheap.
    this.#writePersisted();
    this.#broadcast({ type: "ble-stop" });
    this.#broadcast({ type: "nsd-stop" });
    this.#peers.clear();
    this.#ble.scanning = "stopped";
    this.#ble.advertising = "stopped";
    this.#ble.blockers = [];
    this.#nsd.browsing = "stopped";
    this.#nsd.registered = "stopped";
    this.#nsd.blockers = [];
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

  /**
   * Resolve the project to advertise and assert it is currently
   * *joined* — applied to all three paths (auto, explicit
   * `projectPublicId`, and persisted resume), because core's
   * `getProject` succeeds for a project the user has left, which would
   * otherwise keep advertising and auto-connecting a left project after
   * a restart. A membership failure throws `ProjectMembershipError` so
   * `onManagerReady` can clear a now-invalid persisted flag.
   *
   * @param {any} manager
   * @param {string} [projectPublicId]
   * @returns {Promise<string>}
   */
  async #resolveJoinedProjectId(manager, projectPublicId) {
    const projects = await manager.listProjects();
    const joined = projects.filter(
      (/** @type {{ status?: string }} */ p) => p.status === "joined",
    );
    if (projectPublicId !== undefined) {
      if (!joined.some((/** @type {{ projectId: string }} */ p) => p.projectId === projectPublicId)) {
        throw new ProjectMembershipError(
          `Cannot enable discovery: project ${projectPublicId} is not joined`,
        );
      }
      return projectPublicId;
    }
    if (joined.length === 1) return joined[0].projectId;
    throw new ProjectMembershipError(
      joined.length === 0
        ? "Cannot enable discovery: no joined project"
        : "Cannot enable discovery: multiple projects — pass opts.projectPublicId",
    );
  }

  /**
   * Build the advertisement + its base64 payload from a project, with
   * no side effects on instance state — so `#start` can compose into a
   * local before committing, and `#refreshAdvertisement` can compose
   * against live state.
   *
   * @param {any} project
   * @param {string} pid
   * @param {number} port
   * @returns {Promise<{ ad: import("./ble-codec.js").BleAdvertisement, payloadB64: string }>}
   */
  async #composeAdvertisement(project, pid, port) {
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
      port,
    };
    return { ad, payloadB64: encodeAdvertisement(ad).toString("base64") };
  }

  async #refreshAdvertisement() {
    const gen = this.#generation;
    const project = this.#project;
    const pid = this.#projectPublicId;
    if (!this.#enabled || !project || pid === null) return;

    const { ad, payloadB64 } = await this.#composeAdvertisement(
      project,
      pid,
      this.#port,
    );
    // A stop or restart during the compose await supersedes us.
    if (gen !== this.#generation || !this.#enabled) return;
    // Refreshes only re-broadcast when the payload actually moved.
    if (payloadB64 === this.#ownPayloadB64) return;
    this.#own = ad;
    this.#ownPayloadB64 = payloadB64;
    this.#broadcast({ type: "ble-advertise", payload: payloadB64 });
    this.#scheduleEmit();
  }

  /** @returns {string | null} */
  #pickIpv4() {
    const interfaces = this.#getInterfaces();
    /** @type {string | null} */
    let fallback = null;
    for (const [name, addresses] of Object.entries(interfaces)) {
      // Cellular interfaces carry a routable-looking IPv4 that no local
      // peer can reach — advertising it just makes peers dial (and 30s-
      // throttle against) a dead address, worse than advertising none.
      if (/^(rmnet|ccmni|pdp_ip|rev_rmnet|clat)/.test(name)) continue;
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
      source: "ble",
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
    const own = this.#own;
    if (own === null) return;
    if (peer.projectHash !== own.projectHash) return;
    // Equal hash ⇒ (within 2^-32) same content ⇒ nothing to exchange.
    if (peer.stateHash === own.stateHash) return;
    if (peer.address === null || peer.port === 0) return;
    // core@7 keys local connections by discovery-server name, which the
    // advertisement can't carry — synthetic stable stand-in (§4 has the
    // mDNS-duplicate caveat).
    this.#connectThrottled(
      peer.address,
      peer.port,
      `ble:${peer.address}:${peer.port}`,
    );
  }

  /**
   * @param {string} address
   * @param {number} port
   * @param {string} name
   */
  #connectThrottled(address, port, name) {
    const manager = this.#getManager();
    if (!this.#enabled || !manager) return;
    const key = `${address}:${port}`;
    const t = this.#now();
    const last = this.#lastConnectAt.get(key);
    if (last !== undefined && t - last < this.#minConnectIntervalMs) return;
    for (const [k, at] of this.#lastConnectAt) {
      if (t - at > CONNECT_ENTRY_TTL_MS) this.#lastConnectAt.delete(k);
    }
    this.#lastConnectAt.set(key, t);
    try {
      manager.connectLocalPeer({ address, port, name });
    } catch (e) {
      console.warn(`discovery: connectLocalPeer(${key}) threw`, e);
    }
  }

  #sweepStalePeers() {
    const now = this.#now();
    let changed = false;
    for (const [id, peer] of this.#peers) {
      // BLE peers re-advertise continuously, so a short TTL is right.
      // mDNS peers are event-driven (`nsd-peer-lost` is the primary
      // removal), but that event never comes if the browse dies or the
      // engine stops mid-session — so a long fallback TTL bounds the
      // table under a hostile mDNS flooder and clears silent
      // disappearances, while staying long enough not to evict a live
      // peer that simply isn't re-announcing.
      const ttl = peer.source === "ble" ? PEER_TIMEOUT_MS : MDNS_PEER_TIMEOUT_MS;
      if (now - peer.lastSeenAt > ttl) {
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
