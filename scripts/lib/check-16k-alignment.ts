import { glob, open } from "node:fs/promises";
import { join, relative } from "node:path";

// Android 15+ requires every PT_LOAD program-header segment in a
// shipped .so to have `p_align >= 16384` (0x4000). AGP rejects
// misaligned native libraries when the device's page size is 16 KB.
//
// Refs:
//   https://developer.android.com/guide/practices/page-sizes
//   ELF spec: https://refspecs.linuxbase.org/elf/elf.pdf
//
// We parse the ELF program headers directly rather than shelling out
// to `readelf` — readelf isn't on macOS by default, and the per-arch
// NDK binaries aren't on $PATH. Pure JS keeps the check working in
// every dev environment and on Linux CI without extra setup.

const REQUIRED_ALIGN = 0x4000n; // 16 KiB
const PT_LOAD = 1;
// Just the bytes we actually read: ELF header (64 bytes max) plus the
// program header table. We open + pread so even a multi-MB libnode.so
// only costs a few KB of I/O.
const ELF_HEADER_BYTES = 64;

type LoadSegment = { vaddr: bigint; align: bigint };
export type AlignmentReport = {
  file: string;
  bits: 32 | 64;
  segments: LoadSegment[];
  bad: LoadSegment[];
};

/**
 * Parse a single ELF .so file's program headers and return every
 * PT_LOAD segment along with the ones that violate the 16 KB
 * alignment requirement. Throws on malformed/non-ELF input.
 */
export async function checkSoAlignment(
  filePath: string,
): Promise<AlignmentReport> {
  const fh = await open(filePath, "r");
  try {
    const header = Buffer.alloc(ELF_HEADER_BYTES);
    const { bytesRead } = await fh.read(header, 0, ELF_HEADER_BYTES, 0);
    if (bytesRead < ELF_HEADER_BYTES) {
      throw new Error(`${filePath}: file too short to be ELF`);
    }
    if (
      header[0] !== 0x7f ||
      header[1] !== 0x45 ||
      header[2] !== 0x4c ||
      header[3] !== 0x46
    ) {
      throw new Error(`${filePath}: not an ELF file`);
    }
    const eiClass = header[4]; // 1 = ELFCLASS32, 2 = ELFCLASS64
    const eiData = header[5]; // 1 = little-endian, 2 = big-endian
    if (eiData !== 1) {
      // Every Android ABI we ship for is little-endian. Refuse rather
      // than silently mis-parse if upstream ever changes that.
      throw new Error(`${filePath}: big-endian ELF not supported`);
    }
    const is64 = eiClass === 2;
    if (eiClass !== 1 && !is64) {
      throw new Error(`${filePath}: invalid EI_CLASS=${eiClass}`);
    }

    // Program header table location/shape lives at fixed offsets in
    // the ELF header. Layout differs between ELF32 and ELF64.
    const phoff = is64
      ? header.readBigUInt64LE(0x20)
      : BigInt(header.readUInt32LE(0x1c));
    const phentsize = header.readUInt16LE(is64 ? 0x36 : 0x2a);
    const phnum = header.readUInt16LE(is64 ? 0x38 : 0x2c);
    const phSize = phentsize * phnum;
    if (phSize === 0) {
      throw new Error(`${filePath}: empty program header table`);
    }

    const phTable = Buffer.alloc(phSize);
    const { bytesRead: phRead } = await fh.read(phTable, 0, phSize, Number(phoff));
    if (phRead < phSize) {
      throw new Error(`${filePath}: truncated program header table`);
    }

    const segments: LoadSegment[] = [];
    for (let i = 0; i < phnum; i++) {
      const base = i * phentsize;
      const pType = phTable.readUInt32LE(base);
      if (pType !== PT_LOAD) continue;
      // ELF32: p_type p_offset p_vaddr p_paddr p_filesz p_memsz p_flags p_align (8 × u32)
      // ELF64: p_type p_flags p_offset p_vaddr p_paddr p_filesz p_memsz p_align (2 × u32 + 6 × u64)
      const vaddr = is64
        ? phTable.readBigUInt64LE(base + 0x10)
        : BigInt(phTable.readUInt32LE(base + 0x08));
      const align = is64
        ? phTable.readBigUInt64LE(base + 0x30)
        : BigInt(phTable.readUInt32LE(base + 0x1c));
      segments.push({ vaddr, align });
    }

    const bad = segments.filter((s) => s.align < REQUIRED_ALIGN);
    return { file: filePath, bits: is64 ? 64 : 32, segments, bad };
  } finally {
    await fh.close();
  }
}

