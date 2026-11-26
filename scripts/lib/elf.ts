import { glob, open, type FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";

// A minimal reader for the parts of a native library (.so, an "ELF" file)
// that our build checks look at. We parse it in JS rather than calling
// `readelf` so the checks run anywhere without the Android NDK installed.
//
// Field positions come from the ELF spec
// (https://refspecs.linuxbase.org/elf/elf.pdf). 32-bit libraries
// (armeabi-v7a) and 64-bit ones (arm64-v8a, x86_64) lay fields out
// differently, so each position is given for both.

export type Bits = 32 | 64;

// Fields in the file header, at the start of every .so.
const HEADER_BYTES = 64; // big enough for both layouts
const CLASS_BYTE = 4; // 1 = 32-bit, 2 = 64-bit
const BYTE_ORDER_BYTE = 5; // 1 = little-endian
const HEADER = {
  segmentTableOffset: { 32: 0x1c, 64: 0x20 }, // e_phoff
  segmentEntrySize: { 32: 0x2a, 64: 0x36 }, // e_phentsize
  segmentCount: { 32: 0x2c, 64: 0x38 }, // e_phnum
} as const;

// Fields in each entry of the segment table ("program headers"), which
// describes the chunks of the file the loader cares about.
const SEGMENT = {
  type: { 32: 0x00, 64: 0x00 }, // p_type
  fileOffset: { 32: 0x04, 64: 0x08 }, // p_offset
  address: { 32: 0x08, 64: 0x10 }, // p_vaddr
  fileSize: { 32: 0x10, 64: 0x20 }, // p_filesz
  alignment: { 32: 0x1c, 64: 0x30 }, // p_align
} as const;

export type Segment = {
  type: number;
  fileOffset: number;
  fileSize: number;
  address: number;
  alignment: number;
};

export type Elf = {
  path: string;
  bits: Bits;
  segments: Segment[];
  readSegment(segment: Segment): Promise<Buffer>;
};

/** Read a 4-byte value from a 32-bit file or an 8-byte value from a 64-bit one. */
export function readWord(buf: Buffer, offset: number, bits: Bits): number {
  return bits === 64
    ? Number(buf.readBigUInt64LE(offset))
    : buf.readUInt32LE(offset);
}

/** Open an ELF file, parse its segment table, and pass it to `fn`. */
export async function withElf<T>(
  path: string,
  fn: (elf: Elf) => Promise<T>
): Promise<T> {
  const fh = await open(path, "r");
  try {
    return await fn(await parse(path, fh));
  } finally {
    await fh.close();
  }
}

async function parse(path: string, fh: FileHandle): Promise<Elf> {
  // Read only the bytes we need: libnode.so is ~60 MB.
  const read = async (offset: number, length: number) => {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    if (bytesRead < length) {
      throw new Error(`${path}: file is truncated or not a valid ELF file`);
    }
    return buf;
  };

  const header = await read(0, HEADER_BYTES);
  if (header.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error(`${path}: not an ELF file`); // magic bytes "\x7fELF"
  }
  // Every Android ABI we ship is little-endian; refuse rather than misread.
  if (header[BYTE_ORDER_BYTE] !== 1) {
    throw new Error(`${path}: big-endian ELF not supported`);
  }
  const elfClass = header[CLASS_BYTE];
  if (elfClass !== 1 && elfClass !== 2) {
    throw new Error(`${path}: invalid ELF class ${elfClass}`);
  }
  const bits: Bits = elfClass === 2 ? 64 : 32;

  const tableOffset = readWord(header, HEADER.segmentTableOffset[bits], bits);
  const entrySize = header.readUInt16LE(HEADER.segmentEntrySize[bits]);
  const count = header.readUInt16LE(HEADER.segmentCount[bits]);
  if (count === 0) {
    throw new Error(`${path}: empty program header table`);
  }
  const table = await read(tableOffset, entrySize * count);

  const segments: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const at = (field: keyof typeof SEGMENT) =>
      i * entrySize + SEGMENT[field][bits];
    segments.push({
      type: table.readUInt32LE(at("type")),
      fileOffset: readWord(table, at("fileOffset"), bits),
      fileSize: readWord(table, at("fileSize"), bits),
      address: readWord(table, at("address"), bits),
      alignment: readWord(table, at("alignment"), bits),
    });
  }

  return {
    path,
    bits,
    segments,
    readSegment: (s) => read(s.fileOffset, s.fileSize),
  };
}

/** Find every .so under `roots`; throws if there are none, since an empty audit proves nothing. */
export async function findSoFiles({
  roots,
  cwd,
  checkName,
}: {
  roots: string[];
  cwd: string;
  checkName: string;
}): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for await (const match of glob("**/*.so", { cwd: root })) {
      files.push(join(root, match));
    }
  }
  if (files.length === 0) {
    throw new Error(
      `${checkName}: no .so files found under ${roots
        .map((r) => relative(cwd, r))
        .join(", ")}`
    );
  }
  return files.sort();
}
