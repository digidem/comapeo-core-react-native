/**
 * `BleDiscovery` (src/ble/BleDiscovery.ts) against a fake native
 * module: lifecycle, event decoding, peer-table maintenance (RSSI
 * smoothing, cluster hysteresis, staleness expiry), and the
 * null-module degradation path.
 */

const { BleDiscovery, BleDiscoveryError } = require("../ble/BleDiscovery");
const { encodeAdvertisement } = require("../ble/wire-format");
const { bytesToBase64 } = require("../ble/base64");

const baseAd = {
  projectHash: 0x1234,
  totalBlocks: 10,
  stateHash: 0xabcdef01,
  batteryPercent: 50,
  charging: false,
  isHotspotLeader: false,
  hasWifi: true,
  inviteMode: false,
  address: "192.168.1.20",
  port: 9000,
};

function makeFakeNative() {
  const listeners = { bleAdvertisement: new Set(), bleError: new Set() };
  return {
    calls: [],
    listeners,
    getCapabilities: () => ({ available: true, enabled: true }),
    getPermissionsAsync: jest.fn(async () => grantedPermission()),
    requestPermissionsAsync: jest.fn(async () => grantedPermission()),
    startDiscovery(payload) {
      this.calls.push(["startDiscovery", payload]);
      return Promise.resolve();
    },
    updateAdvertisement(payload) {
      this.calls.push(["updateAdvertisement", payload]);
      return Promise.resolve();
    },
    stopDiscovery() {
      this.calls.push(["stopDiscovery"]);
      return Promise.resolve();
    },
    addListener(name, fn) {
      listeners[name].add(fn);
    },
    removeListener(name, fn) {
      listeners[name].delete(fn);
    },
    emitSighting(ad, { rssi = -50, address = "AA:BB:CC:DD:EE:FF" } = {}) {
      const payload = bytesToBase64(encodeAdvertisement(ad));
      for (const fn of listeners.bleAdvertisement) {
        fn({ payload, rssi, address });
      }
    },
    emitError(payload) {
      for (const fn of listeners.bleError) fn(payload);
    },
  };
}

const grantedPermission = () => ({
  status: "granted",
  granted: true,
  canAskAgain: true,
  expires: "never",
});

