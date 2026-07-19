import {
  decodeAdvertisement,
  encodeAdvertisement,
  type CoMapeoAdvertisement,
} from "./wire-format";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { TypedEmitter } from "./emitter";
import type {
  BleAdvertisementPayload,
  BleCapabilities,
  BleErrorPayload,
  BleNativeModuleLike,
  BlePermissionResponse,
} from "./BleDiscovery.types";

/**
 * A discovered CoMapeo peer, aggregated from repeated advertisement
 * sightings.
 */
export type BlePeer = {
  /**
   * Stable-ish identity for the peer during a session. When the
   * advertisement carries an IP:port this is `"<ip>:<port>"` — stable
   * across BLE MAC rotation. Otherwise it falls back to
   * `"ble:<mac>"`, which modern devices rotate every ~15 minutes (the
   * old entry then times out as `peerLost` and the peer reappears
   * under a new key).
   */
  key: string;
  advertisement: CoMapeoAdvertisement;
  /** Most recent raw RSSI in dBm. */
  rssi: number;
  /** Exponentially smoothed RSSI used for cluster classification. */
  smoothedRssi: number;
  /**
   * Whether the peer is currently classified as physically clustered
   * with this device (see D7: RSSI thresholding with hysteresis — good
   * for the binary near/far call, useless for distance).
   */
  inCluster: boolean;
  /** `Date.now()`-clock timestamp of the last sighting. */
  lastSeenAt: number;
  /** BLE MAC of the last sighting (randomized by the OS; debug aid). */
  deviceAddress: string;
};

export class BleDiscoveryError extends Error {
  readonly scope: BleErrorPayload["scope"];
  readonly code: string;

  constructor(payload: BleErrorPayload) {
    super(`[${payload.scope}/${payload.code}] ${payload.message}`);
    this.name = "BleDiscoveryError";
    this.scope = payload.scope;
    this.code = payload.code;
  }
}

export type BleDiscoveryEvents = {
  /** A peer was seen for the first time or its record changed. */
  peer: [peer: BlePeer];
  /** No sighting for `peerTimeoutMs`; the record was dropped. */
  peerLost: [key: string, peer: BlePeer];
  /** Async native-side failure (advertising or scanning died). */
  error: [error: BleDiscoveryError];
};

export type BleDiscoveryOptions = {
  /** Smoothed RSSI (dBm) at/above which a peer *enters* the cluster.
   * Default −60 (see design decision D7). */
  clusterEnterRssi?: number;
  /** Smoothed RSSI (dBm) below which a clustered peer *exits* — kept a
   * few dB under the enter threshold so boundary peers don't flap.
   * Default −66. */
  clusterExitRssi?: number;
  /** Drop a peer after this long without a sighting. Default 30 000 ms
   * (advertisements arrive every few hundred ms in range). */
  peerTimeoutMs?: number;
  /** EMA weight of a new RSSI sample, in (0, 1]. Default 0.3. */
  rssiSmoothing?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
};

const DEFAULT_OPTIONS: Required<Omit<BleDiscoveryOptions, "now">> = {
  clusterEnterRssi: -60,
  clusterExitRssi: -66,
  peerTimeoutMs: 30_000,
  rssiSmoothing: 0.3,
};

/**
 * Phase-1 BLE discovery manager: drives the native
 * `ComapeoBleDiscovery` module (scan always; advertise when an
 * advertisement is set and the platform can), decodes sightings,
 * maintains the peer table with RSSI smoothing / cluster
 * classification / staleness expiry, and emits `peer` / `peerLost`.
 *
 * The manager knows nothing about MapeoManager: the host app composes
 * the `CoMapeoAdvertisement` (sync state from `$sync`, IP:port from
 * `startLocalPeerDiscoveryServer`) and, on `peer` events whose
 * `advertisement.stateHash` differs from its own, feeds
 * `advertisement.address`/`port` into `comapeo.connectLocalPeer(...)`.
 */
