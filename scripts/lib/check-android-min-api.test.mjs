import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { auditAndroidMinApi, checkSoMinApi } from "./check-android-min-api.ts";

const DT_NEEDED = 1n;
const DT_RELR = 36n;
const DT_ANDROID_RELR = 0x6fffe000n;

/**
 * Build a minimal little-endian ELF shared object with one PT_DYNAMIC and,
 * optionally, one PT_NOTE carrying the NDK's Android ident note.
 *
 * @param {{ bits: 32 | 64, apiLevel?: number, dynTags: bigint[] }} opts
 */
function makeElf({ bits, apiLevel, dynTags }) {
  const is64 = bits === 64;
  const ehsize = is64 ? 64 : 52;
  const phentsize = is64 ? 56 : 32;
  const word = is64 ? 8 : 4;

  const dyn = Buffer.alloc((dynTags.length + 1) * word * 2);
  dynTags.forEach((tag, i) => {
    if (is64) dyn.writeBigUInt64LE(tag, i * 16);
    else dyn.writeUInt32LE(Number(tag), i * 8);
  });

  let note = Buffer.alloc(0);
  if (apiLevel !== undefined) {
    // namesz, descsz, type, "Android\0", desc (API level + NDK version padding)
    note = Buffer.alloc(12 + 8 + 0x84);
    note.writeUInt32LE(8, 0);
    note.writeUInt32LE(0x84, 4);
    note.writeUInt32LE(1, 8);
    note.write("Android\0", 12, "latin1");
    note.writeUInt32LE(apiLevel, 20);
  }

  const phdrs = [{ type: 2, data: dyn }];
  if (note.length > 0) phdrs.push({ type: 4, data: note });

  const phoff = ehsize;
  let dataOff = phoff + phentsize * phdrs.length;
  const header = Buffer.alloc(ehsize);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = is64 ? 2 : 1;
  header[5] = 1;
  if (is64) {
    header.writeBigUInt64LE(BigInt(phoff), 0x20);
    header.writeUInt16LE(phentsize, 0x36);
    header.writeUInt16LE(phdrs.length, 0x38);
  } else {
    header.writeUInt32LE(phoff, 0x1c);
    header.writeUInt16LE(phentsize, 0x2a);
    header.writeUInt16LE(phdrs.length, 0x2c);
  }

  const phTable = Buffer.alloc(phentsize * phdrs.length);
  phdrs.forEach(({ type, data }, i) => {
    const base = i * phentsize;
    phTable.writeUInt32LE(type, base);
    if (is64) {
      phTable.writeBigUInt64LE(BigInt(dataOff), base + 0x08);
      phTable.writeBigUInt64LE(BigInt(data.length), base + 0x20);
    } else {
      phTable.writeUInt32LE(dataOff, base + 0x04);
      phTable.writeUInt32LE(data.length, base + 0x10);
    }
    dataOff += data.length;
  });

  return Buffer.concat([header, phTable, ...phdrs.map((p) => p.data)]);
}

describe("checkSoMinApi", () => {
  /** @type {string} */
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "min-api-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const bits of /** @type {const} */ ([32, 64])) {
    it(`reads the API level and RELR tags from an ELF${bits}`, async () => {
      const file = join(dir, `relr${bits}.so`);
      await writeFile(
        file,
        makeElf({ bits, apiLevel: 29, dynTags: [DT_NEEDED, DT_ANDROID_RELR] })
      );
      const report = await checkSoMinApi(file);
      assert.equal(report.bits, bits);
      assert.equal(report.apiLevel, 29);
      assert.deepEqual(report.relrTags, ["DT_ANDROID_RELR"]);
    });

    it(`reports a clean ELF${bits} as clean`, async () => {
      const file = join(dir, `clean${bits}.so`);
      await writeFile(
        file,
        makeElf({ bits, apiLevel: 24, dynTags: [DT_NEEDED] })
      );
      const report = await checkSoMinApi(file);
      assert.equal(report.apiLevel, 24);
      assert.deepEqual(report.relrTags, []);
    });
  }

  it("leaves apiLevel undefined when there is no Android note", async () => {
    const file = join(dir, "nonote.so");
    await writeFile(file, makeElf({ bits: 64, dynTags: [DT_RELR] }));
    const report = await checkSoMinApi(file);
    assert.equal(report.apiLevel, undefined);
    assert.deepEqual(report.relrTags, ["DT_RELR"]);
  });

  it("rejects non-ELF input", async () => {
    const file = join(dir, "bogus.so");
    await writeFile(file, Buffer.alloc(64));
    await assert.rejects(checkSoMinApi(file), /not an ELF file/);
  });
});

describe("auditAndroidMinApi", () => {
  /** @type {string} */
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "min-api-audit-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when every library targets minSdk or lower", async () => {
    const root = join(dir, "ok");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "a.so"),
      makeElf({ bits: 32, apiLevel: 24, dynTags: [] })
    );
    await writeFile(
      join(root, "b.so"),
      makeElf({ bits: 64, apiLevel: 21, dynTags: [] })
    );
    await auditAndroidMinApi({ roots: [root], cwd: dir, minSdk: 24 });
  });

  it("fails on a library built for a newer API", async () => {
    const root = join(dir, "newapi");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "a.so"),
      makeElf({ bits: 64, apiLevel: 29, dynTags: [] })
    );
    await assert.rejects(
      auditAndroidMinApi({ roots: [root], cwd: dir, minSdk: 24 }),
      /newapi\/a\.so \(ELF64\): built for API 29/
    );
  });

  it("fails on RELR even when the target API is allowed", async () => {
    const root = join(dir, "relr");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "a.so"),
      makeElf({ bits: 32, apiLevel: 24, dynTags: [DT_RELR] })
    );
    await assert.rejects(
      auditAndroidMinApi({ roots: [root], cwd: dir, minSdk: 24 }),
      /relr\/a\.so \(ELF32\): DT_RELR/
    );
  });

  it("fails when no libraries are found", async () => {
    const root = join(dir, "empty");
    await mkdir(root, { recursive: true });
    await assert.rejects(
      auditAndroidMinApi({ roots: [root], cwd: dir }),
      /no \.so files found/
    );
  });
});
