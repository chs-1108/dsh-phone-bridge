/**
 * phone-bridge — Host half.
 *
 * Bridges a phone (on ANY network, reached through a cloudflared quick tunnel)
 * to this Harness process:
 *
 *   phone --HTTPS--> cloudflared --> webServer(/phone-bridge/*) --> sessionController
 *
 * The phone sends text and/or photos; the Agent answer is streamed back.
 * By default the phone receives only the final answer; a per-send flag
 * (and a persisted default) also returns the reasoning stream.
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
  if (typeof raw.cloudflaredPath !== 'string' || raw.cloudflaredPath === '') raw.cloudflaredPath = null
  if (typeof raw.defaultShowThinking !== 'boolean') raw.defaultShowThinking = false
  if (typeof raw.lastTunnelUrl !== 'string') raw.lastTunnelUrl = null
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

/** cloudflared proxies from 127.0.0.1, so its own markers identify remote traffic. */
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

/* --------------------------------------------------------------- cloudflared */

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi

class Tunnel {
  constructor(getCtx, state) {
    this.ctx = () => getCtx()
    this.state = state
    this.child = null
    this.url = state.lastTunnelUrl || null
    this.status = 'stopped' // stopped | starting | running | error
    this.error = null
    this.log = []
    this.startedAt = null
  }

  snapshot() {
    return {
      status: this.status,
      url: this.url,
      error: this.error,
      startedAt: this.startedAt,
      pid: this.child && this.child.pid ? this.child.pid : null,
      executable: this.executable(),
      tail: this.log.slice(-12).join('\n'),
    }
  }

  executable() {
    if (this.state.cloudflaredPath) return this.state.cloudflaredPath
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'cloudflared.exe')
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

  note(line) {
    if (typeof line !== 'string' || line === '') return
    this.log.push(line.replace(/\s+$/, '').slice(0, 400))
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200)
  }

  start() {
    if (this.child) return this.snapshot()
    const exe = this.executable()
    if (!fs.existsSync(exe)) {
      this.status = 'error'
      this.error = `cloudflared 未找到：${exe}`
      return this.snapshot()
    }
    const port = this.port()
    this.status = 'starting'
    this.error = null
    this.startedAt = Date.now()
    this.log = []
    this.note(`spawn ${exe} tunnel --no-autoupdate --url http://127.0.0.1:${port}`)
    let child
    try {
      child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.status = 'error'
      this.error = String((err && err.message) || err)
      return this.snapshot()
    }
    this.child = child

    const consume = (buf) => {
      const text = buf.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.note(line)
        const found = line.match(QUICK_TUNNEL_RE)
        if (found && found.length > 0) {
          const url = found[0].replace(/\/+$/, '')
          if (url !== this.url) {
            this.url = url
            this.state.lastTunnelUrl = url
            saveState(this.state)
            LOG(this.ctx(), 'info', `tunnel url ${url}`)
          }
          this.status = 'running'
        }
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.on('error', (err) => {
      this.status = 'error'
      this.error = String((err && err.message) || err)
      this.child = null
    })
    child.on('exit', (code) => {
      this.note(`cloudflared exited code=${code}`)
      if (this.status !== 'stopped') {
        this.status = code === 0 ? 'stopped' : 'error'
        if (code !== 0) this.error = `cloudflared 退出码 ${code}`
      }
      this.child = null
      this.startedAt = null
    })
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
  if (cfg.cloudflaredPath && typeof cfg.cloudflaredPath === 'string' && !state.cloudflaredPath) {
    state.cloudflaredPath = cfg.cloudflaredPath
    saveState(state)
  }
  if (typeof cfg.defaultShowThinking === 'boolean') state.defaultShowThinking = cfg.defaultShowThinking

  const bridge = new Bridge(ctx, state)

  const pairUrl = () => {
    const base = state.lastTunnelUrl || ''
    if (!base) return ''
    return `${base}${ROUTE_PREFIX}/#t=${state.token}`
  }

  const adminStatus = () => ({
    ok: true,
    version: 1,
    tunnel: bridge.tunnel.snapshot(),
    pairUrl: pairUrl(),
    sessionId: state.sessionId,
    cwd: state.cwd || process.cwd(),
    defaultShowThinking: state.defaultShowThinking,
    token: state.token,
    hasQr: qrSvg('x') !== null,
  })

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    const rest = pathname.slice(ROUTE_PREFIX.length) || '/'

    // Anywhere-public liveness probe: lets the phone validate the URL before pairing.
    if (pathname === `${ROUTE_PREFIX}/health`) {
      return sendJson(res, 200, { ok: true, name: 'phone-bridge', version: 1 })
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
        return sendJson(res, 200, { ok: true, pairUrl: pairUrl(), token: state.token })
      }

      if (pathname === `${ROUTE_PREFIX}/api/tunnel` && method === 'POST') {
        const body = await readJson(req)
        const action = String(body.action || '')
        if (action === 'start') {
          const auto = bridge.tunnel.status === 'stopped'
          bridge.tunnel.start()
          if (auto) {
            // wait up to 30s for the quick-tunnel hostname
            const deadline = Date.now() + 30000
            while (bridge.tunnel.status === 'starting' && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 400))
            }
          }
        } else if (action === 'stop') {
          bridge.tunnel.stop()
        } else {
          return sendJson(res, 400, { ok: false, error: 'action must be start|stop' })
        }
        return sendJson(res, 200, adminStatus())
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
    bridge.tunnel.stop()
  })

  if (cfg.autoStart !== false) {
    try {
      bridge.tunnel.start()
    } catch {
      /* ignore */
    }
  }

  LOG(ctx, 'info', `ready at ${ROUTE_PREFIX} (port ${bridge.tunnel.port()})`)
}

export default { name, inject, apply }
