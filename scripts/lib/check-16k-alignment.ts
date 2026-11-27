import { relative } from "node:path";

import { findSoFiles, withElf } from "./elf.ts";

// Android 15+ requires every loadable segment (PT_LOAD) in a shipped .so to
// be aligned to 16 KB, or the app can't load it on 16 KB-page devices.
// https://developer.android.com/guide/practices/page-sizes

const REQUIRED_ALIGN = 0x4000; // 16 KiB
const LOAD_SEGMENT = 1; // PT_LOAD

type LoadSegment = { address: number; alignment: number };
export type AlignmentReport = {
  file: string;
  bits: 32 | 64;
  segments: LoadSegment[];
  bad: LoadSegment[];
};

/**
 * Return every loadable segment in a .so, and the ones that aren't aligned
 * to 16 KB. Throws on malformed or non-ELF input.
 */
export function checkSoAlignment(filePath: string): Promise<AlignmentReport> {
  return withElf(filePath, async (elf) => {
    const segments = elf.segments
      .filter((s) => s.type === LOAD_SEGMENT)
      .map(({ address, alignment }) => ({ address, alignment }));
    const bad = segments.filter((s) => s.alignment < REQUIRED_ALIGN);
    return { file: filePath, bits: elf.bits, segments, bad };
  });
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
  const files = await findSoFiles({
    roots,
    cwd,
    checkName: "16 KB alignment audit",
  });

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
      (s) =>
        `vaddr=0x${s.address.toString(16)} align=0x${s.alignment.toString(16)}`,
    )
    .join(", ");
  return `  ${relative(cwd, r.file)} (ELF${r.bits}): ${segs}`;
}
