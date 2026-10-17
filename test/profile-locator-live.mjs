// Confirms the locator resolves the real installation on this machine, which has
// two profiles (desktop, web) and mounts the plugin through a junction - the exact
// combination that used to make the repair fail silently.
//
// The probe is written next to the package so `import.meta.url` resolves exactly
// as it does in production, then run in a child process and removed again.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pkgDir = path.join(os.homedir(), '.dsh', 'phone-bridge')
const source = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8')

const start = source.indexOf('function profileRoot(')
const end = source.indexOf('/** The patch file a profile applies last')
if (start === -1 || end === -1) {
  console.error('FAIL  could not locate profileRoot/profileDir in the live index.js')
  process.exit(1)
}
const helpers = source.slice(start, end)

const probePath = path.join(pkgDir, '__locate-probe.mjs')
fs.writeFileSync(
  probePath,
  [
    "import fs from 'node:fs'",
    "import os from 'node:os'",
    "import path from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    "const name = 'dsh-phone-bridge'",
    helpers,
    'process.stdout.write(JSON.stringify({',
    '  dir: profileDir(),',
    '  all: profileDirs().map((d) => path.basename(d)),',
    '  root: profileRoot(),',
    '}))',
  ].join('\n'),
  'utf8',
)

let raw = ''
try {
  const env = { ...process.env }
  delete env.DSH_PROFILE
  raw = execFileSync(process.execPath, [probePath], { env, encoding: 'utf8' })
} finally {
  fs.rmSync(probePath, { force: true })
}

const r = JSON.parse(raw)
let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

console.log(`profiles on disk : ${r.all.join(', ')}  (${r.all.length})`)
console.log(`resolved profile : ${r.dir || '(empty)'}`)

check('more than one profile exists, so the fallback cannot help', r.all.length > 1, r.all.join(','))
check('a profile was resolved despite the junction', r.dir !== '', r.dir)
check('the resolved profile is "desktop"', path.basename(r.dir) === 'desktop', path.basename(r.dir))

const patch = path.join(r.dir, 'cordis.patch.yml')
check('its patch file exists', fs.existsSync(patch), patch)
if (fs.existsSync(patch)) {
  check('the patch file names the plugin', fs.readFileSync(patch, 'utf8').includes('dsh-phone-bridge'))
}

if (failures > 0) {
  console.log(`\n${failures} LIVE LOCATOR CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nLIVE LOCATOR OK')
