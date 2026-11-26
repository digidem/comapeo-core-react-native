import { relative } from "node:path";

import { type Elf, findSoFiles, readWord, withElf } from "./elf.ts";

// Keep in sync with the minSdkVersion default in android/build.gradle.
export const MIN_SDK = 24;

// This check catches two ways a native library can crash on older phones
// even though it works on newer ones (CoMapeo 13.1 shipped sodium-native
// with both problems and crashed on every launch on Android 8:
// COMAPEO-2KX, COMAPEO-2QK).
//
// 1. Built for a newer Android version. The NDK writes a note into every
//    library saying which Android version it was built for. A library built
//    for a version above our minSdk can call system functions that older
//    phones don't have.
//
// 2. RELR relocations. When a library loads, the loader has to fix up the
//    pointers inside it to match where it landed in memory. RELR is a
//    compact format for that list of fix-ups. Loaders before Android 9 don't
//    know it and skip the list without an error, so the pointers stay wrong
//    and the app crashes the first time it uses one.

// Segment types (p_type), from the ELF spec.
const DYNAMIC_SEGMENT = 2; // PT_DYNAMIC: settings for the loader
const NOTE_SEGMENT = 4; // PT_NOTE: labels written by the build tools

// The loader settings are a list of (tag, value) pairs, ended by tag 0.
// These tags mean the library uses RELR.
const RELR_TAGS = new Map([
  [36, "DT_RELR"], // standard format, understood from Android 11 (API 30)
  [0x6fffe000, "DT_ANDROID_RELR"], // Android's own, understood from Android 9 (API 28)
]);

// A note is a 12-byte header (name length, data length, type), then the
// name and the data, each padded to a multiple of 4 bytes. The NDK's note
// is named "Android", has type 1, and its data starts with the API level.
const NOTE_HEADER_BYTES = 12;
const ANDROID_NOTE_NAME = "Android\0";
const ANDROID_NOTE_TYPE = 1;

export type MinApiReport = {
  file: string;
  bits: 32 | 64;
  apiLevel: number | undefined;
  relrTags: string[];
};

export function checkSoMinApi(filePath: string): Promise<MinApiReport> {
  return withElf(filePath, async (elf) => ({
    file: filePath,
    bits: elf.bits,
    apiLevel: await findApiLevel(elf),
    relrTags: await findRelrTags(elf),
  }));
}

async function findRelrTags(elf: Elf): Promise<string[]> {
  const found = new Set<string>();
  const entryBytes = (elf.bits / 8) * 2; // tag + value
  for (const segment of elf.segments) {
    if (segment.type !== DYNAMIC_SEGMENT) continue;
    const data = await elf.readSegment(segment);
    for (let off = 0; off + entryBytes <= data.length; off += entryBytes) {
      const tag = readWord(data, off, elf.bits);
      if (tag === 0) break;
      const name = RELR_TAGS.get(tag);
      if (name) found.add(name);
    }
  }
  return [...found];
}

async function findApiLevel(elf: Elf): Promise<number | undefined> {
  const padded = (n: number) => Math.ceil(n / 4) * 4;
  for (const segment of elf.segments) {
    if (segment.type !== NOTE_SEGMENT) continue;
    const notes = await elf.readSegment(segment);
    let off = 0;
    while (off + NOTE_HEADER_BYTES <= notes.length) {
      const nameLength = notes.readUInt32LE(off);
      const dataLength = notes.readUInt32LE(off + 4);
      const type = notes.readUInt32LE(off + 8);
      const nameStart = off + NOTE_HEADER_BYTES;
      const dataStart = nameStart + padded(nameLength);
      if (dataStart + dataLength > notes.length) break;
      const name = notes.toString("latin1", nameStart, nameStart + nameLength);
      if (
        name === ANDROID_NOTE_NAME &&
        type === ANDROID_NOTE_TYPE &&
        dataLength >= 4
      ) {
        return notes.readUInt32LE(dataStart);
      }
      off = dataStart + padded(dataLength);
    }
  }
  return undefined;
}

function problems(r: MinApiReport, minSdk: number): string[] {
  const found: string[] = [];
  if (r.apiLevel === undefined) {
    found.push("no Android version note, so its target API is unknown");
  } else if (r.apiLevel > minSdk) {
    found.push(`built for API ${r.apiLevel}`);
  }
  if (r.relrTags.length > 0) {
    found.push(`uses RELR relocations (${r.relrTags.join(", ")})`);
  }
  return found;
}

/** Fail the build if any shipped .so would crash at load on our minSdkVersion. */
export async function auditAndroidMinApi({
  roots,
  cwd,
  minSdk = MIN_SDK,
}: {
  roots: string[];
  cwd: string;
  minSdk?: number;
}): Promise<void> {
  const files = await findSoFiles({
    roots,
    cwd,
    checkName: "Android min-API audit",
  });
  const reports = await Promise.all(files.map((f) => checkSoMinApi(f)));

  const failures = reports
    .map((r) => ({ r, found: problems(r, minSdk) }))
    .filter(({ found }) => found.length > 0)
    .map(
      ({ r, found }) =>
        `  ${relative(cwd, r.file)} (${r.bits}-bit): ${found.join("; ")}`
    );

  if (failures.length > 0) {
    throw new Error(
      `Android min-API audit failed for ${failures.length} .so file(s).\n` +
        `Each must be built for API ${minSdk} or lower (our minSdkVersion) and ` +
        `must not use RELR relocations, or it will crash on older Android versions.\n` +
        failures.join("\n")
    );
  }

  console.log(
    `Android min-API OK: ${reports.length} .so file(s) verified ` +
      `(built for API <= ${minSdk}, no RELR relocations).`
  );
}
