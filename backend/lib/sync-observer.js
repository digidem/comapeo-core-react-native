// Sync-session telemetry derived from the lifecycle signals
// `@comapeo/core` exposes: each project's `$sync` emits `sync-state`
// with `data.isSyncEnabled` (edges mark session start/end) and a
// per-peer map of remaining `want`/`wanted` block counts. One session =
// the interval where data sync is enabled. Emits the usage-tier
// `comapeo.sync.session` transaction (see `sentry.js`) and the
// `metrics.syncSession` duration/bucket metrics — bucketed counts only,
// never peer identities or project IDs.

import * as metrics from "./metrics.js";
import * as sentry from "./sentry.js";

/**
 * Public sync state shape from `@comapeo/core`'s SyncApi (`$sync`).
 *
 * @typedef {{
 *   isSyncEnabled: boolean,
 *   want: number,
 *   wanted: number,
 * }} RemoteGroupState
 * @typedef {{
 *   initial: { isSyncEnabled: boolean },
 *   data: { isSyncEnabled: boolean },
 *   remoteDeviceSyncState: Record<string, { initial: RemoteGroupState, data: RemoteGroupState }>,
 * }} SyncApiState
 * @typedef {{
 *   getState: () => SyncApiState,
 *   on: (event: "sync-state", listener: (state: SyncApiState) => void) => unknown,
 *   off: (event: "sync-state", listener: (state: SyncApiState) => void) => unknown,
 *   stop: () => void,
 *   disconnectServers: () => void,
 * }} SyncApiLike
 * @typedef {{
 *   getServerDeviceIds?: () => Promise<string[]>,
 * }} WatchOptions
 */

// The sync API exposes remaining block counts, not byte counters, so a
// real bytes bucket isn't derivable; keep the attribute present with a
// stable placeholder until core exposes bytes.
const BYTES_BUCKET_UNKNOWN = "unknown";

/**
 * Observe every project the RN client opens: wraps `manager.getProject`
 * (the only project-open signal MapeoManager exposes — there is no
 * project-opened event) and attaches a session watcher to each new
 * project instance's `$sync`. No-op when Sentry never initialised.
 *
 * @param {import("@comapeo/core").MapeoManager} manager
 */
export function observeSyncSessions(manager) {
  if (!metrics.isEnabled()) return;
  /** @type {WeakSet<object>} */
  const observed = new WeakSet();
  const getProject = manager.getProject.bind(manager);
  manager.getProject = async (projectPublicId) => {
    const project = await getProject(projectPublicId);
    if (!observed.has(project.$sync)) {
      observed.add(project.$sync);
      watchSyncApi(project.$sync, {
        getServerDeviceIds: () => getServerDeviceIds(project.$member),
      });
    }
    return project;
  };
}

/** @param {import("@comapeo/core").MapeoProject["$member"]} memberApi */
async function getServerDeviceIds(memberApi) {
  const members = await memberApi.getMany();
  return members
    .filter((m) => m.deviceType === "selfHostedServer")
    .map((m) => m.deviceId);
}

/**
 * Track sync sessions on one project's `$sync`. Session start is the
 * `data.isSyncEnabled` false→true edge; end is the true→false edge
 * (manual stop or autostop-after-synced). Phases: `sync.discover` while
 * no peer is connected, `sync.replicate` once one is. A handshake phase
 * is not derivable — the noise/protomux handshake is internal to core.
 * Returns a detach function (used by tests).
 *
 * Also wraps `stop()` / `disconnectServers()` so that when the phone stops
 * serving a connected server peer (either call, or the autostop edge) one
 * `comapeo.sync.server_disconnect` metric records how much the server still
 * wanted — once per data-sync session on a server connection.
 *
 * @param {SyncApiLike} syncApi
 * @param {WatchOptions} [options]
 */
