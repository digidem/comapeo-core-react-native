// QR payload encoding for the CoMapeo local-peer invite flow.
//
// A device that wants to receive an invite starts `startLocalPeerDiscoveryServer()`,
// fetches its local IP, takes the first 8 bytes (16 hex chars) of its deviceId,
// and encodes a URL of the form:
//
//   comapeo://join?ip=192.168.4.132&port=49172&id=a3f19c8d4b72e501
//
// A device that wants to send an invite scans that QR code, parses it with
// `decodePairingUrl`, and calls `connectLocalPeer({ address, port, name: id })`.

export type PairingPayload = {
  ip: string;
  port: number;
  idPrefix: string;
};

export const DEVICE_ID_PREFIX_BYTES = 8;
export const DEVICE_ID_PREFIX_HEX_LEN = DEVICE_ID_PREFIX_BYTES * 2;
const SCHEME = 'comapeo';
const HOST = 'join';

export function encodePairingUrl({ ip, port, idPrefix }: PairingPayload): string {
  const params = new URLSearchParams({ ip, port: String(port), id: idPrefix });
  return `${SCHEME}://${HOST}?${params.toString()}`;
}

export function decodePairingUrl(input: string): PairingPayload | null {
  try {
    const url = new URL(input);
    if (url.protocol !== `${SCHEME}:`) return null;
    const ip = url.searchParams.get('ip');
    const port = url.searchParams.get('port');
    const id = url.searchParams.get('id');
    if (!ip || !port || !id) return null;
    if (id.length !== DEVICE_ID_PREFIX_HEX_LEN) return null;
    const portNum = Number(port);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return null;
    return { ip, port: portNum, idPrefix: id };
  } catch {
    return null;
  }
}

export function deviceIdPrefix(fullDeviceId: string): string {
  return fullDeviceId.slice(0, DEVICE_ID_PREFIX_HEX_LEN);
}
