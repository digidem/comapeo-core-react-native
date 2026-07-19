import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADVERTISEMENT_PAYLOAD_LENGTH,
  decodeAdvertisement,
} from "./ble-codec.js";

/**
 * The backend mirror of the RN codec. `KNOWN_PAYLOAD_HEX` is the shared
 * cross-implementation vector — the same bytes are asserted against the
 * normative TS codec in `src/__tests__/ble-wire-format.test.js`, so a
 * drift between the two decoders fails one suite or the other.
 */

const KNOWN_PAYLOAD_HEX = "434d0187cf0001e240deadbeefcc02c0a83101a8ca";
const KNOWN_FIELDS = {
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

test("decodes the shared cross-implementation vector", () => {
  const payload = Buffer.from(KNOWN_PAYLOAD_HEX, "hex");
  assert.equal(payload.length, ADVERTISEMENT_PAYLOAD_LENGTH);
  assert.deepEqual(decodeAdvertisement(payload), KNOWN_FIELDS);
});

test("decodes the empty/unknown edges", () => {
  const payload = Buffer.alloc(ADVERTISEMENT_PAYLOAD_LENGTH);
  payload.set([0x43, 0x4d, 0x01], 0);
  payload[13] = 0x7f; // battery unknown
  assert.deepEqual(decodeAdvertisement(payload), {
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
  });
});

test("rejects foreign payloads", () => {
  const good = Buffer.from(KNOWN_PAYLOAD_HEX, "hex");

  const wrongMagic = Buffer.from(good);
  wrongMagic[0] = 0x58;
  assert.equal(decodeAdvertisement(wrongMagic), null);

  const wrongVersion = Buffer.from(good);
  wrongVersion[2] = 0x02;
  assert.equal(decodeAdvertisement(wrongVersion), null);

  assert.equal(decodeAdvertisement(good.subarray(0, 20)), null);
  assert.equal(decodeAdvertisement(Buffer.concat([good, Buffer.alloc(1)])), null);
  assert.equal(decodeAdvertisement(Buffer.alloc(0)), null);
});

test("decodes at a nonzero buffer offset", () => {
  const outer = Buffer.alloc(64);
  Buffer.from(KNOWN_PAYLOAD_HEX, "hex").copy(outer, 7);
  const view = outer.subarray(7, 7 + ADVERTISEMENT_PAYLOAD_LENGTH);
  assert.deepEqual(decodeAdvertisement(view), KNOWN_FIELDS);
});