export function watchSyncApi(syncApi, { getServerDeviceIds } = {}) {
  /**
   * @type {{
   *   startedAt: number,
   *   maxPeers: number,
   *   synced: boolean,
   *   discovering: boolean,
   *   trace: import("./sentry.js").SyncSessionTransaction | null,
   * } | null}
   */
  let session = null;

  // The wrappers run synchronously but membership is async, so cache the
  // server ids and refresh whenever a peer we have not seen before appears.
  /** @type {Set<string>} */
  let serverIds = new Set();
  /** @type {Set<string>} */
  const seenPeers = new Set();
  let serverReported = false;

  const refreshServerIds = () => {
    getServerDeviceIds?.().then(
      (ids) => {
        serverIds = new Set(ids);
      },
      () => {},
    );
  };

  /**
   * Blocks the connected server peers still want from us, or `null` when
   * no server peer is connected.
   *
   * @param {SyncApiState} state
   */
  const serverWant = (state) => {
    /** @type {number | null} */
    let want = null;
    for (const [peerId, peer] of Object.entries(state.remoteDeviceSyncState)) {
      if (serverIds.has(peerId)) want = (want ?? 0) + peer.data.want;
    }
    return want;
  };

  /**
   * @param {"disconnect" | "stop" | "autostop"} reason
   * @param {SyncApiState} state
   * @param {boolean} [dataEnabled]
   */
  const reportServerDisconnect = (
    reason,
    state,
    dataEnabled = state.data.isSyncEnabled,
  ) => {
    if (serverReported) return;
    const want = serverWant(state);
    if (want === null) return;
    serverReported = true;
    metrics.syncServerDisconnect(
      reason,
      metrics.serverWantBucket(want),
      dataEnabled,
    );
  };

  /** @param {SyncApiState} state */
  const onSyncState = (state) => {
    const peerIds = Object.keys(state.remoteDeviceSyncState);
    const peers = peerIds.length;
    if (peerIds.some((id) => !seenPeers.has(id))) {
      for (const id of peerIds) seenPeers.add(id);
      refreshServerIds();
    }
    if (serverWant(state) === null) serverReported = false;
    if (!session) {
      if (!state.data.isSyncEnabled) return;
      serverReported = false;
      // A server's deviceType may not have synced when it first appeared.
      refreshServerIds();
      session = {
        startedAt: performance.now(),
        maxPeers: 0,
        synced: false,
        discovering: peers === 0,
        trace: sentry.startSyncSessionTransaction(),
      };
      session.trace?.startPhase(session.discovering ? "discover" : "replicate");
    }
    if (peers > 0) {
      session.maxPeers = Math.max(session.maxPeers, peers);
      // Recomputed per event so late-arriving data flips it back off; kept
      // when peers drop to 0 (an empty peer map says nothing about sync).
      session.synced = isAllSynced(state);
      if (session.discovering) {
        session.discovering = false;
        session.trace?.startPhase("replicate");
      }
    }
    if (!state.data.isSyncEnabled) {
      // Any edge not already reported by the stop() wrapper is the autostop.
      reportServerDisconnect("autostop", state, true);
      const outcome = session.synced ? "completed" : "stopped";
      const durationMs = performance.now() - session.startedAt;
      const peersBucket = metrics.peersBucket(session.maxPeers);
      session.trace?.end({
        outcome,
        peersBucket,
        bytesBucket: BYTES_BUCKET_UNKNOWN,
      });
      metrics.syncSession(
        outcome,
        durationMs,
        peersBucket,
        BYTES_BUCKET_UNKNOWN,
      );
      session = null;
    }
  };

  // Report before delegating: core's stop() emits the data-disabled edge
  // synchronously, which would otherwise read as an autostop.
  const { stop, disconnectServers } = syncApi;
  /** @param {"disconnect" | "stop"} reason */
  const reportBeforeCall = (reason) => {
    try {
      reportServerDisconnect(reason, syncApi.getState());
    } catch {
      // Telemetry must never block the real call.
    }
  };
  syncApi.stop = () => {
    reportBeforeCall("stop");
    return stop.call(syncApi);
  };
  syncApi.disconnectServers = () => {
    reportBeforeCall("disconnect");
    return disconnectServers.call(syncApi);
  };

  syncApi.on("sync-state", onSyncState);
  // Seed from the current state in case data sync was already running
  // when the watcher attached.
  onSyncState(syncApi.getState());
  return () => {
    syncApi.off("sync-state", onSyncState);
    syncApi.stop = stop;
    syncApi.disconnectServers = disconnectServers;
  };
}

/**
 * All connected peers have nothing left to send or receive in either
 * namespace group. Only meaningful with ≥1 peer.
 *
 * @param {SyncApiState} state
 */
function isAllSynced(state) {
  const devices = Object.values(state.remoteDeviceSyncState);
  if (devices.length === 0) return false;
  return devices.every(
    (d) =>
      d.initial.want === 0 &&
      d.initial.wanted === 0 &&
      d.data.want === 0 &&
      d.data.wanted === 0,
  );
}
