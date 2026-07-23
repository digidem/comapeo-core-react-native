/** @type {import('jest').Config} */
module.exports = {
  // Source uses `.js` extensions on relative imports (required for the
  // emitted ESM to resolve at runtime under `moduleResolution: nodenext`),
  // but the files on disk are `.ts` and `tsc` rewrites nothing. Jest's
  // resolver doesn't apply TypeScript's `.js`→`.ts` remap, so strip the
  // extension back off before it resolves.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // All Jest tests live under src/. Scoping roots here (rather than the
  // default rootDir) keeps the test/haste scan out of backend/, ios/, and
  // any transient .claude/ worktrees without naming machine-specific paths.
  roots: ["<rootDir>/src"],
};
