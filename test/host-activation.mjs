// Boots the Host plugin the way the Loader does and exercises apply() against a
// recording ctx, so an activation-time throw surfaces here instead of at startup.
//
// Portable by design: the profile directory comes from DSH_PROFILE_DIR / DSH_HOME
// (or the standard `~/.dsh/profiles/desktop`), and `DSH_HOME` is redirected to a
// throwaway temp directory before the Host half is imported, so state.json is
// never written into a real profile.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { here, profileDir } from './asar.mjs'
import { useTempHome } from './temp-home.mjs'

const pkgDir = path.resolve(process.argv[2] || path.join(here(import.meta.url), '..'))
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const profile = profileDir()
const tempHome = useTempHome('host')

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}

console.log(`package: ${pkg.name}\nprofile: ${profile}\ntemp DSH_HOME: ${tempHome}\n`)

// --- 1. resolve the way locatePkgJson does -----------------------------------
// Diagnostics only: the profile resolves the plugin by package name through its
// linked node_modules. The activation below always imports THIS package
// directory, so the test exercises the code under change rather than whatever an
// older install happens to expose.
let linked = null
try {
  linked = createRequire(pathToFileURL(path.join(profile, 'noop.js')).href).resolve(pkg.name)
} catch (err) {
  linked = null
  console.log(`note: profile has no linked "${pkg.name}" (${String(err && err.code)})`)
}
if (linked !== null) {
  console.log(`profile link resolves to: ${linked}`)
  if (path.resolve(linked) !== path.resolve(path.join(pkgDir, pkg.main || 'index.js'))) {
    console.log('note: the profile link points at a DIFFERENT copy of the plugin than this directory')
  }
}
const resolved = path.join(pkgDir, pkg.main || 'index.js')
check('host entry file exists', fs.existsSync(resolved), resolved)

// --- 2. import the Host half -------------------------------------------------
let mod
try {
  mod = await import(pathToFileURL(resolved).href)
  check('host half imports without throwing', true)
} catch (err) {
  check('host half imports without throwing', false, String(err && err.stack))
  process.exit(1)
}
check('exports name', typeof mod.name === 'string', mod.name)
check('exports inject array', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('exports apply function', typeof mod.apply === 'function')
check('default export present', mod.default !== undefined)

// --- 3. run apply() against a recording ctx ----------------------------------
const routes = []
const effects = []
const logs = []
const ctx = {
  logger: (...a) => logs.push(a.join(' ')),
  log: (...a) => logs.push(a.join(' ')),
  get: () => undefined,
  on: () => () => {},
  effect(fn) {
    effects.push(fn)
    return () => {}
  },
  webServer: {
    port: 19387,
    host: '127.0.0.1',
    register(route) {
      if (routes.some((r) => r.kind === route.kind && r.path === route.path)) {
        throw new Error(`duplicate (kind, path) ${route.kind} ${route.path}`)
      }
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  },
  sessionController: {
    inspect: async () => undefined,
    create: async () => ({ sessionId: 'session-x' }),
    list: async () => ({ items: [] }),
    prompt: async () => {},
    follow: async () => ({ dispose() {} }),
  },
}

try {
  await mod.apply(ctx, { autoStart: false })
  check('apply() completes without throwing', true)
} catch (err) {
  check('apply() completes without throwing', false, String(err && err.stack))
}

check('registered one route', routes.length === 1, `${routes.length} route(s)`)
if (routes[0]) {
  check('route is a prefix', routes[0].kind === 'prefix', routes[0].kind)
  check('route path is /phone-bridge', routes[0].path === '/phone-bridge', routes[0].path)
  check('route has a handler', typeof routes[0].handler === 'function')
}
check('registered a teardown effect', effects.length >= 1, `${effects.length} effect(s)`)

// The plugin persists its pairing state under DSH_HOME; confirm it landed in the
// scratch home and not in the machine's real one.
const stateFile = path.join(tempHome, 'phone-bridge', 'state.json')
check('state.json written under the temp DSH_HOME', fs.existsSync(stateFile), stateFile)

// A second apply() must survive the duplicate route (the plugin logs and stays
// inactive instead of taking the boot down).
const before = routes.length
try {
  await mod.apply(ctx, { autoStart: false })
  check('a duplicate route registration is survivable', routes.length === before, `${routes.length} route(s)`)
} catch (err) {
  check('a duplicate route registration is survivable', false, String(err && err.message))
}

// teardown must not throw
try {
  for (const fn of effects) {
    const disposer = fn()
    if (typeof disposer === 'function') disposer()
  }
  check('teardown runs cleanly', true)
} catch (err) {
  check('teardown runs cleanly', false, String(err && err.message))
}

console.log(failures === 0 ? '\nHOST ACTIVATION OK' : `\n${failures} HOST CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
