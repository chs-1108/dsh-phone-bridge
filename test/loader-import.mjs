// Regression for the defect that broke the boot: the client half registered
// `window.__ModuleLoader__.load({ id: 'phone-bridge' })` while the package is
// named `dsh-phone-bridge`. The host builds the front-end module graph from the
// PACKAGE NAME, so the loader looked for a `dsh-phone-bridge` factory that never
// arrived, retried through the single-package URL, hit a duplicate registration
// for `phone-bridge`, and the boot audit failed with
// "web boot: 1 entry did not activate".
//
// This test runs the SHIPPED module system (read out of the installed
// resources/app.asar, never modified) in an isolated VM, serves the real
// client.js through it, and imports it by package name -- exactly the path the
// browser takes. It creates no window and starts no tunnel.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {
  here,
  officialClientModulesPath,
  readOfficialClientModules,
} from './asar.mjs'

const pkgDir = path.resolve(here(import.meta.url), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const clientSource = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8')

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}

const found = officialClientModulesPath()
if (found === undefined) {
  console.log('SKIP  no DSH installation found on this machine')
  console.log('      set DSH_INSTALL_ROOT to the folder containing resources/app.asar')
  console.log('\nLOADER REGRESSION SKIPPED')
  process.exit(0)
}
console.log(`module system: ${found.kind === 'asar' ? found.asar : found.path}\n`)

const official = readOfficialClientModules(found)

// --- the sandbox the browser would give the bundle ---------------------------
// One React stub stands in for the platform seed; anything else the bundle
// requires must already be registered by the module system itself.
const reactStub = {
  createElement: () => ({}),
  Component: class {},
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const staticModules = {
  react: reactStub,
  'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}) },
}

let bootstrap
const facade = { load: (spec) => { bootstrap = spec } }
const sandbox = vm.createContext({ window: { __ModuleLoader__: facade }, console })

// The queue facade is replaced by the module system during create(); give the
// bundle a `require` that only knows the platform seed, i.e. a bundle that asks
// for anything else fails loudly here rather than at runtime.
const seedRequire = (specifier) => {
  if (Object.prototype.hasOwnProperty.call(staticModules, specifier)) return staticModules[specifier]
  throw new Error(`the client bundle required "${specifier}", which is not a platform seed module`)
}

try {
  vm.runInContext(`${official}\n//# sourceURL=official-client-modules.js`, sandbox, {
    filename: 'official-client-modules.js',
  })
  check('installed client module system loaded', typeof bootstrap?.factory === 'function')
} catch (error) {
  check('installed client module system loaded', false, String(error && error.message))
  process.exit(1)
}

const api = bootstrap.factory((specifier) => {
  throw new Error(`module system bootstrap required "${specifier}"`)
})
check('bootstrap exposes ClientModuleSystem', typeof api.ClientModuleSystem === 'function')

// --- serve the real bundle the way /plugins does -----------------------------
const bundleOf = (id) => {
  const file = path.join(pkgDir, id === pkg.name ? 'client.js' : 'MISSING-file.js')
  return fs.readFileSync(file, 'utf8')
}

const scriptErrors = []
const loadedUrls = []
const target = { mode: 'queue', pendingQueue: [] }
sandbox.window.__ModuleLoader__ = target
const row = {
  id: pkg.name,
  rev: 'test',
  inject: [],
  external: [],
  initialUrl: `/plugins/??${pkg.name}/client.js,other/client.js&rev=test`,
  url: `/plugins/??${pkg.name}/client.js&rev=test`,
}

const system = new api.ClientModuleSystem({
  manifest: { modules: [row], plugins: [row] },
  staticModules,
  bootstrapModule: { id: bootstrap.id, exports: api },
  registrationTarget: target,
  async loadBundle(url) {
    loadedUrls.push(url)
    const match = /\?\?([^&]+)/.exec(url)
    const ids = match === null ? [] : match[1].split(',').map((part) => part.replace(/\/client\.js$/, ''))
    const other = ids.find((id) => id !== pkg.name)
    // A combo URL concatenates every requested bundle; an unknown neighbour is
    // simply absent, which is what the real route does for a dropped package.
    let source = ''
    for (const id of ids) {
      if (id === pkg.name) source += `${bundleOf(id)};\n`
      else if (other !== undefined && id === other) continue
    }
    try {
      vm.runInContext(`${source}\n//# sourceURL=${url}`, sandbox, { filename: url })
    } catch (error) {
      scriptErrors.push(String(error && error.message))
    }
  },
})

let exportsOf = null
let importError = null
try {
  exportsOf = await system.import(pkg.name)
} catch (error) {
  importError = String(error && error.message)
}

check(
  `import("${pkg.name}") succeeds`,
  importError === null,
  importError === null ? `after ${loadedUrls.length} bundle request(s)` : importError,
)
check('the bundle registered a factory', exportsOf !== null && exportsOf !== undefined)
check('exports.apply is a function', typeof exportsOf?.apply === 'function', typeof exportsOf?.apply)
check(
  'exports.inject is slots+locale',
  Array.isArray(exportsOf?.inject) && exportsOf.inject.join(',') === 'slots,locale',
  JSON.stringify(exportsOf?.inject),
)
check(
  'no duplicate-registration error was thrown by the bundle',
  !scriptErrors.some((message) => message.includes('duplicate factory registration')),
  JSON.stringify(scriptErrors),
)
check(
  'one request was enough (no fallback replay)',
  loadedUrls.length === 1,
  loadedUrls.join(' | '),
)

// --- the catalogued defect, asserted directly -------------------------------
// The registration id inside client.js must be the package name, because that
// is the id the host writes into the boot graph.
const registeredId = /__ModuleLoader__\.load\(\s*\{[\s\S]*?\bid:\s*'([^']+)'/.exec(clientSource)?.[1]
check(
  'client.js registers under package.json name',
  registeredId === pkg.name,
  `client.js id=${JSON.stringify(registeredId)} package.json name=${JSON.stringify(pkg.name)}`,
)

console.log(failures === 0 ? '\nLOADER REGRESSION PASSED' : `\n${failures} LOADER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
