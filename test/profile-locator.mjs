// The profile locator used to walk up from `import.meta.url`, which resolves the
// junction that DSH installs plugins through - so it landed in
// `<home>/<pkg>` and never saw a `profiles` directory. With more than one profile
// on disk the "only one profile" fallback did not save it either, and the repair
// silently did nothing.
//
// This suite builds the real layout, junction included, and proves the locator
// now finds the right profile - and still refuses when the answer is ambiguous.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')
const source = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8')

// Lift the locator helpers out of the source so this exercises the shipped code
// rather than a copy that could drift.
const start = source.indexOf('function profileRoot(')
const end = source.indexOf('/** The patch file a profile applies last')
if (start === -1 || end === -1) {
  console.error('FAIL  could not locate profileRoot/profileDir in index.js')
  process.exit(1)
}
const helpers = source.slice(start, end)

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

const isWindows = process.platform === 'win32'
const canLink = (() => {
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'))
    const target = path.join(probe, 't')
    const link = path.join(probe, 'l')
    fs.mkdirSync(target)
    fs.symlinkSync(target, link, isWindows ? 'junction' : 'dir')
    fs.rmSync(probe, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
})()

function buildHome({ profiles, mountOn, packageAsJunction, patchMentions }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'profloc-'))
  for (const name of profiles) {
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'cordis.patch.yml'),
      patchMentions.includes(name) ? '- id: phone-bridge\n  name: dsh-phone-bridge\n' : '- id: other\n',
      'utf8',
    )
  }
  // The package lives at <home>/phone-bridge, as the default install lays it out.
  const realPkg = path.join(home, 'phone-bridge')
  fs.mkdirSync(realPkg, { recursive: true })
  fs.copyFileSync(path.join(pkgDir, 'index.js'), path.join(realPkg, 'index.js'))

  // ...and is mounted into the profile through a junction.
  if (mountOn) {
    const nm = path.join(home, 'profiles', mountOn, 'node_modules')
    fs.mkdirSync(nm, { recursive: true })
    const link = path.join(nm, 'dsh-phone-bridge')
    if (packageAsJunction) fs.symlinkSync(realPkg, link, isWindows ? 'junction' : 'dir')
    else {
      fs.mkdirSync(link, { recursive: true })
      fs.copyFileSync(path.join(pkgDir, 'index.js'), path.join(link, 'index.js'))
    }
  }
  return { home, realPkg }
}

// Loads a *copy* of the locator from the given package directory. In production
// the junction makes `import.meta.url` resolve to the real package dir; with a
// plain copy it resolves to the copy itself, which is the point of case 2.
function loadLocator(fromPkg, home, profileEnv) {
  const modulePath = path.join(fromPkg, 'locate-probe.mjs')
  fs.writeFileSync(
    modulePath,
    [
      "import fs from 'node:fs'",
      "import os from 'node:os'",
      "import path from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      "const name = 'dsh-phone-bridge'",
      helpers,
      'export { profileDir, profileDirs, profileRoot }',
    ].join('\n'),
    'utf8',
  )
  const env = { ...process.env, DSH_HOME: home }
  delete env.DSH_PROFILE
  if (profileEnv) env.DSH_PROFILE = profileEnv
  const script = [
    `import(${JSON.stringify('file:///' + modulePath.replace(/\\/g, '/'))})`,
    '.then((m) => {',
    '  process.stdout.write(JSON.stringify({ dir: m.profileDir(), all: m.profileDirs().map((d) => path.basename(d)) }))',
    '})',
  ].join('\n')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

// --- 1. the regression: junction mount, two profiles ---------------------------
if (canLink) {
  const { home, realPkg } = buildHome({
    profiles: ['desktop', 'web'],
    mountOn: 'desktop',
    packageAsJunction: true,
    patchMentions: [],
  })
  const r = loadLocator(realPkg, home)
  check('junction: finds the profile that mounts the package', r.dir === path.join(home, 'profiles', 'desktop'), r.dir)
  check('junction: sees both profiles', r.all.length === 2, r.all.join(','))
  fs.rmSync(home, { recursive: true, force: true })

  // --- 2. a plain copy of the package works the same way ---------------------
  // Loaded from the mount point, since that is where a copied install resolves.
  const copy = buildHome({
    profiles: ['desktop', 'web'],
    mountOn: 'web',
    packageAsJunction: false,
    patchMentions: [],
  })
  const copyMount = path.join(copy.home, 'profiles', 'web', 'node_modules', 'dsh-phone-bridge')
  const r2 = loadLocator(copyMount, copy.home)
  check('copy: picks the mounting profile', r2.dir === path.join(copy.home, 'profiles', 'web'), r2.dir)
  fs.rmSync(copy.home, { recursive: true, force: true })
} else {
  console.log('SKIP  junction checks (no symlink privilege on this machine)')
}

// --- 3. DSH_PROFILE wins ------------------------------------------------------
{
  const { home, realPkg } = buildHome({
    profiles: ['desktop', 'web'],
    mountOn: 'desktop',
    packageAsJunction: false,
    patchMentions: [],
  })
  const r = loadLocator(realPkg, home, 'web')
  check('DSH_PROFILE: overrides discovery', r.dir === path.join(home, 'profiles', 'web'), r.dir)
  fs.rmSync(home, { recursive: true, force: true })
}

// --- 4. patch mention is the last resort before ambiguity ---------------------
{
  const { home, realPkg } = buildHome({
    profiles: ['desktop', 'web'],
    mountOn: '', // not mounted at all: discovery has to fall back
    packageAsJunction: false,
    patchMentions: ['web'],
  })
  const r = loadLocator(realPkg, home)
  check('patch mention: picks the profile that names the plugin', r.dir === path.join(home, 'profiles', 'web'), r.dir)
  fs.rmSync(home, { recursive: true, force: true })
}

// --- 5. ambiguity is refused, not guessed ------------------------------------
{
  const { home, realPkg } = buildHome({
    profiles: ['desktop', 'web'],
    mountOn: '',
    packageAsJunction: false,
    patchMentions: [],
  })
  const r = loadLocator(realPkg, home)
  check('ambiguous: refuses to guess', r.dir === '', r.dir)
  fs.rmSync(home, { recursive: true, force: true })
}

// --- 6. a single profile is safe to assume -----------------------------------
{
  const { home, realPkg } = buildHome({
    profiles: ['desktop'],
    mountOn: '',
    packageAsJunction: false,
    patchMentions: [],
  })
  const r = loadLocator(realPkg, home)
  check('single profile: accepted', r.dir === path.join(home, 'profiles', 'desktop'), r.dir)
  fs.rmSync(home, { recursive: true, force: true })
}

// --- 7. no profiles at all ---------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'profloc-empty-'))
  const realPkg = path.join(home, 'phone-bridge')
  fs.mkdirSync(realPkg)
  fs.copyFileSync(path.join(pkgDir, 'index.js'), path.join(realPkg, 'index.js'))
  const r = loadLocator(realPkg, home)
  check('no profiles: returns empty rather than a bad path', r.dir === '', r.dir)
  fs.rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} PROFILE-LOCATOR CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL PROFILE-LOCATOR CHECKS PASSED')