describe("BleDiscovery", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("starts discovery with the encoded advertisement payload", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    await discovery.start({ advertisement: baseAd });
    expect(native.calls).toEqual([
      ["startDiscovery", bytesToBase64(encodeAdvertisement(baseAd))],
    ]);
    expect(discovery.isRunning).toBe(true);
  });

  it("starts scan-only when no advertisement is set", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    await discovery.start();
    expect(native.calls).toEqual([["startDiscovery", null]]);
  });

  it("emits decoded peers and keys them by advertised ip:port", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    const peers = [];
    discovery.addListener("peer", (peer) => peers.push(peer));
    await discovery.start();

    native.emitSighting(baseAd, { rssi: -40 });
    expect(peers).toHaveLength(1);
    expect(peers[0].key).toBe("192.168.1.20:9000");
    expect(peers[0].advertisement).toEqual(baseAd);
    expect(peers[0].rssi).toBe(-40);

    // Same peer again — updated in place, not duplicated.
    native.emitSighting({ ...baseAd, totalBlocks: 11 });
    expect(peers).toHaveLength(2);
    expect(discovery.getPeers()).toHaveLength(1);
    expect(discovery.getPeers()[0].advertisement.totalBlocks).toBe(11);
  });

  it("falls back to the BLE MAC as key when no ip:port is advertised", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    await discovery.start();
    native.emitSighting(
      { ...baseAd, address: null, port: 0 },
      { address: "11:22:33:44:55:66" },
    );
    expect(discovery.getPeers()[0].key).toBe("ble:11:22:33:44:55:66");
  });

  it("ignores foreign payloads without emitting", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    const peers = [];
    discovery.addListener("peer", (peer) => peers.push(peer));
    await discovery.start();
    for (const fn of native.listeners.bleAdvertisement) {
      fn({ payload: "AAAA", rssi: -40, address: "X" }); // wrong magic
      fn({ payload: "!!not-base64!!", rssi: -40, address: "X" });
    }
    expect(peers).toHaveLength(0);
  });

  it("smooths RSSI and applies cluster hysteresis", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native, {
      clusterEnterRssi: -60,
      clusterExitRssi: -66,
      rssiSmoothing: 0.5,
    });
    await discovery.start();

    native.emitSighting(baseAd, { rssi: -70 });
    expect(discovery.getPeers()[0].inCluster).toBe(false);

    // Smoothed: -70 → -60 → -52.5: crosses the enter threshold.
    native.emitSighting(baseAd, { rssi: -50 });
    expect(discovery.getPeers()[0].smoothedRssi).toBe(-60);
    expect(discovery.getPeers()[0].inCluster).toBe(true);

    // Drifts down to -62.5: below enter (-60) but above exit (-66),
    // so hysteresis keeps it in the cluster…
    native.emitSighting(baseAd, { rssi: -65 });
    expect(discovery.getPeers()[0].inCluster).toBe(true);

    // …until it falls past the exit threshold.
    native.emitSighting(baseAd, { rssi: -80 });
    native.emitSighting(baseAd, { rssi: -80 });
    expect(discovery.getPeers()[0].inCluster).toBe(false);
  });

  it("expires peers not seen within peerTimeoutMs", async () => {
    let clock = 0;
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native, {
      peerTimeoutMs: 10_000,
      now: () => clock,
    });
    const lost = [];
    discovery.addListener("peerLost", (key) => lost.push(key));
    await discovery.start();

    native.emitSighting(baseAd);
    clock = 11_000;
    jest.advanceTimersByTime(5_000); // sweep interval = timeout/2
    expect(lost).toEqual(["192.168.1.20:9000"]);
    expect(discovery.getPeers()).toHaveLength(0);
  });

  it("replaces the advertisement live and can clear it", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    await discovery.start({ advertisement: baseAd });
    await discovery.setAdvertisement({ ...baseAd, totalBlocks: 99 });
    await discovery.setAdvertisement(null);
    expect(native.calls.map(([name]) => name)).toEqual([
      "startDiscovery",
      "updateAdvertisement",
      "updateAdvertisement",
    ]);
    expect(native.calls[2][1]).toBeNull();
  });

  it("surfaces native errors as BleDiscoveryError events", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    const errors = [];
    discovery.addListener("error", (error) => errors.push(error));
    await discovery.start({ advertisement: baseAd });
    native.emitError({
      scope: "advertise",
      code: "ERR_BLE_ADVERTISE",
      message: "too many advertisers",
    });
    expect(errors[0]).toBeInstanceOf(BleDiscoveryError);
    expect(errors[0].scope).toBe("advertise");
    expect(errors[0].code).toBe("ERR_BLE_ADVERTISE");
  });

  it("stop() tears down listeners, timers and the peer table", async () => {
    const native = makeFakeNative();
    const discovery = new BleDiscovery(native);
    await discovery.start({ advertisement: baseAd });
    native.emitSighting(baseAd);
    await discovery.stop();
    expect(discovery.isRunning).toBe(false);
    expect(discovery.getPeers()).toHaveLength(0);
    expect(native.listeners.bleAdvertisement.size).toBe(0);
    expect(native.calls.map(([name]) => name)).toContain("stopDiscovery");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cleans up when startDiscovery rejects", async () => {
    const native = makeFakeNative();
    native.startDiscovery = () => Promise.reject(new Error("no native context"));
    const discovery = new BleDiscovery(native);
    await expect(discovery.start()).rejects.toThrow("no native context");
    expect(discovery.isRunning).toBe(false);
    expect(native.listeners.bleAdvertisement.size).toBe(0);
  });

  it("degrades gracefully without a native module", async () => {
    const discovery = new BleDiscovery(null);
    expect(discovery.isAvailable).toBe(false);
    expect(discovery.getCapabilities()).toEqual({
      available: false,
      enabled: false,
    });
    await expect(discovery.getPermissionsAsync()).resolves.toMatchObject({
      granted: false,
    });
    await expect(discovery.start()).rejects.toThrow(/not available/);
    await discovery.stop(); // no-op, no throw
  });
});
