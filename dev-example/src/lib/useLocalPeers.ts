import { useClientApi } from '@comapeo/core-react';
import * as Network from 'expo-network';
import { useEffect, useState, useSyncExternalStore } from 'react';

// Types intentionally loose — the @comapeo/core types for `local-peers` event
// aren't part of the MapeoClientApi surface, so we read `on/off` via any-cast.
export type LocalPeerInfo = {
  deviceId: string;
  name?: string;
  deviceType?: string;
  status: 'connecting' | 'connected' | 'disconnected';
};

type LocalPeersState = {
  peers: LocalPeerInfo[];
  started: { port: number } | null;
  error: Error | null;
};

const initial: LocalPeersState = { peers: [], started: null, error: null };

// Module-level store so a single subscription owns the connection. Mounted by
// `useStartLocalPeerDiscoveryServer()` in the root layout; any component can
// read peers via `useLocalPeers()` without double-subscribing.
let state: LocalPeersState = initial;
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
function set(next: Partial<LocalPeersState>) {
  state = { ...state, ...next };
  notify();
}

export function useLocalPeers() {
  const api = useClientApi();
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
  return {
    peers: state.peers,
    listening: state.started,
    error: state.error,
    listPeers: () => api.listLocalPeers(),
  };
}

export function useLocalIpAddress(): string | null {
  const [ip, setIp] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Network.getIpAddressAsync().then(
      (addr) => {
        if (!cancelled) setIp(addr);
      },
      () => {
        if (!cancelled) setIp(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return ip;
}

// Mount exactly once (in the root layout). Starts the discovery server and
// subscribes to the 'local-peers' event. No-op on re-render.
let didStart = false;

export function useStartLocalPeerDiscoveryServer() {
  const api = useClientApi();
  useEffect(() => {
    if (didStart) return;
    didStart = true;

    const anyApi = api as unknown as {
      startLocalPeerDiscoveryServer: () => Promise<{ port: number; name: string }>;
      stopLocalPeerDiscoveryServer?: (opts?: object) => Promise<void>;
      on: (event: 'local-peers', listener: (peers: LocalPeerInfo[]) => void) => void;
      off: (event: 'local-peers', listener: (peers: LocalPeerInfo[]) => void) => void;
    };

    const handlePeers = (peers: LocalPeerInfo[]) => set({ peers });

    anyApi.on('local-peers', handlePeers);

    anyApi.startLocalPeerDiscoveryServer().then(
      (started) => set({ started: { port: started.port }, error: null }),
      (error: Error) => set({ error }),
    );

    return () => {
      anyApi.off('local-peers', handlePeers);
      // Intentionally do NOT stop the discovery server on unmount — we want
      // it to run for the app's lifetime.
    };
  }, [api]);
}

// Fire-and-forget connect. Returns a promise that resolves to the connected
// peer's PublicPeerInfo once it reaches status='connected' (or rejects on
// timeout / disconnected).
export function waitForPeerConnection(
  api: ReturnType<typeof useClientApi>,
  idPrefix: string,
  timeoutMs = 10_000,
): Promise<LocalPeerInfo> {
  return new Promise((resolve, reject) => {
    const anyApi = api as unknown as {
      on: (event: 'local-peers', listener: (peers: LocalPeerInfo[]) => void) => void;
      off: (event: 'local-peers', listener: (peers: LocalPeerInfo[]) => void) => void;
      listLocalPeers: () => Promise<LocalPeerInfo[]>;
    };

    const done = (result: LocalPeerInfo | null, error?: Error) => {
      clearTimeout(timer);
      anyApi.off('local-peers', handlePeers);
      if (result) resolve(result);
      else reject(error ?? new Error('Timed out waiting for peer connection'));
    };

    const check = (peers: LocalPeerInfo[]) => {
      const match = peers.find(
        (p) => p.deviceId.startsWith(idPrefix) && p.status === 'connected',
      );
      if (match) done(match);
    };

    const handlePeers = (peers: LocalPeerInfo[]) => check(peers);
    anyApi.on('local-peers', handlePeers);

    // Also check the current snapshot in case the peer is already connected.
    anyApi.listLocalPeers().then(check).catch(() => {});

    const timer = setTimeout(() => done(null), timeoutMs);
  });
}
