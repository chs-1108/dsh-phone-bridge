/**
 * phone-bridge — Host half.
 *
 * Lets the phone use this Harness process: send text and photos, get the answer
 * back. The phone reaches the PC over Tailscale, so it works from any network
 * without exposing anything publicly.
 *
 *   phone --Tailscale--> webServer(/phone-bridge/*) --> sessionController
 *
 * The Agent answer is streamed back. By default the phone receives only the
 * final answer; a per-send flag (and a persisted default) also returns the
 * reasoning stream.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'phone-bridge'
export const inject = ['webServer', 'sessionController']

const require = createRequire(import.meta.url)
const ROUTE_PREFIX = '/phone-bridge'
/** How many finished jobs survive in jobs.json for a phone that polls late. */
const JOB_PERSIST_MAX = 50
const LOG = (ctx, level, msg) => {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](`[phone-bridge] ${msg}`)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ state */

function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'phone-bridge')
}

/**
 * Which profile this process is running.
 *
 * The plugin is installed as a junction (`<home>/profiles/<name>/node_modules/
 * <pkg>` -> `<home>/<pkg>`), and `import.meta.url` reports the *resolved* target.
 * Walking up from the real path therefore never meets a `profiles` directory, so
 * that approach alone silently fails on the default install - it returns '' and
 * the automatic repair appears to do nothing.
 *
 * Candidates are tried in order of confidence:
 *
 *   1. DSH_PROFILE, when DSH exports it
 *   2. the profile whose node_modules actually contains this package (junction or
 *      copy - compared both by resolved path and by realpath)
 *   3. the profile whose patch file already mentions this plugin
 *   4. the only profile on disk, if there is exactly one
 *
 * Returns '' when nothing is convincing, in which case the repair refuses rather
 * than editing the wrong file.
 */
function profileRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles')
}

function profileDirs() {
  try {
    return fs
      .readdirSync(profileRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(profileRoot(), entry.name))
  } catch {
    return []
  }
}

function realOrSelf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    try {
      return fs.realpathSync(target)
    } catch {
      return target
    }
  }
}

function profileDir() {
  const fromEnv = process.env.DSH_PROFILE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const candidate = path.join(profileRoot(), fromEnv.trim())
    if (fs.existsSync(candidate)) return candidate
  }

  const profiles = profileDirs()
  if (profiles.length === 0) return ''

  // This package's own directory, as resolved by the loader (junction target).
  const selfDir = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '')
  const selfReal = realOrSelf(selfDir)

  // 2. The profile that actually mounts this package.
  for (const dir of profiles) {
    const mounted = path.join(dir, 'node_modules', name)
    if (!fs.existsSync(mounted)) continue
    if (realOrSelf(mounted) === selfReal) return dir
  }

  // 3. The profile whose patch layer already references this plugin.
  for (const dir of profiles) {
    const patch = path.join(dir, 'cordis.patch.yml')
    try {
      if (fs.existsSync(patch) && fs.readFileSync(patch, 'utf8').includes(name)) return dir
    } catch {
      /* ignore */
    }
  }

  // 4. Unambiguous only when a single profile exists.
  if (profiles.length === 1) return profiles[0]
  return ''
}

/** The patch file a profile applies last; editing it is how host gets changed. */
function patchFile() {
  const dir = profileDir()
  if (dir === '') return ''
  return path.join(dir, 'cordis.patch.yml')
}

/**
 * The webserver row this profile should carry.
 *
 * A patch entry replaces the targeted row's config wholesale, so every field the
 * shipped layer needs has to be restated - a partial row would silently drop the
 * compression settings. `name` must match whatever the installed DSH calls this
 * service; both spellings are in the wild across versions.
 */
function webserverRow(name) {
  return [
    `- id: webserver`,
    `  name: '${name}'`,
    `  inject: [webStartup]`,
    `  config:`,
    `    host: '0.0.0.0'`,
    `    port: !!js ctx.webStartup.port ?? 3080`,
    `    compression: gzip`,
    `    compressionLevel: 1`,
    `    compressionThresholdBytes: 1024`,
  ]
}

/**
 * Rewrites the profile patch so the web server listens on every interface.
 *
 * Deliberately line-oriented rather than a YAML parse-and-re-serialise: the file
 * is hand-maintained, carries comments the user wrote, and contains `!!js`
 * tags and anchors a generic serialiser would mangle. Only three shapes are
 * handled, which covers every file this plugin has met:
 *
 *   1. a `- id: webserver` block whose config has a `host:` line  -> replace it
 *   2. a `- id: webserver` block whose config has no `host:`       -> insert one
 *   3. no webserver block at all                                   -> append one
 *
 * Anything it does not recognise is left untouched and reported as a failure, so
 * a surprising file never gets silently corrupted.
 */
