// Composes the real client-module registry over one package directory, using the
// shipped module: it resolves dsh.client metadata the same way the Host does and
// calls the real `orderByModuleGraph`, so a cycle or self-reference fails here.
//
// The module-system implementation is read from whatever DSH installation this
// machine exposes (resources/app.asar, overridable with DSH_INSTALL_ROOT), so the
// test is not tied to the author's profile path.
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { here, officialModuleSystemTree } from './asar.mjs'

// The shipped module system's Node half is imported from a temp copy of the
// exact archive bytes (the archive cannot be imported in place); its sibling
// `@deepseek-ai/cordis` is copied alongside so the import resolves.
const tree = officialModuleSystemTree()
if (tree === undefined) {
  console.log('SKIP  no DSH installation with @deepseek-ai/dsh-client-modules found on this machine')
  console.log('      set DSH_INSTALL_ROOT to the folder containing resources/app.asar')
  console.log('\nCOMPOSITION SKIPPED')
  process.exit(0)
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-bridge-compose-'))
for (const [name, data] of tree.files) {
  const rel = name.startsWith(tree.prefix) ? name.slice(tree.prefix.length) : path.basename(name)
  const target = path.join(scratch, 'node_modules', rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}
const entryRel = tree.entry.slice(tree.prefix.length)
const mod = await import(pathToFileURL(path.join(scratch, 'node_modules', entryRel)).href)
fs.rmSync(scratch, { recursive: true, force: true })
const { orderByModuleGraph } = mod
console.log(`module system: ${tree.asar}`)
console.log(`entry: ${entryRel}\n`)

// --- replicate resolveMeta's discovery for one package -----------------------
function inspectPackage(pkgDir) {
  const pkgPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return { ok: false, why: `no package.json at ${pkgPath}` }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const dsh = pkg.dsh
  const decl = dsh && typeof dsh === 'object' ? dsh.client : undefined
  if (decl === undefined) return { ok: true, client: false, name: pkg.name }
  if (typeof decl !== 'object' || decl === null) {
    return { ok: false, why: `${pkg.name} has a non-object dsh.client declaration` }
  }
  if (typeof decl.platform !== 'string') {
    return { ok: false, why: `${pkg.name} dsh.client.platform must be a string` }
  }
  const arr = (field, value) => {
    if (value === undefined) return { ok: true, value: undefined }
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
      return { ok: false, why: `${pkg.name} ${field} must be a string array` }
    }
    return { ok: true, value }
  }
  const inj = arr('dsh.client.inject', decl.inject)
  if (!inj.ok) return inj
  const ext = arr('dsh.client.external', decl.external)
  if (!ext.ok) return ext
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    return { ok: false, why: `${pkg.name} dsh.client.immediately must be a boolean` }
  }
  if (decl.platform !== 'web') return { ok: true, client: false, name: pkg.name }

  const exportsField = pkg.exports
  let clientRel
  if (exportsField && typeof exportsField === 'object') {
    const c = exportsField['./client']
    if (typeof c === 'string') clientRel = c
    else if (c && typeof c === 'object' && typeof c.default === 'string') clientRel = c.default
  }
  if (clientRel === undefined) {
    return { ok: false, why: `${pkg.name} declares dsh.client but exports no "./client" bundle` }
  }
  const clientPath = path.join(path.dirname(pkgPath), clientRel)
  if (!fs.existsSync(clientPath)) {
    return {
      ok: false,
      why: `client-modules: client bundle not found; run \`pnpm run build\` before launch:\n  package: ${pkg.name}\n  path: ${clientPath}`,
    }
  }
  return {
    ok: true,
    client: true,
    name: pkg.name,
    entry: {
      id: pkg.name,
      rev: 'x',
      url: `/plugins/${pkg.name}/client.js`,
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      external: decl.external ?? [],
      immediately: decl.immediately === true,
    },
    clientPath,
  }
}

const target = path.resolve(process.argv[2] || '.')
const result = inspectPackage(target)

console.log(`inspecting: ${target}\n`)
if (!result.ok) {
  console.log('COMPOSITION WOULD THROW:')
  console.log(result.why)
  process.exit(1)
}
if (!result.client) {
  console.log(`not a client package (no web dsh.client) — composes as host-only: ${result.name}`)
  process.exit(0)
}

console.log('declaration parses OK')
console.log(`  id        = ${result.entry.id}`)
console.log(`  clientPath= ${result.clientPath}`)
console.log(`  inject    = ${JSON.stringify(result.entry.inject)}`)
console.log(`  external  = ${JSON.stringify(result.entry.external)}`)
console.log(`  immediately = ${String(result.entry.immediately)}`)

// --- ordering must not throw (cycles / self-reference) -----------------------
try {
  const ordered = orderByModuleGraph([result.entry])
  console.log(`\norderByModuleGraph OK -> [${ordered.map((e) => e.id).join(', ')}]`)
  console.log('\nCOMPOSITION OK')
} catch (err) {
  console.log('\norderByModuleGraph THREW:')
  console.log(String(err && err.message))
  process.exit(1)
}
