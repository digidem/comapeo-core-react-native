/**
 * Minimal base64 for the JS ⇄ native payload hop. Hermes has no
 * `Buffer` and `atob`/`btoa` availability varies by RN version, so the
 * codec is self-contained. Payloads are ~21 bytes — performance is a
 * non-issue.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REVERSE: Record<string, number> = {};
[...ALPHABET].forEach((char, i) => {
  REVERSE[char] = i;
});

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/** Decode standard (padded or unpadded) base64. Throws on characters
 * outside the standard alphabet. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = REVERSE[char];
    if (value === undefined) {
      throw new Error(`Invalid base64 character: ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}
