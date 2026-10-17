// Drives the real /api/fix-host route against a throwaway profile, so the whole
// chain is exercised: route -> detection -> file rewrite -> backup.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-host-e2e-'))
const profile = path.join(sandbox, 'profiles', 'mine')
fs.mkdirSync(profile, { recursive: true })

const patchPath = path.join(profile, 'cordis.patch.yml')
const before = [
  "- id: webserver",
  "  name: '@deepseek-ai/dsh-host-webserver'",
  '  inject: [webStartup]',
  '  config:',
  "    host: '127.0.0.1'",
  '    port: !!js ctx.webStartup.port ?? 3080',
  '    compression: gzip',
  '- id: other',
  '  disabled: false',
  '',
].join('\n')
fs.writeFileSync(patchPath, before, 'utf8')

process.env.DSH_HOME = sandbox
process.env.DSH_PROFILE = 'mine'
process.on('exit', () => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { apply } = await import('../index.js')

const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  webServer: {
    port: 0,
    host: '127.0.0.1',
    // DSH registers a route descriptor, not a bare handler.
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  },
  sessionController: { sessions: () => [], get: () => null },
  effect: () => () => {},
}
apply(ctx)

const server = http.createServer((req, res) => routes[0].handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/phone-bridge`

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

// The panel reports the problem before anything is fixed.
const status = await fetch(`${base}/api/status`, { headers: { accept: 'application/json' } }).then((r) => r.json())
check('status flags the loopback binding', status.loopbackOnly === true)
check('status carries a warning', typeof status.warning === 'string' && status.warning.length > 0)

const res = await fetch(`${base}/api/fix-host`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
const body = await res.json()
check('fix-host answers', res.status === 200, `HTTP ${res.status}`)
check('fix-host reports ok', body.ok === true)
check('fix-host reports a change', body.changed === true, body.mode)

const after = fs.readFileSync(patchPath, 'utf8')
check('file now has the wildcard host', after.includes("host: '0.0.0.0'"))
check('file no longer has the loopback host', !after.includes("'127.0.0.1'"))
check('file keeps the other entry', after.includes('- id: other'))
check('file keeps the !!js tag', after.includes('!!js ctx.webStartup.port'))

const backups = fs.readdirSync(profile).filter((n) => n.includes('.phone-bridge-') && n.endsWith('.bak'))
check('a backup was left behind', backups.length === 1, backups[0])
if (backups.length === 1) {
  const saved = fs.readFileSync(path.join(profile, backups[0]), 'utf8')
  check('the backup is the original file', saved === before)
}

// A second call must be a no-op rather than adding a duplicate entry.
const again = await fetch(`${base}/api/fix-host`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json())
check('second call changes nothing', again.changed === false, again.mode)
check(
  'file still has exactly one webserver entry',
  (fs.readFileSync(patchPath, 'utf8').match(/- id: webserver/g) || []).length === 1,
)

server.close()

if (failures > 0) {
  console.log(`\n${failures} E2E CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL FIX-HOST E2E CHECKS PASSED')
