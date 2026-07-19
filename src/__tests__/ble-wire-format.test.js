/**
 * The v1 advertisement codec (`src/ble/wire-format.ts`) and the base64
 * hop codec (`src/ble/base64.ts`).
 */

const {
  ADVERTISEMENT_PAYLOAD_LENGTH,
  MAGIC,
  WIRE_FORMAT_VERSION,
  encodeAdvertisement,
  decodeAdvertisement,
} = require("../ble/wire-format");
const { bytesToBase64, base64ToBytes } = require("../ble/base64");

const fullAd = {
  projectHash: 0x87cf,
  totalBlocks: 123456,
  stateHash: 0xdeadbeef,
  batteryPercent: 76,
  charging: true,
  isHotspotLeader: false,
  hasWifi: true,
  inviteMode: false,
  address: "192.168.49.1",
  port: 43210,
};

describe("advertisement codec", () => {
  it("round-trips a fully populated advertisement", () => {
    const payload = encodeAdvertisement(fullAd);
    expect(payload).toHaveLength(ADVERTISEMENT_PAYLOAD_LENGTH);
    expect(decodeAdvertisement(payload)).toEqual(fullAd);
  });

  it("round-trips the empty/unknown edges", () => {
    const ad = {
      projectHash: 0,
      totalBlocks: 0,
      stateHash: 0,
      batteryPercent: null,
      charging: false,
      isHotspotLeader: false,
      hasWifi: false,
      inviteMode: false,
      address: null,
      port: 0,
    };
    expect(decodeAdvertisement(encodeAdvertisement(ad))).toEqual(ad);
  });

  it("round-trips the maxima", () => {
    const ad = {
      ...fullAd,
      projectHash: 0xffff,
      totalBlocks: 0xffffffff,
      stateHash: 0xffffffff,
      batteryPercent: 100,
      isHotspotLeader: true,
      inviteMode: true,
      address: "255.255.255.254",
      port: 0xffff,
    };
    expect(decodeAdvertisement(encodeAdvertisement(ad))).toEqual(ad);
  });

  it("has the documented byte layout", () => {
    const payload = encodeAdvertisement(fullAd);
    expect([payload[0], payload[1]]).toEqual([...MAGIC]); // "CM"
    expect(payload[2]).toBe(WIRE_FORMAT_VERSION);
    expect([payload[3], payload[4]]).toEqual([0x87, 0xcf]); // BE projectHash
    expect([payload[9], payload[10], payload[11], payload[12]]).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(payload[13]).toBe(0x80 | 76); // charging | battery
    expect(payload[14]).toBe(0x02); // hasWifi only
    expect([payload[15], payload[16], payload[17], payload[18]]).toEqual([
      192, 168, 49, 1,
    ]);
    expect((payload[19] << 8) | payload[20]).toBe(43210);
  });

  it("saturates totalBlocks above 2^32 − 1 instead of throwing", () => {
    const payload = encodeAdvertisement({
      ...fullAd,
      totalBlocks: 2 ** 40,
    });
    expect(decodeAdvertisement(payload).totalBlocks).toBe(0xffffffff);
  });

  it("rejects out-of-range fields", () => {
    expect(() =>
      encodeAdvertisement({ ...fullAd, projectHash: 0x10000 }),
    ).toThrow(RangeError);
    expect(() => encodeAdvertisement({ ...fullAd, port: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      encodeAdvertisement({ ...fullAd, batteryPercent: 101 }),
    ).toThrow(RangeError);
    expect(() =>
      encodeAdvertisement({ ...fullAd, stateHash: 1.5 }),
    ).toThrow(RangeError);
    for (const address of ["10.0.0", "1.2.3.4.5", "256.0.0.1", "a.b.c.d"]) {
      expect(() => encodeAdvertisement({ ...fullAd, address })).toThrow(
        RangeError,
      );
    }
  });

  it("returns null for foreign 0xFFFF payloads", () => {
    const payload = encodeAdvertisement(fullAd);
    const wrongMagic = Uint8Array.from(payload);
    wrongMagic[0] = 0x58;
    const wrongVersion = Uint8Array.from(payload);
    wrongVersion[2] = 0x02;
    expect(decodeAdvertisement(wrongMagic)).toBeNull();
    expect(decodeAdvertisement(wrongVersion)).toBeNull();
    expect(decodeAdvertisement(payload.slice(0, 20))).toBeNull();
    expect(
      decodeAdvertisement(Uint8Array.from([...payload, 0x00])),
    ).toBeNull();
    expect(decodeAdvertisement(new Uint8Array(0))).toBeNull();
  });

  it("decodes payloads at a nonzero offset into a larger buffer", () => {
    const payload = encodeAdvertisement(fullAd);
    const buffer = new Uint8Array(64);
    buffer.set(payload, 7);
    expect(
      decodeAdvertisement(buffer.subarray(7, 7 + payload.length)),
    ).toEqual(fullAd);
  });
});

describe("base64", () => {
  it("round-trips arbitrary bytes at every padding length", () => {
    for (let len = 0; len <= 24; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 5) & 0xff);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it("matches Buffer's encoding", () => {
    const bytes = Uint8Array.from(encodeAdvertisement(fullAd));
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64ToBytes(Buffer.from(bytes).toString("base64"))).toEqual(
      bytes,
    );
  });

  it("accepts unpadded input and rejects garbage", () => {
    expect(base64ToBytes("QUJD")).toEqual(Uint8Array.from([65, 66, 67]));
    expect(base64ToBytes("QUJ")).toEqual(Uint8Array.from([65, 66]));
    expect(() => base64ToBytes("Q!JD")).toThrow(/Invalid base64/);
  });
});
