#!/usr/bin/env node
// Syntax-checks every Maestro flow under maestro/ with `maestro check-syntax`.
// That parser is stricter than plain YAML — it rejects unknown commands (e.g. a
// stray `sleep`, which is not a Maestro command), exactly the class of error
// that otherwise only surfaces in CI as an opaque
// BROWSERSTACK_TESTSUITE_PARSE_ERROR. Run before pushing (npm run
// maestro:check-syntax).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const maestroDir = join(here, '..', 'maestro')
const files = readdirSync(maestroDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((f) => join(maestroDir, f))

let failed = 0
for (const file of files) {
  const name = relative(process.cwd(), file) || file
  const res = spawnSync('maestro', ['check-syntax', file], { encoding: 'utf8' })
  if (res.status === 0) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trimEnd()
    if (out) console.error(out)
  }
}

const ok = files.length - failed
if (files.length === 0) console.error('warning: no maestro flows found under maestro/')
console.log(`\n${ok}/${files.length} maestro flow(s) passed syntax check`)
process.exit(failed > 0 ? 1 : 0)