export class BleDiscovery extends TypedEmitter<BleDiscoveryEvents> {
  #native: BleNativeModuleLike | null;
  #options: Required<Omit<BleDiscoveryOptions, "now">>;
  #now: () => number;
  #peers = new Map<string, BlePeer>();
  #advertisement: CoMapeoAdvertisement | null = null;
  #running = false;
  #advertising = false;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    nativeModule: BleNativeModuleLike | null,
    options: BleDiscoveryOptions = {},
  ) {
    super();
    this.#native = nativeModule;
    const { now, ...rest } = options;
    this.#options = { ...DEFAULT_OPTIONS, ...rest };
    this.#now = now ?? Date.now;
  }

  /** `false` on platforms without the native module (iOS for now, web,
   * plain Jest) — every method is then a safe no-op or rejection. */
  get isAvailable(): boolean {
    return this.#native !== null;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  getCapabilities(): BleCapabilities {
    return this.#native?.getCapabilities() ?? { available: false, enabled: false };
  }

  getPermissionsAsync(): Promise<BlePermissionResponse> {
    return (
      this.#native?.getPermissionsAsync() ??
      Promise.resolve(UNAVAILABLE_PERMISSION)
    );
  }

  requestPermissionsAsync(): Promise<BlePermissionResponse> {
    return (
      this.#native?.requestPermissionsAsync() ??
      Promise.resolve(UNAVAILABLE_PERMISSION)
    );
  }

  /**
   * Start scanning (and advertising, when `advertisement` is given or
   * was previously set). Rejects when the native module is missing —
   * check `isAvailable` first. Idempotent while running except that a
   * new `advertisement` replaces the current one.
   */
  async start(
    { advertisement }: { advertisement?: CoMapeoAdvertisement } = {},
  ): Promise<void> {
    const native = this.#requireNative();
    if (advertisement !== undefined) this.#advertisement = advertisement;
    if (!this.#running) {
      native.addListener("bleAdvertisement", this.#handleAdvertisement);
      native.addListener("bleError", this.#handleError);
      this.#running = true;
      try {
        await native.startScanning();
      } catch (error) {
        await this.stop();
        throw error;
      }
      this.#sweepTimer = setInterval(
        () => this.#sweepStalePeers(),
        Math.max(1_000, this.#options.peerTimeoutMs / 2),
      );
    }
    if (this.#advertisement !== null) {
      await this.#startAdvertising(native, this.#advertisement);
    }
  }

  /**
   * Replace (or with `null` clear) this device's advertisement. Takes
   * effect immediately while running; otherwise stored for the next
   * `start()`. Call whenever the advertised sync state goes stale —
   * block count, state hash, IP or battery changed.
   */
  async setAdvertisement(
    advertisement: CoMapeoAdvertisement | null,
  ): Promise<void> {
    this.#advertisement = advertisement;
    if (!this.#running || this.#native === null) return;
    if (advertisement === null) {
      if (this.#advertising) {
        this.#advertising = false;
        await this.#native.stopAdvertising();
      }
    } else {
      await this.#startAdvertising(this.#native, advertisement);
    }
  }

  /** Stop scanning/advertising and clear the peer table (no `peerLost`
   * events — the table is being discarded, not timing out). */
  async stop(): Promise<void> {
    if (this.#native === null || !this.#running) return;
    this.#running = false;
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#native.removeListener("bleAdvertisement", this.#handleAdvertisement);
    this.#native.removeListener("bleError", this.#handleError);
    this.#peers.clear();
    const stopScan = this.#native.stopScanning();
    const stopAdvertise = this.#advertising
      ? this.#native.stopAdvertising()
      : Promise.resolve();
    this.#advertising = false;
    await Promise.all([stopScan, stopAdvertise]);
  }

  /** Snapshot of the current peer table. */
  getPeers(): BlePeer[] {
    return [...this.#peers.values()].map((peer) => ({ ...peer }));
  }

  #requireNative(): BleNativeModuleLike {
    if (this.#native === null) {
      throw new Error(
        "BLE discovery is not available on this platform (native module " +
          "ComapeoBleDiscovery not found). Check `isAvailable` before starting.",
      );
    }
    return this.#native;
  }

  async #startAdvertising(
    native: BleNativeModuleLike,
    advertisement: CoMapeoAdvertisement,
  ): Promise<void> {
    // Encode before flipping state so a RangeError leaves us consistent.
    const payload = bytesToBase64(encodeAdvertisement(advertisement));
    this.#advertising = true;
    await native.startAdvertising(payload);
  }

  #handleAdvertisement = (sighting: BleAdvertisementPayload): void => {
    let advertisement: CoMapeoAdvertisement | null;
    try {
      advertisement = decodeAdvertisement(base64ToBytes(sighting.payload));
    } catch {
      return; // Malformed base64 from a non-CoMapeo 0xFFFF advertiser.
    }
    // The native scan filter only matches the "CM" prefix; a payload
    // with the right magic but wrong version/length still lands here
    // and is dropped by the decoder.
    if (advertisement === null) return;

    const key =
      advertisement.address !== null && advertisement.port !== 0
        ? `${advertisement.address}:${advertisement.port}`
        : `ble:${sighting.address}`;
    const previous = this.#peers.get(key);
    const { clusterEnterRssi, clusterExitRssi, rssiSmoothing } = this.#options;
    const smoothedRssi =
      previous === undefined
        ? sighting.rssi
        : rssiSmoothing * sighting.rssi +
          (1 - rssiSmoothing) * previous.smoothedRssi;
    const inCluster = previous?.inCluster
      ? smoothedRssi >= clusterExitRssi
      : smoothedRssi >= clusterEnterRssi;
    const peer: BlePeer = {
      key,
      advertisement,
      rssi: sighting.rssi,
      smoothedRssi,
      inCluster,
      lastSeenAt: this.#now(),
      deviceAddress: sighting.address,
    };
    this.#peers.set(key, peer);
    this.emit("peer", { ...peer });
  };

  #handleError = (payload: BleErrorPayload): void => {
    if (payload.scope === "advertise") this.#advertising = false;
    this.emit("error", new BleDiscoveryError(payload));
  };

  #sweepStalePeers(): void {
    const cutoff = this.#now() - this.#options.peerTimeoutMs;
    for (const [key, peer] of this.#peers) {
      if (peer.lastSeenAt < cutoff) {
        this.#peers.delete(key);
        this.emit("peerLost", key, peer);
      }
    }
  }
}

const UNAVAILABLE_PERMISSION: BlePermissionResponse = {
  status: "denied",
  granted: false,
  canAskAgain: false,
  expires: "never",
};
