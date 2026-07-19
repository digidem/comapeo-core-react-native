/**
 * The pure-TS SHA-256 / HMAC-SHA-256 in `src/ble/hashes.ts`, checked
 * against published vectors (FIPS 180-4 examples, RFC 4231 test
 * cases), plus the CoMapeo derivations built on them. Plain JS so
 * expo-module-scripts' babel-jest picks it up.
 */

const {
  sha256,
  hmacSha256,
  utf8Encode,
  deriveDailyProjectHash,
  deriveStateHash,
  deriveSsidHash,
} = require("../ble/hashes");

const hex = (bytes) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (s) =>
  Uint8Array.from(s.match(/../g).map((byte) => parseInt(byte, 16)));

describe("sha256", () => {
  // FIPS 180-4 / de-facto standard vectors.
  it("hashes the empty string", () => {
    expect(hex(sha256(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc"', () => {
    expect(hex(sha256(utf8Encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the two-block FIPS vector", () => {
    expect(
      hex(
        sha256(
          utf8Encode(
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
          ),
        ),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("hashes inputs spanning the length-padding boundary (55/56/64 bytes)", () => {
    // Cross-checked with node:crypto.
    const known = {
      55: "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
      56: "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
      64: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    };
    for (const [len, digest] of Object.entries(known)) {
      expect(hex(sha256(utf8Encode("a".repeat(Number(len)))))).toBe(digest);
    }
  });
});

describe("hmacSha256", () => {
  it("passes RFC 4231 test case 1", () => {
    const key = fromHex("0b".repeat(20));
    expect(hex(hmacSha256(key, utf8Encode("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("passes RFC 4231 test case 2 (short key)", () => {
    expect(
      hex(
        hmacSha256(
          utf8Encode("Jefe"),
          utf8Encode("what do ya want for nothing?"),
        ),
      ),
    ).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("passes RFC 4231 test case 6 (key longer than one block)", () => {
    const key = fromHex("aa".repeat(131));
    expect(
      hex(
        hmacSha256(
          key,
          utf8Encode("Test Using Larger Than Block-Size Key - Hash Key First"),
        ),
      ),
    ).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });
});

describe("utf8Encode", () => {
  it("matches TextEncoder across BMP and astral characters", () => {
    for (const text of ["", "abc", "café", "καλημέρα", "🗺️ mapeo", "𐐷"]) {
      expect(Array.from(utf8Encode(text))).toEqual(
        Array.from(new TextEncoder().encode(text)),
      );
    }
  });
});

describe("deriveDailyProjectHash", () => {
  const key = fromHex("00112233445566778899aabbccddeeff");

  it("is deterministic within a UTC day and 16-bit", () => {
    const noon = new Date("2026-07-19T12:00:00Z");
    const evening = new Date("2026-07-19T23:59:59Z");
    const value = deriveDailyProjectHash(key, noon);
    expect(value).toBe(deriveDailyProjectHash(key, evening));
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(0x10000);
  });

  it("rotates at UTC midnight", () => {
    const before = deriveDailyProjectHash(key, new Date("2026-07-19T23:59:59Z"));
    const after = deriveDailyProjectHash(key, new Date("2026-07-20T00:00:00Z"));
    // 1-in-65536 chance of accidental equality for a *specific* pair —
    // this fixed pair was checked to differ, so a failure means the
    // rotation logic broke, not bad luck.
    expect(before).not.toBe(after);
  });

  it("differs between projects", () => {
    const otherKey = fromHex("ff".repeat(16));
    const when = new Date("2026-07-19T12:00:00Z");
    expect(deriveDailyProjectHash(key, when)).not.toBe(
      deriveDailyProjectHash(otherKey, when),
    );
  });
});

describe("deriveStateHash / deriveSsidHash", () => {
  it("produces stable 32-bit state hashes that track content", () => {
    const a = deriveStateHash(utf8Encode("core1:10,core2:20"));
    expect(a).toBe(deriveStateHash(utf8Encode("core1:10,core2:20")));
    expect(a).not.toBe(deriveStateHash(utf8Encode("core1:10,core2:21")));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 32);
  });

  it("produces 16-bit ssid hashes", () => {
    const value = deriveSsidHash("AndroidShare_1234");
    expect(value).toBe(deriveSsidHash("AndroidShare_1234"));
    expect(value).not.toBe(deriveSsidHash("AndroidShare_1235"));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(0x10000);
  });
});