function ensureWildcardHost(text, serviceName) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^-\s+id:\s*webserver\s*(#.*)?$/.test(line))
  if (start === -1) {
    const block = webserverRow(serviceName)
    const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`
    const sep = prefix === '' ? '' : '\n'
    return { ok: true, changed: true, mode: 'appended', text: `${prefix}${sep}${block.join('\n')}\n` }
  }

  // Find the end of this entry: the next top-level `- ` item.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      end = i
      break
    }
  }

  // A host line only counts when it is inside this entry's config block.
  let hostIndex = -1
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s+host:\s*/.test(lines[i])) {
      hostIndex = i
      break
    }
  }
  if (hostIndex !== -1) {
    const current = lines[hostIndex].replace(/^\s+host:\s*/, '').replace(/\s*#.*$/, '').trim()
    if (current === "'0.0.0.0'" || current === '"0.0.0.0"' || current === '0.0.0.0') {
      return { ok: true, changed: false, mode: 'already-set', text }
    }
    const indent = (lines[hostIndex].match(/^\s*/) || ['    '])[0]
    lines[hostIndex] = `${indent}host: '0.0.0.0'`
    return { ok: true, changed: true, mode: 'host-replaced', text: lines.join('\n') }
  }

  // No host line: add one at the end of this entry's config block.
  let configIndex = -1
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s+config:\s*$/.test(lines[i])) {
      configIndex = i
      break
    }
  }
  if (configIndex === -1) {
    return { ok: false, changed: false, mode: 'no-config-block', text }
  }
  let insertAt = configIndex + 1
  while (insertAt < end && /^\s+\S/.test(lines[insertAt])) insertAt += 1
  const indent = `${(lines[configIndex].match(/^\s*/) || ['  '])[0]}  `
  lines.splice(insertAt, 0, `${indent}host: '0.0.0.0'`)
  return { ok: true, changed: true, mode: 'host-inserted', text: lines.join('\n') }
}

/** The service name the running DSH uses for the web server, when known. */
function webserverServiceName(ctx) {
  try {
    const ws = ctx && ctx.webServer
    const seen = ws && ws[Symbol.for('dsh.service.name')]
    if (typeof seen === 'string' && seen !== '') return seen
  } catch {
    /* ignore */
  }
  return '@deepseek-ai/dsh-host-webserver'
}

function loadState() {
  const file = path.join(stateDir(), 'state.json')
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') raw = {}
  } catch {
    raw = {}
  }
  if (typeof raw.token !== 'string' || raw.token.length < 16) {
    raw.token = crypto.randomBytes(24).toString('hex')
  }
  if (typeof raw.sessionId !== 'string' || raw.sessionId === '') raw.sessionId = null
  if (typeof raw.cwd !== 'string' || raw.cwd === '') raw.cwd = null
  if (typeof raw.defaultShowThinking !== 'boolean') raw.defaultShowThinking = false
  // Older state files carry cloudflaredPath / lastTunnelUrl; drop them so the
  // file stops advertising a transport this version no longer has.
  delete raw.cloudflaredPath
  delete raw.lastTunnelUrl
  saveState(raw)
  return raw
}

function saveState(state) {
  try {
    const dir = stateDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * Finished jobs are mirrored here so a phone that was polling when DSH restarted
 * can still collect its answer. Jobs live in memory only during a turn; without
 * this a restart makes every outstanding job id answer 404 and the reply the
 * user was waiting for is gone for good.
 */
function jobsFile() {
  return path.join(stateDir(), 'jobs.json')
}

function loadJobs() {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.id !== 'string' || item.id === '') continue
    // A job that was mid-flight when the process died can never finish now.
    const status = item.status === 'done' || item.status === 'error' ? item.status : 'error'
    const job = {
      id: item.id,
      requestId: typeof item.requestId === 'string' ? item.requestId : '',
      status,
      turn: typeof item.turn === 'number' ? item.turn : null,
      showThinking: item.showThinking === true,
      liveText: '',
      liveReasoning: '',
      committedText: typeof item.committedText === 'string' ? item.committedText : '',
      committedReasoning: typeof item.committedReasoning === 'string' ? item.committedReasoning : '',
      final: typeof item.final === 'string' ? item.final : '',
      reasoning: typeof item.reasoning === 'string' ? item.reasoning : '',
      error:
        status === 'error'
          ? typeof item.error === 'string' && item.error
            ? item.error
            : 'DSH 重启时这一轮还没结束'
          : null,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    }
    out.push(job)
  }
  return out
}

function saveJobs(jobs) {
  try {
    const dir = stateDir()
    fs.mkdirSync(dir, { recursive: true })
    const keep = []
    for (const job of jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') continue
      keep.push({
        id: job.id,
        requestId: job.requestId,
        status: job.status,
        turn: job.turn,
        showThinking: job.showThinking,
        committedText: job.committedText,
        committedReasoning: job.committedReasoning,
        final: job.final,
        reasoning: job.reasoning,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })
    }
    keep.sort((a, b) => a.updatedAt - b.updatedAt)
    const capped = keep.slice(-JOB_PERSIST_MAX)
    fs.writeFileSync(jobsFile(), JSON.stringify(capped, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------ http helpers */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

function remoteAddress(req) {
  const sock = req.socket || req.connection
  return (sock && (sock.remoteAddress || '')) || ''
}

function isLoopbackAddress(addr) {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/, '')
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.')
}

/**
 * True when the request arrived through a proxy rather than straight from the
 * client. Tailscale delivers packets directly, so a proxied request means the
 * bridge is being reached from somewhere it was not meant to be, and the token
 * is then required.
 */
function isTunneled(req) {
  const h = req.headers || {}
  return Boolean(
    h['cf-connecting-ip'] ||
      h['cf-ray'] ||
      h['cf-ipcountry'] ||
      h['x-forwarded-for'] ||
      h['x-forwarded-host'] ||
      h['x-real-ip'],
  )
}

/** The local (loopback browser) operator may manage the bridge without a token. */
function isLocalAdmin(req) {
  return isLoopbackAddress(remoteAddress(req)) && !isTunneled(req)
}

function tokenFrom(req, url) {
  const auth = String((req.headers && req.headers.authorization) || '')
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (m) return m[1].trim()
  const q = url.searchParams.get('token')
  if (q) return q.trim()
  const k = url.searchParams.get('k')
  if (k) return k.trim()
  return ''
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- qr codecs */

let qrLib = null
function qrSvg(text, cellSize = 6, margin = 4) {
  if (qrLib === null) {
    try {
      qrLib = require('./vendor/qrcode.cjs')
    } catch {
      qrLib = false
    }
  }
  if (!qrLib) return null
  try {
    const qr = qrLib(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag(cellSize, margin, 'pair', 'phone-bridge')
  } catch {
    return null
  }
}

/** The mobile page, read from the package next to this module. */
let appHtmlCache = null
function appHtml() {
  if (appHtmlCache !== null) return appHtmlCache
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'app.html')
    appHtmlCache = fs.readFileSync(file, 'utf8')
  } catch {
    appHtmlCache = null
  }
  return appHtmlCache
}

/* -------------------------------------------------------------------- server */

/**
 * Where the bridge is reachable from.
 *
 * This used to wrap a cloudflared quick tunnel. Tailscale already connects the
 * phone to the PC privately and works across networks, which is the whole point
 * of the plugin, so a public tunnel only added a second, less private way to do
 * the same thing - and 52 MB of binary. All that is still needed here is the
 * port the web server listens on.
 */
class Tunnel {
  constructor(getCtx, state) {
    this.ctx = () => getCtx()
    this.state = state
  }

  snapshot() {
    return { status: 'disabled', url: null, error: null, startedAt: null, pid: null, executable: null, tail: '' }
  }

  port() {
    try {
      const ctx = this.ctx()
      const ws = ctx && ctx.webServer
      if (ws && typeof ws.port === 'number') return ws.port
    } catch {
      /* ignore */
    }
    return 17890
  }

  /**
   * The address the web server actually bound to.
   *
   * Returns loopback-only markers ('127.0.0.1', 'localhost', '::1') when the
   * server accepts nothing but local connections, which means no phone will ever
   * reach it. Empty string when it cannot be determined.
   */
  boundHost() {
    try {
      const ctx = this.ctx()
      const ws = ctx && ctx.webServer
      if (!ws) return ''
      // Different DSH versions expose it under different names.
      for (const key of ['host', 'address', 'bind', 'listenHost', 'hostname']) {
        const value = ws[key]
        if (typeof value === 'string' && value !== '') return value
      }
      const server = ws.server || ws.httpServer || ws.instance
      if (server && typeof server.address === 'function') {
        const addr = server.address()
        if (addr && typeof addr === 'object' && typeof addr.address === 'string') return addr.address
      }
    } catch {
      /* ignore */
    }
    return ''
  }

  /**
   * True when the server is bound to a concrete local interface rather than to
   * every interface. Wildcards (0.0.0.0, ::, empty) are reachable, so they are
   * not loopback-only.
   */
  loopbackOnly() {
    const host = this.boundHost()
    if (host === '') return false // unknown: do not cry wolf
    const normalised = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (normalised === '0.0.0.0' || normalised === '::' || normalised === '*') return false
    return (
      normalised === '127.0.0.1' ||
      normalised === '::1' ||
      normalised === 'localhost' ||
      normalised.startsWith('127.')
    )
  }

  note() {}

  start() {
    return this.snapshot()
  }

  stop() {
    const child = this.child
    this.status = 'stopped'
    this.startedAt = null
    this.error = null
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    return this.snapshot()
  }
}

/* -------------------------------------------------------------------- jobs */

const JOB_TTL_MS = 45 * 60 * 1000
const MAX_TEXT = 400000

function makeJob() {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'queued', // queued | running | done | error
    final: '',
    reasoning: '',
    error: null,
    turn: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestId: crypto.randomUUID(),
    showThinking: false,
    // live (stream) accumulators
    liveText: '',
    liveReasoning: '',
    // text and reasoning already committed by earlier steps of this turn
    committedText: '',
    committedReasoning: '',
  }
}

function jobView(job) {
  return {
    job: job.id,
    status: job.status,
    final: job.final.slice(-MAX_TEXT),
    reasoning: job.reasoning.slice(-MAX_TEXT),
    error: job.error,
    turn: job.turn,
    updatedAt: job.updatedAt,
  }
}

/* -------------------------------------------------------------- extraction */

function blocksOf(message) {
  if (!message || typeof message !== 'object') return []
  const content = message.content
  return Array.isArray(content) ? content : []
}

function textOfBlocks(blocks) {
  const out = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out.join('\n\n').trim()
}

function reasoningOfBlocks(blocks) {
  const out = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'reasoning' && typeof block.text === 'string') out.push(block.text)
  }
  return out.join('\n\n').trim()
}

/**
 * Join the durable assistant stream records of one committed message.
 * `text-chunks` carry the answer; `chunk` entries replay individual deltas.
 * Reasoning records are returned separately so the caller can drop them.
 */
function textFromStream(records) {
  if (!Array.isArray(records)) return { text: '', reasoning: '' }
  const text = []
  const reasoning = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      text.push(record.texts.join(''))
      continue
    }
    if (record.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
      reasoning.push(record.texts.join(''))
      continue
    }
    if (record.type === 'chunk' && record.chunk && typeof record.chunk === 'object') {
      const chunk = record.chunk
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text.push(chunk.text)
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoning.push(chunk.text)
      }
    }
  }
  return { text: text.join('').trim(), reasoning: reasoning.join('').trim() }
}

/** Human label for one SessionSummary: its title projection, else its cwd, else its id. */
function sessionLabel(summary) {
  if (!summary || typeof summary !== 'object') return ''
  const hints = summary.projections
  const values = hints && hints.values
  if (values && typeof values === 'object') {
    const title = values.title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  if (typeof summary.cwd === 'string' && summary.cwd) {
    const parts = summary.cwd.split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : summary.cwd
  }
  return String(summary.sessionId || '')
}

/* --------------------------------------------------------------- the bridge */

class Bridge {
  constructor(ctx, state) {
    this.ctx = ctx
    this.state = state
    this.jobs = new Map()
    this.queue = []
    this.follower = null
    this.followAbort = null
    this.tunnel = new Tunnel(() => this.ctx, state)
    // Restore the answers that were already produced, so a phone polling across
    // a DSH restart still gets the reply it was waiting for.
    for (const job of loadJobs()) this.jobs.set(job.id, job)
  }

  /* ---- session ---- */

  async ensureSession() {
    if (this.state.sessionId) {
      const known = await this.ctx.sessionController
        .inspect(this.state.sessionId, new AbortController().signal)
        .then(() => true)
        .catch(() => false)
      if (known) return this.state.sessionId
      LOG(this.ctx, 'warn', `session ${this.state.sessionId} not found; creating a new one`)
      this.state.sessionId = null
    }
    const cwd = this.state.cwd || process.cwd()
    const created = await this.ctx.sessionController.create({ cwd })
    this.state.sessionId = created.sessionId
    saveState(this.state)
    LOG(this.ctx, 'info', `created phone session ${created.sessionId}`)
    return this.state.sessionId
  }

  /**
   * True when this session already has a turn in flight that the bridge did not
   * start.
   *
   * Stream frames carry no turn number, so if the phone shares a session with
   * whatever the desktop is doing, the phone's job cannot tell its own answer
   * from the other turn's output and ends up showing that instead. Refusing to
   * send into a busy session keeps the two apart.
   */
  async sessionIsBusy(sessionId, signal) {
    try {
      const summary = await this.ctx.sessionController.inspect(sessionId, signal)
      return Boolean(summary && summary.running)
    } catch {
      // Cannot tell: let the send through rather than blocking a working setup.
      return false
    }
  }

  prune() {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (now - job.updatedAt > JOB_TTL_MS) this.jobs.delete(id)
    }
    this.queue = this.queue.filter((id) => this.jobs.has(id))
  }

  job(id) {
    const job = this.jobs.get(id)
    if (job) job.updatedAt = Date.now()
    return job
  }

  /* ---- follow loop ---- */

  ensureFollower(sessionId) {
    if (this.follower && this.follower.sessionId === sessionId) return
    this.stopFollower()
    const controller = new AbortController()
    this.followAbort = controller
    const entry = { sessionId, started: Date.now() }
    this.follower = entry
    this.followLoop(sessionId, controller, entry, 0)
  }

  /**
   * Consume the follow stream until it ends, then reconnect while the session is
   * still the one being followed and jobs are outstanding.
   *
   * A follow stream is a subscription, not a one-shot request: it can end when
   * the turn commits, and it dies silently if the session is busy. Without this
   * retry the plugin stops observing the session after the first stream ends and
   * every later reply is invisible to the phone - the symptom being that
   * messages arrive but answers never come back.
   */
  followLoop(sessionId, controller, entry, attempt) {
    ;(async () => {
      let ended = false
      try {
        const stream = this.ctx.sessionController.follow(
          { address: { kind: 'session', sessionId }, assistantStream: true },
          controller.signal,
        )
        for await (const frame of stream) {
          this.onFrame(frame)
        }
        ended = true
      } catch (err) {
        if (!controller.signal.aborted) {
          LOG(this.ctx, 'warn', `follow failed: ${String((err && err.message) || err)}`)
        }
      }
      // Every guard below must agree before resubscribing, or two loops end up
      // consuming the same session and a frame is applied twice.
      if (controller.signal.aborted) return
      if (this.follower !== entry) return
      if (controller !== this.followAbort) return
      if (this.follower.sessionId !== sessionId) return
      // Only stay subscribed while something is actually outstanding. A tail
      // that reconnects on an idle session just replays finished turns.
      if (!this.hasPendingWork()) {
        if (this.follower === entry) this.follower = null
        return
      }
      if (attempt >= 40) {
        LOG(this.ctx, 'warn', `follow gave up after ${attempt} attempts`)
        if (this.follower === entry) this.follower = null
        return
      }
      if (ended) LOG(this.ctx, 'info', 'follow stream ended; resubscribing')
      const wait = Math.min(200 * (attempt + 1), 3000)
      const timer = setTimeout(() => {
        if (controller.signal.aborted || this.follower !== entry) return
        if (controller !== this.followAbort) return
        this.followLoop(sessionId, controller, entry, attempt + 1)
      }, wait)
      if (typeof timer.unref === 'function') timer.unref()
    })()
  }

  /** True while at least one queued or in-flight job still needs the stream. */
  hasPendingWork() {
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') return true
    }
    return false
  }

  /** True while a job is waiting to be attached to a turn. */
  hasQueuedJob() {
    for (const job of this.jobs.values()) {
      if (job.status === 'queued') return true
    }
    return false
  }

  stopFollower() {
    if (this.followAbort) {
      try {
        this.followAbort.abort()
      } catch {
        /* ignore */
      }
    }
    this.followAbort = null
    this.follower = null
  }

  /** The running job bound to exactly this turn, or null. Never guesses. */
  jobForTurn(turn) {
    if (typeof turn !== 'number') return null
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.turn === turn) return job
    }
    return null
  }

  /**
   * The job that owns the turn currently in flight.
   *
   * Several jobs can be queued at once, and a turn event is not addressed to any
   * of them, so the match has to be precise: prefer the job already bound to
   * this turn number, otherwise the oldest unbound job. Returning the first
   * `running` job in insertion order instead would pin every later turn to the
   * oldest job forever, and the newer ones would never leave `running`.
   */
  runningJob(turn) {
    if (typeof turn === 'number') {
      for (const job of this.jobs.values()) {
        if (job.status === 'running' && job.turn === turn) return job
      }
    }
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.turn === null) return job
    }
    if (typeof turn === 'number') {
      for (const job of this.jobs.values()) {
        if (job.status === 'running') return job
      }
    }
    return null
  }

  /**
   * Bind the next queued job to a turn. Kept separate from runningJob so that a
   * turn/end that arrives without a preceding turn/start still resolves, and so
   * that two turns can never bind to the same job.
   */
  claimTurn(turn) {
    const id = this.queue.shift()
    const job = id ? this.jobs.get(id) : null
    if (!job || job.status !== 'queued') return null
    job.status = 'running'
    job.turn = typeof turn === 'number' ? turn : null
    job.liveText = ''
    job.liveReasoning = ''
    job.committedText = ''
    job.committedReasoning = ''
    job.final = ''
    job.reasoning = ''
    job.updatedAt = Date.now()
    return job
  }

  /**
   * The job allowed to consume stream chunks.
   *
   * Stream chunks are unattributed, so the only safe owner is a job that
   * turn/start bound explicitly AND that is still the newest such binding.
   * Returning the first running job here fed desktop output into the phone's
   * answer, which is exactly the "reply never arrives, wrong text arrives"
   * symptom. Two bound jobs means the newer turn has started, so the older one
   * is stale and must not keep eating chunks.
   */
  streamOwner() {
    let owner = null
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      if (job.turn === null) continue
      if (!owner || job.turn > owner.turn) owner = job
    }
    return owner
  }

  onFrame(frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'snapshot') {
      return
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame
      if (!inner || inner.type !== 'chunk') return
      // A stream chunk carries no turn number, so it cannot be attributed on its
      // own. Only the job that turn/start already bound to the turn in flight may
      // consume it: otherwise output produced anywhere else in the session (the
      // desktop window, another client) is mistaken for this phone's answer.
      const job = this.streamOwner()
      if (!job) return
      const chunk = inner.chunk
      if (!chunk || typeof chunk !== 'object') return
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        // Live preview of the step in flight; the durable assistant/message
        // replaces it when the step commits, so text is never shown twice.
        job.liveText += chunk.text
        job.final = job.committedText ? `${job.committedText}\n\n${job.liveText}` : job.liveText
        job.updatedAt = Date.now()
        return
      }
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        if (!job.showThinking) return
        // Live preview only. The durable assistant/message is authoritative and
        // replaces this buffer, so the same text is never counted twice.
        job.liveReasoning += chunk.text
        job.reasoning = job.committedReasoning
          ? `${job.committedReasoning}\n\n${job.liveReasoning}`
          : job.liveReasoning
        job.updatedAt = Date.now()
        return
      }
      return
    }
    if (frame.type !== 'event') return
    const event = frame.event
    if (!event || typeof event !== 'object') return
    const data = event.data || {}
    switch (event.type) {
      case 'turn/start': {
        if (typeof data.turn === 'number') {
          // A resubscribed stream can deliver a turn again. Bind it only if some
          // job is still waiting for one; otherwise this is a replay of work that
          // already settled and must be ignored.
          if (!this.hasQueuedJob()) {
            LOG(this.ctx, 'info', `turn ${data.turn} arrived with nothing queued; ignoring`)
            return
          }
          const job = this.claimTurn(data.turn)
          if (job) LOG(this.ctx, 'info', `job ${job.id} -> turn ${data.turn}`)
        }
        return
      }
      case 'assistant/message': {
        const job = this.runningJob(data.turn)
        if (!job) return
        // Only this turn's own message belongs here. The old test skipped the
        // mismatch only when job.turn was already set, so an unbound job happily
        // absorbed a message from a different turn.
        if (typeof data.turn === 'number' && job.turn !== null && data.turn !== job.turn) return
        if (typeof data.turn === 'number' && job.turn === null) {
          // Adopt the turn this message proves the job belongs to.
          job.turn = data.turn
        }
        const blocks = blocksOf(data.message)
        // The durable stream records are the authoritative rendering of this
        // message; the content blocks are the fallback.
        const durable = textFromStream(data.stream)
        const text = durable.text || textOfBlocks(blocks)
        if (text) {
          job.committedText = job.committedText ? `${job.committedText}\n\n${text}` : text
          job.final = job.committedText
        }
        const reasoning = durable.reasoning || reasoningOfBlocks(blocks)
        // A turn may hold several steps. Each committed message contributes its
        // reasoning exactly once: the durable text replaces the live preview of
        // this step, then joins the reasoning already committed by earlier steps.
        if (reasoning && job.showThinking) {
          job.committedReasoning = job.committedReasoning
            ? `${job.committedReasoning}\n\n${reasoning}`
            : reasoning
          job.reasoning = job.committedReasoning
        } else if (job.showThinking && !job.committedReasoning && job.liveReasoning) {
          job.committedReasoning = job.liveReasoning
          job.reasoning = job.committedReasoning
        }
        job.liveText = ''
        job.liveReasoning = ''
        job.updatedAt = Date.now()
        return
      }
      case 'turn/end': {
        // turn/end names the turn it ends, so match on that alone. Falling back
        // to "any running job" would end an unrelated job whenever the turn
        // numbers happen to be missing.
        const job = this.jobForTurn(data.turn)
        if (!job) return
        const reason = data.reason
        const kind = reason && typeof reason === 'object' ? reason.kind : undefined
        // TurnEndReasonMap: completed | aborted | blocked | error | max-tokens | interrupted | forked
        if (kind === 'error' || kind === 'aborted' || kind === 'blocked') {
          job.status = 'error'
          const failure = reason && reason.error
          job.error =
            (failure && (failure.message || failure.code)) ||
            (kind === 'aborted'
              ? '本轮被中断'
              : kind === 'blocked'
                ? '本轮被阻塞'
                : kind === 'error'
                  ? '模型或工具出错'
                  : String(kind))
        } else {
          // completed, max-tokens, interrupted and forked all carry whatever text
          // the model produced; the phone shows that as the final result. A step
          // that streamed but never committed leaves its text in liveText.
          if (!job.final && job.liveText) {
            job.final = job.committedText
              ? `${job.committedText}\n\n${job.liveText}`
              : job.liveText
          }
          if (!job.final) job.final = '（本轮没有文本回复）'
          if (!job.reasoning && job.showThinking && job.liveReasoning) {
            job.reasoning = job.liveReasoning
          }
          job.status = 'done'
        }
        job.updatedAt = Date.now()
        LOG(this.ctx, 'info', `job ${job.id} -> ${job.status}`)
        saveJobs(this.jobs)
        return
      }
      default:
        return
    }
  }

  /* ---- send ---- */

  async send(input) {
    const text = typeof input.text === 'string' ? input.text : ''
    const images = Array.isArray(input.images) ? input.images : []
    const content = []
    const trimmed = text.trim()
    if (trimmed) content.push({ type: 'text', text: trimmed })
    for (const image of images.slice(0, 8)) {
      if (!image || typeof image !== 'object') continue
      const mediaType = String(image.mediaType || 'image/jpeg')
      const data = typeof image.data === 'string' ? image.data.replace(/^data:[^;]+;base64,/, '') : ''
      if (!data) continue
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) continue
      const part = { type: 'image', mediaType, data }
      if (typeof image.name === 'string' && image.name) part.name = image.name
      content.push(part)
    }
    if (content.length === 0) {
      const err = new Error('内容为空：请提供文字或图片')
      err.status = 400
      throw err
    }

    const job = makeJob()
    job.showThinking = input.showThinking === true
    this.prune()
    this.jobs.set(job.id, job)
    this.queue.push(job.id)

    const sessionId = await this.ensureSession()
    // A turn already running in this session means the job below would receive
    // that turn's output as its own answer. Report it instead of silently showing
    // the wrong text; the phone can retry once the session is idle.
    if (await this.sessionIsBusy(sessionId, new AbortController().signal)) {
      this.jobs.delete(job.id)
      this.queue = this.queue.filter((id) => id !== job.id)
      const err = new Error('会话正忙：请等这一轮结束后再发，或换一个会话')
      err.status = 409
      throw err
    }
    this.ensureFollower(sessionId)

    try {
      // prompt(request, signal): the implementation calls signal.throwIfAborted(),
      // so a real AbortSignal is required as the second argument.
      await this.ctx.sessionController.prompt(
        {
          requestId: job.requestId,
          sessionId,
          mode: 'queue',
          content,
        },
        new AbortController().signal,
      )
    } catch (err) {
      job.status = 'error'
      job.error = String((err && err.message) || err)
      job.updatedAt = Date.now()
      const idx = this.queue.indexOf(job.id)
      if (idx >= 0) this.queue.splice(idx, 1)
      throw err
    }
    return { job, sessionId }
  }
}

/* ------------------------------------------------------------------- routes */

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const state = loadState()
  if (typeof cfg.defaultShowThinking === 'boolean') state.defaultShowThinking = cfg.defaultShowThinking

  const bridge = new Bridge(ctx, state)

  /** The port the web server actually listens on. */
  const webServerPort = () => bridge.tunnel.port()

  /**
   * This machine's addresses that another device could reach, best first.
   *
   * Tailscale (100.64.0.0/10) comes first because it works across networks and
   * survives the phone leaving the house; then private LAN ranges, which only
   * work on the same WiFi. Loopback and link-local are useless for pairing, so
   * they are skipped.
   */
  const reachableAddresses = () => {
    const tailscale = []
    const lan = []
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const info of interfaces[name] || []) {
        if (info.family !== 'IPv4' && info.family !== 4) continue
        if (info.internal) continue
        const address = info.address
        if (address.startsWith('169.254.')) continue
        if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(address)) {
          tailscale.push(address)
        } else if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) {
          lan.push(address)
        }
      }
    }
    return [...tailscale, ...lan]
  }

  /**
   * The address the phone should pair with.
   *
   * Tailscale first: it connects the two devices privately and keeps working
   * when the phone leaves the house. LAN is the fallback for a setup without it.
   */
  const pairBase = () => {
    const port = webServerPort()
    const hosts = reachableAddresses()
    if (hosts.length === 0) return ''
    return `http://${hosts[0]}:${port}`
  }

  /** Every address the phone could pair with, so the UI can offer a choice. */
  const pairCandidates = () => {
    const port = webServerPort()
    return reachableAddresses().map((host) => ({
      url: `http://${host}:${port}`,
      kind: /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(host) ? 'tailscale' : 'lan',
      host,
    }))
  }

  const pairUrl = () => {
    const base = pairBase()
    if (!base) return ''
    return `${base}${ROUTE_PREFIX}/#t=${state.token}`
  }

  const adminStatus = () => {
    // The single most common reason a correct pairing still fails: the web
    // server accepted only loopback, so the phone's packets never arrived. Say
    // so explicitly instead of leaving the user with a bare connect timeout.
    const boundHost = bridge.tunnel.boundHost()
    const loopbackOnly = bridge.tunnel.loopbackOnly()
    return {
      ok: true,
      version: 1,
      tunnel: bridge.tunnel.snapshot(),
      pairUrl: pairUrl(),
      pairCandidates: pairCandidates(),
      sessionId: state.sessionId,
      cwd: state.cwd || process.cwd(),
      defaultShowThinking: state.defaultShowThinking,
      token: state.token,
      hasQr: qrSvg('x') !== null,
      boundHost,
      loopbackOnly,
      reachable: reachableAddresses().length > 0,
      warning: loopbackOnly
        ? `DSH 只监听本机（${boundHost}），手机无法连接。请在 profile 的 cordis.patch.yml 里把 webServer 的 host 改成 0.0.0.0，然后重启 DSH。`
        : '',
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    const rest = pathname.slice(ROUTE_PREFIX.length) || '/'

    // Anywhere-public liveness probe: lets the phone validate the URL before
    // pairing. A phone that reaches this at all proves the host binding is fine,
    // so it also reports the binding for the desktop panel's diagnostics.
    if (pathname === `${ROUTE_PREFIX}/health`) {
      return sendJson(res, 200, {
        ok: true,
        name: 'phone-bridge',
        version: 1,
        boundHost: bridge.tunnel.boundHost(),
        loopbackOnly: bridge.tunnel.loopbackOnly(),
      })
    }

    const admin = isLocalAdmin(req)
    const token = tokenFrom(req, url)
    const authorized = admin || (token !== '' && timingSafeEqual(token, state.token))

    if (!authorized) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    }

    try {
      if (rest === '' || rest === '/' || rest === '/home' || rest === '/index.html') {
        const html = appHtml()
        if (html === null) return sendText(res, 500, 'phone-bridge: web/app.html is missing')
        return sendText(res, 200, html, 'text/html; charset=utf-8')
      }

      if (pathname === `${ROUTE_PREFIX}/api/sessions` && method === 'GET') {
        let items = []
        try {
          // list(_request, signal): the signal argument is required by the Remote signature.
          const listed = await ctx.sessionController.list({}, new AbortController().signal)
          const raw = Array.isArray(listed) ? listed : (listed && listed.items) || []
          items = raw
            .filter((s) => s && typeof s.sessionId === 'string')
            .filter((s) => s.origin !== 'subagent')
            .slice(0, 40)
            .map((s) => ({
              sessionId: s.sessionId,
              label: sessionLabel(s),
              running: s.running === true,
              updatedAt: s.updatedAt || 0,
            }))
        } catch (err) {
          LOG(ctx, 'warn', `session list failed: ${String((err && err.message) || err)}`)
        }
        return sendJson(res, 200, { ok: true, items })
      }

      if (pathname === `${ROUTE_PREFIX}/qr.svg` && method === 'GET') {
        const svg = qrSvg(pairUrl() || `http://127.0.0.1:${bridge.tunnel.port()}${ROUTE_PREFIX}/`)
        if (!svg) return sendText(res, 500, 'qr unavailable')
        return sendText(res, 200, svg, 'image/svg+xml; charset=utf-8')
      }

      if (pathname === `${ROUTE_PREFIX}/api/status` && method === 'GET') {
        return sendJson(res, 200, adminStatus())
      }

      if (pathname === `${ROUTE_PREFIX}/api/pair` && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          pairUrl: pairUrl(),
          pairCandidates: pairCandidates(),
          token: state.token,
        })
      }

      if (pathname === `${ROUTE_PREFIX}/api/tunnel` && method === 'POST') {
        // Tunnels were removed: Tailscale is how the phone reaches the PC now.
        // Keep the route answering so an older Settings panel gets a clear reply
        // instead of a 404.
        await readJson(req)
        return sendJson(res, 200, { ...adminStatus(), message: '隧道已移除，请用 Tailscale 连接' })
      }

      // One-click repair for the one failure an otherwise correct pairing cannot
      // survive: the web server accepted loopback only. Whoever is looking at the
      // panel already has local admin rights, so no extra gate is needed beyond
      // the `admin` check above.
      if (pathname === `${ROUTE_PREFIX}/api/fix-host` && method === 'POST') {
        await readJson(req)
        if (!admin) {
          return sendJson(res, 403, { ok: false, error: 'local admin only' })
        }
        if (!bridge.tunnel.loopbackOnly()) {
          return sendJson(res, 200, {
            ok: true,
            changed: false,
            message: '当前已经不是只监听本机，无需修改。',
            status: adminStatus(),
          })
        }
        const file = patchFile()
        if (file === '') {
          // Naming the paths is the difference between a dead end and a fix: the
          // user can copy the target path straight into their editor.
          const found = profileDirs().map((dir) => path.basename(dir))
          return sendJson(res, 200, {
            ok: false,
            changed: false,
            error:
              found.length > 0
                ? `无法确定当前使用哪个 profile（发现：${found.join('、')}）。请手动把 webServer 的 host 改成 0.0.0.0，文件在 ${path.join(profileRoot(), '<profile>', 'cordis.patch.yml')}`
                : `没有找到 DSH 的 profile 目录（${profileRoot()}）。请手动把 webServer 的 host 改成 0.0.0.0。`,
          })
        }
        let original = ''
        try {
          original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        } catch (error) {
          return sendJson(res, 200, {
            ok: false,
            changed: false,
            error: `读取配置失败：${error && error.message ? error.message : error}`,
            file,
          })
        }
        const edit = ensureWildcardHost(original, webserverServiceName(ctx))
        if (!edit.ok) {
          return sendJson(res, 200, {
            ok: false,
            changed: false,
            error: `无法自动修改（${edit.mode}）。请手动把 webServer 的 host 改成 0.0.0.0。`,
            file,
          })
        }
        if (edit.changed) {
          try {
            if (fs.existsSync(file)) {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-')
              fs.copyFileSync(file, `${file}.phone-bridge-${stamp}.bak`)
            }
            fs.writeFileSync(file, edit.text, 'utf8')
          } catch (error) {
            return sendJson(res, 200, {
              ok: false,
              changed: false,
              error: `写入配置失败：${error && error.message ? error.message : error}`,
              file,
            })
          }
        }
        LOG(ctx, 'info', `[phone-bridge] webServer host patched (${edit.mode}) in ${file}`)
        return sendJson(res, 200, {
          ok: true,
          changed: edit.changed,
          mode: edit.mode,
          file,
          message: '已改成监听所有网卡。请完全退出 DSH 再重新打开，改动才会生效。',
          status: adminStatus(),
        })
      }

      if (pathname === `${ROUTE_PREFIX}/api/prefs` && method === 'POST') {
        const body = await readJson(req)
        if (typeof body.defaultShowThinking === 'boolean') {
          state.defaultShowThinking = body.defaultShowThinking
        }
        if (typeof body.cwd === 'string' && body.cwd.trim()) {
          state.cwd = body.cwd.trim()
        }
        if (body.newSession === true) {
          state.sessionId = null
        }
        if (typeof body.sessionId === 'string' && body.sessionId.trim()) {
          state.sessionId = body.sessionId.trim()
          bridge.stopFollower()
        }
        saveState(state)
        return sendJson(res, 200, adminStatus())
      }

      if (pathname === `${ROUTE_PREFIX}/api/send` && method === 'POST') {
        const body = await readJson(req)
        const showThinking =
          typeof body.showThinking === 'boolean' ? body.showThinking : state.defaultShowThinking
        const { job, sessionId } = await bridge.send({
          text: typeof body.text === 'string' ? body.text : '',
          images: body.images,
          showThinking,
        })
        return sendJson(res, 200, { ok: true, job: job.id, sessionId, status: job.status })
      }

      if (pathname === `${ROUTE_PREFIX}/api/poll` && method === 'GET') {
        const id = url.searchParams.get('job') || ''
        const job = bridge.job(id)
        if (!job) return sendJson(res, 404, { ok: false, error: 'job not found' })
        return sendJson(res, 200, Object.assign({ ok: true }, jobView(job)))
      }

      if (pathname === `${ROUTE_PREFIX}/api/jobs` && method === 'GET') {
        const items = []
        for (const job of bridge.jobs.values()) items.push(jobView(job))
        items.sort((a, b) => b.updatedAt - a.updatedAt)
        return sendJson(res, 200, { ok: true, items: items.slice(0, 20) })
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      const status = typeof err === 'object' && err && err.status ? err.status : 500
      const message = String((err && err.message) || err)
      LOG(ctx, 'warn', `${method} ${pathname} failed: ${message}`)
      return sendJson(res, status, { ok: false, error: message })
    }
  }

  // A failed registration must not take the whole plugin (or the boot) down.
  let dispose
  try {
    dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle })
  } catch (err) {
    LOG(ctx, 'error', `route registration failed: ${String((err && err.message) || err)}`)
    LOG(ctx, 'error', `another plugin already owns ${ROUTE_PREFIX}; phone-bridge stays inactive`)
    return
  }
  ctx.effect(() => () => {
    try {
      dispose()
    } catch {
      /* ignore */
    }
    bridge.stopFollower()
  })

  LOG(ctx, 'info', `ready at ${ROUTE_PREFIX} (port ${bridge.tunnel.port()})`)
}

export default { name, inject, apply }
