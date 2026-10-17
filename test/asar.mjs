// Minimal read-only asar reader plus discovery of this machine's DSH
// installation, so the regression tests can run the shipped client module
// system instead of a re-implementation, and still work on any machine.
//
// The asar format: a pickle header of four little-endian uint32 values
// (4, headerSize, headerStringSize, jsonSize), then the JSON header, then the
// concatenated file payloads at `16 + jsonSize + entry.offset`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PICKLE_HEADER_BYTES = 16

/** Candidate installation roots, newest/most specific first. */
export function dshRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value === 'string' && value && !roots.includes(value)) roots.push(value)
  }
  push(process.env.DSH_INSTALL_ROOT)
  push(process.env.DSH_DESKTOP_ROOT)
  push(path.dirname(path.dirname(process.execPath)))
  push('D:/ruan_jian/deepseek_harness')
  push('C:/Program Files/DeepSeek Harness')
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'DeepSeek Harness'))
  push(os.homedir())
  return roots
}

/** Every `resources/app.asar` this machine exposes, in search order. */
export function asarCandidates() {
  const found = []
  for (const root of dshRoots()) {
    const direct = path.join(root, 'resources', 'app.asar')
    if (fs.existsSync(direct) && !found.includes(direct)) found.push(direct)
    const versions = path.join(root, 'harness-versions')
    if (!fs.existsSync(versions)) continue
    for (const child of fs.readdirSync(versions)) {
      const candidate = path.join(versions, child, 'resources', 'app.asar')
      if (fs.existsSync(candidate) && !found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

function parseHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(PICKLE_HEADER_BYTES)
    fs.readSync(fd, head, 0, PICKLE_HEADER_BYTES, 0)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    let read = 0
    while (read < jsonSize) read += fs.readSync(fd, json, read, jsonSize - read, PICKLE_HEADER_BYTES + read)
    return { fd, jsonSize, files: JSON.parse(json.toString('utf8')).files }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function walk(node, parts, visit) {
  for (const [name, child] of Object.entries(node || {})) {
    const next = parts.concat(name)
    if (child && child.files) {
      if (child.unpacked !== true) walk(child.files, next, visit)
      continue
    }
    if (child && typeof child.offset === 'string') visit(next.join('/'), child)
  }
}

/** Absolute paths (inside the archive) of every regular file matching `prefix`. */
export function listAsar(asarPath, prefix = '') {
  const { fd, files } = parseHeader(asarPath)
  fs.closeSync(fd)
  const out = []
  walk(files, [], (name) => {
    if (name.includes(prefix)) out.push(name)
  })
  return out
}

/** Read one file out of an asar archive by its slash-separated path. */
export function readAsarFile(asarPath, innerPath) {
  const { fd, jsonSize, files } = parseHeader(asarPath)
  try {
    const parts = innerPath.split('/')
    let cursor = files
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = cursor[parts[i]]
      if (!next || !next.files) return undefined
      cursor = next.files
    }
    const leaf = cursor[parts[parts.length - 1]]
    if (!leaf || typeof leaf.offset !== 'string') return undefined
    const data = Buffer.alloc(leaf.size)
    const start = PICKLE_HEADER_BYTES + jsonSize + Number(leaf.offset)
    let read = 0
    while (read < leaf.size) read += fs.readSync(fd, data, read, leaf.size - read, start + read)
    return data
  } finally {
    fs.closeSync(fd)
  }
}

/** First asar that contains `innerPath`, or undefined. */
export function findAsarEntry(innerPath) {
  for (const asar of asarCandidates()) {
    try {
      if (readAsarFile(asar, innerPath) !== undefined) return { asar, innerPath }
    } catch {
      /* unreadable archive: try the next candidate */
    }
  }
  return undefined
}

/**
 * Load the shipped client module system implementation
 * (`@deepseek-ai/dsh-client-modules` browser half). Returns undefined when this
 * machine exposes no installation, so a test can report SKIP instead of FAIL.
 */
export function officialClientModulesPath() {
  const rel = 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'
  const inside = findAsarEntry(rel)
  if (inside) return { kind: 'asar', ...inside }
  for (const root of dshRoots()) {
    const direct = path.join(root, rel)
    if (fs.existsSync(direct)) return { kind: 'file', path: direct }
  }
  return undefined
}

/** Read the module-system browser half regardless of carrier. */
export function readOfficialClientModules(found) {
  if (found.kind === 'asar') return readAsarFile(found.asar, found.innerPath).toString('utf8')
  return fs.readFileSync(found.path, 'utf8')
}

const MODULES_PKG = 'dsh/node_modules/@deepseek-ai/dsh-client-modules'

/**
 * The module system's Node half, plus the sibling packages it imports, so a
 * test can copy the real implementation into a temp tree (the archive is never
 * meant to be imported in place) and run the shipped `orderByModuleGraph`.
 * @returns {{ files: Array<[string, Buffer]>, entry: string }} archive-relative
 *   paths paired with their bytes, and the entry path to write at the root.
 */
export function officialModuleSystemTree(extraPackages = []) {
  const tree = officialPackageTree('dsh/node_modules/@deepseek-ai/dsh-client-modules', extraPackages)
  if (tree === undefined) return undefined
  // The Node half is the module the composition test imports.
  return { ...tree, entry: `${tree.entry}/lib/index.js` }
}

/**
 * Copy any shipped package plus its transitive dependencies into an importable
 * tree description. Used to run the real application modules outside the archive.
 * @param pkgPath - archive-relative package directory.
 * @param extraPackages - additional archive-relative package directories.
 * @returns entries (archive-relative path + bytes), the package directory to write
 *   at the tree root, and the archive prefix to strip.
 */
export function officialPackageTree(pkgPath, extraPackages = []) {
  for (const asar of asarCandidates()) {
    let files
    try {
      files = collectModuleTree(asar, [`${pkgPath}/package.json`, ...extraPackages])
    } catch {
      continue
    }
    if (files !== undefined) {
      return { asar, files, entry: pkgPath, prefix: 'dsh/node_modules/' }
    }
  }
  return undefined
}

/**
 * Transitively collect one package and every dependency it declares.
 *
 * Resolution mirrors Node: a dependency is looked for in the requiring
 * package's own `node_modules` first, then in each ancestor `node_modules` up
 * to the archive root, so pnpm-style nested installs resolve correctly. A
 * package's nested `node_modules` is copied too (its subtree owns those files).
 *
 * @returns entries, or undefined when a declared dependency cannot be found.
 */
function collectModuleTree(asar, seeds) {
  const files = new Map()
  const done = new Set()
  // Each queue item carries the archive directory that must resolve its deps.
  const queue = seeds.map((seed) => ({
    manifestPath: seed.endsWith('package.json') ? seed : `${seed}/package.json`,
    fromDir: 'dsh',
  }))

  /** Candidate manifest paths for `name`, nearest `node_modules` first. */
  const candidates = (name, fromDir) => {
    const out = []
    let dir = fromDir
    while (true) {
      out.push(`${dir}/node_modules/${name}/package.json`)
      if (dir === 'dsh' || dir === '.') break
      const parent = dir.includes('/node_modules/') || dir.includes('/')
        ? dir.slice(0, dir.lastIndexOf('/'))
        : '.'
      if (parent === dir) break
      dir = parent === '' ? '.' : parent
    }
    return out
  }

  while (queue.length > 0) {
    const { manifestPath, fromDir } = queue.shift()
    if (done.has(manifestPath)) continue
    const raw = readAsarFile(asar, manifestPath)
    if (raw === undefined) return undefined
    done.add(manifestPath)
    const manifest = JSON.parse(raw.toString('utf8'))
    const pkgRoot = manifestPath.slice(0, -'/package.json'.length)

    // Copy the package's own files, including any nested node_modules subtree.
    for (const name of listAsar(asar, pkgRoot)) {
      if (name.endsWith('.map') || files.has(name)) continue
      const data = readAsarFile(asar, name)
      if (data !== undefined) files.set(name, data)
    }

    const deps = { ...(manifest.dependencies || {}), ...(manifest.peerDependencies || {}) }
    for (const dep of Object.keys(deps)) {
      // Prefer a nested copy that already exists; otherwise the hoisted one.
      const wanted = candidates(dep, pkgRoot).find((p) => readAsarFile(asar, p) !== undefined)
      if (wanted === undefined) return undefined
      queue.push({ manifestPath: wanted, fromDir: path.dirname(path.dirname(wanted)) })
    }
  }
  return [...files.entries()]
}

/**
 * The active profile directory. `DSH_PROFILE_DIR` wins; otherwise the standard
 * `<DSH_HOME or ~/.dsh>/profiles/<DSH_PROFILE or desktop>` layout.
 */
export function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
}

/** Directory holding this test file. */
export function here(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl))
}

/** `file:` URL for a path, for dynamic import. */
export function urlOf(filePath) {
  return pathToFileURL(filePath).href
}
