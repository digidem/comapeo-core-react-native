import { glob, open } from "node:fs/promises";
import { join, relative } from "node:path";

// Keep in sync with the minSdkVersion default in android/build.gradle.
export const MIN_SDK = 24;

// Bionic before API 28 skips dynamic tags it doesn't know, so a .so with
// packed RELR relocations loads with those pointers unrelocated and crashes
// on first use (COMAPEO-2KX / COMAPEO-2QK: sodium-native built for API 29).
// The NDK turns RELR on by itself when targeting API >= 28, so checking the
// target API in the Android note catches the cause; the dynamic-tag check
// catches RELR enabled explicitly or by a toolchain that writes no note.
const RELR_TAGS = new Map<bigint, string>([
  [36n, "DT_RELR"],
  [0x6fffe000n, "DT_ANDROID_RELR"],
]);

const PT_DYNAMIC = 2;
const PT_NOTE = 4;
const NT_ANDROID_TYPE_IDENT = 1;
const ELF_HEADER_BYTES = 64;

export type MinApiReport = {
  file: string;
  bits: 32 | 64;
  apiLevel: number | undefined;
  relrTags: string[];
};

type Segment = { type: number; offset: number; filesz: number };

export async function checkSoMinApi(filePath: string): Promise<MinApiReport> {
  const fh = await open(filePath, "r");
  try {
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead < length) {
        throw new Error(
          `${filePath}: truncated read at 0x${offset.toString(16)}`
        );
      }
      return buf;
    };

    const header = await read(0, ELF_HEADER_BYTES);
    if (header.readUInt32BE(0) !== 0x7f454c46) {
      throw new Error(`${filePath}: not an ELF file`);
    }
    if (header[5] !== 1) {
      throw new Error(`${filePath}: big-endian ELF not supported`);
    }
    const eiClass = header[4];
    if (eiClass !== 1 && eiClass !== 2) {
      throw new Error(`${filePath}: invalid EI_CLASS=${eiClass}`);
    }
    const is64 = eiClass === 2;

    const phoff = Number(
      is64 ? header.readBigUInt64LE(0x20) : header.readUInt32LE(0x1c)
    );
    const phentsize = header.readUInt16LE(is64 ? 0x36 : 0x2a);
    const phnum = header.readUInt16LE(is64 ? 0x38 : 0x2c);
    const phTable = await read(phoff, phentsize * phnum);

    const segments: Segment[] = [];
    for (let i = 0; i < phnum; i++) {
      const base = i * phentsize;
      const type = phTable.readUInt32LE(base);
      if (type !== PT_DYNAMIC && type !== PT_NOTE) continue;
      segments.push({
        type,
        offset: Number(
          is64
            ? phTable.readBigUInt64LE(base + 0x08)
            : phTable.readUInt32LE(base + 0x04)
        ),
        filesz: Number(
          is64
            ? phTable.readBigUInt64LE(base + 0x20)
            : phTable.readUInt32LE(base + 0x10)
        ),
      });
    }

    let apiLevel: number | undefined;
    const relrTags: string[] = [];
    for (const seg of segments) {
      const data = await read(seg.offset, seg.filesz);
      if (seg.type === PT_DYNAMIC) {
        relrTags.push(...findRelrTags(data, is64));
      } else {
        apiLevel ??= findAndroidApiLevel(data);
      }
    }

    return { file: filePath, bits: is64 ? 64 : 32, apiLevel, relrTags };
  } finally {
    await fh.close();
  }
}

function findRelrTags(dynamic: Buffer, is64: boolean): string[] {
  const entSize = is64 ? 16 : 8;
  const found: string[] = [];
  for (let off = 0; off + entSize <= dynamic.length; off += entSize) {
    const tag = is64
      ? dynamic.readBigUInt64LE(off)
      : BigInt(dynamic.readUInt32LE(off));
    if (tag === 0n) break;
    const name = RELR_TAGS.get(tag);
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

function findAndroidApiLevel(notes: Buffer): number | undefined {
  const align4 = (n: number) => (n + 3) & ~3;
  let off = 0;
  while (off + 12 <= notes.length) {
    const namesz = notes.readUInt32LE(off);
    const descsz = notes.readUInt32LE(off + 4);
    const type = notes.readUInt32LE(off + 8);
    const nameStart = off + 12;
    const descStart = nameStart + align4(namesz);
    const name = notes.toString("latin1", nameStart, nameStart + namesz);
    if (name === "Android\0" && type === NT_ANDROID_TYPE_IDENT && descsz >= 4) {
      return notes.readUInt32LE(descStart);
    }
    off = descStart + align4(descsz);
  }
  return undefined;
}

/**
 * Fail the build if any shipped .so targets an Android API above MIN_SDK or
 * uses RELR relocations, either of which breaks loading on older devices.
 */
export async function auditAndroidMinApi({
  roots,
  cwd,
  minSdk = MIN_SDK,
}: {
  roots: string[];
  cwd: string;
  minSdk?: number;
}): Promise<void> {
  const files: string[] = [];
  for (const root of roots) {
    for await (const match of glob("**/*.so", { cwd: root })) {
      files.push(join(root, match));
    }
  }
  files.sort();

  if (files.length === 0) {
    throw new Error(
      `Android min-API audit: no .so files found under ${roots
        .map((r) => relative(cwd, r))
        .join(", ")}`
    );
  }

  const reports = await Promise.all(files.map((f) => checkSoMinApi(f)));
  const bad = reports.filter(
    (r) =>
      r.relrTags.length > 0 || (r.apiLevel !== undefined && r.apiLevel > minSdk)
  );

  if (bad.length > 0) {
    const lines = bad.map((r) => {
      const problems: string[] = [];
      if (r.apiLevel !== undefined && r.apiLevel > minSdk) {
        problems.push(`built for API ${r.apiLevel}`);
      }
      if (r.relrTags.length > 0) problems.push(r.relrTags.join(", "));
      return `  ${relative(cwd, r.file)} (ELF${r.bits}): ${problems.join(
        "; "
      )}`;
    });
    throw new Error(
      `Android min-API audit failed for ${bad.length} .so file(s).\n` +
        `Each must target API <= ${minSdk} (our minSdkVersion) and have no RELR ` +
        `relocations, or it will crash at load on older Android versions.\n` +
        lines.join("\n")
    );
  }

  console.log(
    `Android min-API OK: ${reports.length} .so file(s) verified ` +
      `(target API <= ${minSdk}, no RELR relocations).`
  );
}