/**
 * Audit every .so file under the given directories. Reports every
 * scanned file with its PT_LOAD alignment values, and throws if any
 * unexpected one has a LOAD segment with `p_align < 0x4000`. Throws
 * if no .so files are found at all — silently passing on an empty
 * tree would defeat the point.
 *
 * `expectedMisaligned` is an allowlist of repo-relative paths that
 * are *known* to fail today, used to absorb tracked upstream issues
 * without disabling the audit for everything else. If a listed file
 * actually passes, that's also reported (and thrown on) so the
 * allowlist can't silently rot once the upstream fix lands.
 */
export async function audit16kAlignment({
  roots,
  cwd,
  expectedMisaligned = [],
}: {
  roots: string[];
  cwd: string;
  expectedMisaligned?: string[];
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
      `16 KB alignment audit: no .so files found under ${roots
        .map((r) => relative(cwd, r))
        .join(", ")}`,
    );
  }

  const expected = new Set(expectedMisaligned);
  const reports = await Promise.all(files.map((f) => checkSoAlignment(f)));

  const unexpectedFail: AlignmentReport[] = [];
  const expectedFail: AlignmentReport[] = [];
  const unexpectedPass: AlignmentReport[] = [];
  for (const r of reports) {
    const rel = relative(cwd, r.file);
    const isExpected = expected.has(rel);
    if (r.bad.length > 0) {
      (isExpected ? expectedFail : unexpectedFail).push(r);
    } else if (isExpected) {
      unexpectedPass.push(r);
    }
  }

  const errors: string[] = [];

  if (unexpectedFail.length > 0) {
    const lines = unexpectedFail.map((r) => formatReport(r, cwd));
    errors.push(
      `16 KB alignment check failed for ${unexpectedFail.length} .so file(s).\n` +
        `Each PT_LOAD segment must have p_align >= 0x4000 for Android 15+ 16 KB-page devices.\n` +
        lines.join("\n"),
    );
  }

  if (unexpectedPass.length > 0) {
    const lines = unexpectedPass.map((r) => `  ${relative(cwd, r.file)}`);
    errors.push(
      `16 KB alignment audit: ${unexpectedPass.length} file(s) listed in expectedMisaligned ` +
        `now pass the alignment check. Remove them from the allowlist:\n` +
        lines.join("\n"),
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n\n"));
  }

  if (expectedFail.length > 0) {
    const lines = expectedFail.map((r) => formatReport(r, cwd));
    console.warn(
      `16 KB alignment audit: ${expectedFail.length} file(s) misaligned (expected, allowlisted):\n` +
        lines.join("\n"),
    );
  }

  const cleanCount = reports.length - expectedFail.length;
  console.log(
    `16 KB alignment OK: ${cleanCount}/${reports.length} .so file(s) verified ` +
      `(every PT_LOAD segment has p_align >= 0x4000).`,
  );
}

function formatReport(r: AlignmentReport, cwd: string): string {
  const segs = r.bad
    .map(
      (s) => `vaddr=0x${s.vaddr.toString(16)} align=0x${s.align.toString(16)}`,
    )
    .join(", ");
  return `  ${relative(cwd, r.file)} (ELF${r.bits}): ${segs}`;
}
