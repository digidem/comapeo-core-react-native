/**
 * Dependency-free SHA-256 / HMAC-SHA-256 plus the CoMapeo BLE hash
 * derivations built on them (daily-rotated project hash, sync-state
 * hash, SSID hash).
 *
 * Pure TS on purpose: Hermes ships no WebCrypto and the RN side must
 * not depend on the embedded Node runtime being up to compute an
 * advertisement (BLE discovery may run while the backend is still
 * booting). The inputs are tiny (≤ a few hundred bytes, hashed on
 * state changes, not per-packet), so performance is irrelevant here.
 * Verified against FIPS 180-4 / RFC 4231 vectors in
 * `src/__tests__/ble-hashes.test.js`.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of `data`, returned as a fresh 32-byte array. */
export function sha256(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  // Message + 0x80 + zero pad + 64-bit big-endian length, to a 64-byte multiple.
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Inputs here are far below 2^32 bits, so the high word of the
  // 64-bit length is always 0 — only write the low word.
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  // Indexed reads below use non-null assertions: `noUncheckedIndexedAccess`
  // can't see that every index is loop-bounded within the fixed-size arrays.
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!, false);
  return out;
}

/** HMAC-SHA-256 (RFC 2104) of `message` under `key`. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSized = new Uint8Array(64);
  blockSized.set(key.length > 64 ? sha256(key) : key);

  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = blockSized[i]! ^ 0x36;
    outer[i] = blockSized[i]! ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** UTF-8 encode without relying on TextEncoder (absent on older Hermes). */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Domain-separation prefix for every CoMapeo BLE hash derivation.
 * Versioned so a future format revision can't collide with v1 values.
 */
const DOMAIN_PREFIX = "comapeo-ble-v1:";

/**
 * The daily-rotated 16-bit project hash carried in the advertisement:
 * `HMAC(projectKey, "comapeo-ble-v1:project:" + UTC day)` truncated to
 * the first 2 bytes (big-endian). Rotates at UTC midnight, so a passive
 * observer cannot track a project across days — see the design doc's
 * privacy discussion (and its caveats about the *other* advertised
 * fields).
 *
 * `now` defaults to the current time; injectable for tests and so
 * callers can pre-compute tomorrow's value ahead of a midnight
 * rollover.
 */
export function deriveDailyProjectHash(
  projectKey: Uint8Array,
  now: Date = new Date(),
): number {
  const day =
    `${now.getUTCFullYear()}-` +
    `${String(now.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getUTCDate()).padStart(2, "0")}`;
  const mac = hmacSha256(
    projectKey,
    utf8Encode(`${DOMAIN_PREFIX}project:${day}`),
  );
  return (mac[0]! << 8) | mac[1]!;
}

/**
 * 32-bit sync-state hash: first 4 bytes (big-endian) of
 * `SHA-256("comapeo-ble-v1:state:" || stateBytes)`. Two devices with
 * the same value are (with ~2^-32 error) in the same sync state; a
 * difference means "we should connect and reconcile" — it does NOT say
 * who is ahead. The caller supplies a canonical byte serialisation of
 * whatever it considers "sync state" (e.g. sorted per-core lengths from
 * `$sync`'s state).
 */
export function deriveStateHash(stateBytes: Uint8Array): number {
  const prefix = utf8Encode(`${DOMAIN_PREFIX}state:`);
  const input = new Uint8Array(prefix.length + stateBytes.length);
  input.set(prefix);
  input.set(stateBytes, prefix.length);
  const digest = sha256(input);
  return new DataView(digest.buffer).getUint32(0, false);
}

/**
 * 16-bit SSID hash (Phase 2 network-match detection): first 2 bytes of
 * `SHA-256("comapeo-ble-v1:ssid:" || utf8(ssid))`. Only used to detect
 * "different network" — 2 bytes is plenty for the ~50 visible networks
 * of a dense environment.
 */
export function deriveSsidHash(ssid: string): number {
  const digest = sha256(utf8Encode(`${DOMAIN_PREFIX}ssid:${ssid}`));
  return (digest[0]! << 8) | digest[1]!;
}
