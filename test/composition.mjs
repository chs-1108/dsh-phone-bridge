// Reproduces the client-modules composition checks for one package, using the
// same rules the Host applies, so a failing declaration is caught before boot.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
console.log(`package: ${pkg.name}\n`)

// --- parseDshClient ----------------------------------------------------------
const decl = pkg.dsh && pkg.dsh.client
check('dsh.client exists', decl !== undefined && typeof decl === 'object')
check('dsh.client.platform is a string', typeof decl.platform === 'string', decl.platform)
check(
  'platform is "web"',
  decl.platform === 'web',
  'anything else makes resolveMeta bail and the half never composes',
)
if (decl.inject !== undefined) {
  check('inject is a string array', Array.isArray(decl.inject) && decl.inject.every((s) => typeof s === 'string'))
}
if (decl.external !== undefined) {
  check(
    'external is a string array',
    Array.isArray(decl.external) && decl.external.every((s) => typeof s === 'string'),
  )
}
if (decl.immediately !== undefined) {
  check('immediately is a boolean', typeof decl.immediately === 'boolean')
}

// --- clientExportOf ----------------------------------------------------------
const client = pkg.exports && pkg.exports['./client']
check('exports["./client"] declared', client !== undefined)
const rel = typeof client === 'string' ? client : client && client.default
check(
  'exports["./client"] is a string or {default:string}',
  typeof rel === 'string',
  typeof rel === 'string' ? rel : JSON.stringify(client),
)
if (typeof rel === 'string') {
  const abs = path.join(pkgDir, rel)
  check('client bundle exists on disk', fs.existsSync(abs), abs)
  if (fs.existsSync(abs)) {
    const src = fs.readFileSync(abs, 'utf8')
    check('client bundle is non-empty', src.length > 0, `${src.length} bytes`)
    // The served bytes are evaluated as a plain script: it must self-register.
    check(
      'client bundle calls window.__ModuleLoader__.load',
      src.includes('__ModuleLoader__.load'),
    )
    // A syntax error here is a hard "import failed" at boot.
    let syntaxOk = true
    let syntaxErr = ''
    try {
      // eslint-disable-next-line no-new-func
      new Function(src)
    } catch (err) {
      syntaxOk = false
      syntaxErr = String(err && err.message)
    }
    check('client bundle parses as a script', syntaxOk, syntaxErr)

    // The registered id is what the loader keys the factory by. The host builds
    // the front-end module graph from the PACKAGE NAME, so a mismatch means the
    // requested id never registers, the loader retries the single-package URL,
    // and the boot dies with "import failed" + a duplicate-registration error.
    const registeredId = /__ModuleLoader__\.load\(\s*\{[\s\S]*?\bid:\s*['"]([^'"]+)['"]/.exec(src)?.[1]
    check(
      'client bundle self-registers under package.json name',
      registeredId === pkg.name,
      `registered=${JSON.stringify(registeredId)} package.json name=${JSON.stringify(pkg.name)}`,
    )
  }
}

// --- files allowlist must ship everything the plugin reads at runtime --------
// The host reads the QR helper and the served page off its own package
// directory, so an npm `files` allowlist that omits one of them ships a plugin
// that cannot serve the phone. Check every package-relative path the host and
// client read off disk is covered by `files`. (cloudflared is gone: Tailscale is
// the only transport now, so there is no bundled binary to ship.)
const requiredPaths = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'web/app.html',
  'vendor/qrcode.cjs',
]
const allow = Array.isArray(pkg.files) ? pkg.files : []
const covered = (rel) =>
  allow.some((entry) => {
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    return normalized === rel || rel.startsWith(`${normalized}/`)
  })
for (const rel of requiredPaths) {
  check(`runtime file "${rel}" exists`, fs.existsSync(path.join(pkgDir, rel)), path.join(pkgDir, rel))
  check(`"${rel}" is covered by package.json files`, covered(rel), JSON.stringify(allow))
}

// --- every bare require() the factory performs must be in the seed table -----
const SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
const clientSrc = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8')
const requires = [...clientSrc.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
for (const word of [...new Set(requires)]) {
  check(`require("${word}") is in the platform seed`, SEED.has(word))
}

// --- the host half must import cleanly and export apply/inject ---------------
const { pathToFileURL } = await import('node:url')
let host = null
try {
  host = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href)
  check('host half imports', true)
} catch (err) {
  check('host half imports', false, String(err && err.message))
}
if (host) {
  check('host exports apply()', typeof host.apply === 'function')
  check('host exports inject', Array.isArray(host.inject), JSON.stringify(host.inject))
  check('host exports name', typeof host.name === 'string', host.name)
}

console.log(failures === 0 ? '\nCOMPOSITION CHECKS PASSED' : `\n${failures} COMPOSITION CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
