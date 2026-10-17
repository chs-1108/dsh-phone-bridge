// Standalone harness: mounts the Host half with a stub ctx and exercises the
// HTTP routes over a real socket. Verifies the module without restarting DSH.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Redirect the module's state directory before importing it. index.js writes
// state.json on boot and after every prefs change, so without this the harness
// overwrote the token and session binding of the live installation.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-bridge-test-'))
process.env.DSH_HOME = sandboxHome
process.on('exit', () => {
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true })
  } catch {
    // best effort; a leftover temp dir is harmless
  }
})

const { apply } = await import('../index.js')

const routes = []
const effects = []
let registered = null

// A scripted turn driven through follow() so the job state machine is exercised.
let capturedPrompt = null
let followSignal = null
let releaseTurn = null
const turnGate = new Promise((resolve) => {
  releaseTurn = resolve
})

const ctx = {
  logger: {
    info: (m) => console.log('[info]', m),
    warn: (m) => console.log('[warn]', m),
    error: (m) => console.log('[error]', m),
  },
  webServer: {
    port: 0,
    // DSH defaults to loopback; the stub mirrors that so the diagnostics that
    // warn about it are actually exercised.
    host: '127.0.0.1',
    register(route) {
      registered = route
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    get port() {
      return server.address() ? server.address().port : 0
    },
  },
  effect(fn) {
    effects.push(fn)
  },
  sessionController: {
    async list(_request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      return {
        items: [
          {
            sessionId: 'session-aaa',
            running: false,
            updatedAt: 1,
            cwd: 'C:\\work',
            projections: { kind: 'cached', asOfSeq: 3, values: { title: '示例会话' } },
          },
          { sessionId: 'session-bbb', running: true, updatedAt: 2, origin: 'subagent' },
        ],
      }
    },
    async inspect(id, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      if (id === 'session-aaa') return { events: [] }
      throw new Error('not found')
    },
    async create() {
      return { sessionId: 'session-created' }
    },
    async prompt(request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      capturedPrompt = request
      return { accepted: true }
    },
    follow(_request, signal) {
      followSignal = signal
      return (async function* () {
        yield {
          type: 'event',
          event: { type: 'turn/start', seq: 10, time: Date.now(), data: { turn: 7 } },
        }
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'chunk',
            attemptId: 'a1',
            revision: 1,
            index: 0,
            time: Date.now(),
            chunk: { type: 'reasoning-delta', index: 0, text: '先想一想…' },
          },
        }
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'chunk',
            attemptId: 'a1',
            revision: 1,
            index: 1,
            time: Date.now(),
            chunk: { type: 'text-delta', index: 1, text: '答案是 ' },
          },
        }
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'chunk',
            attemptId: 'a1',
            revision: 1,
            index: 2,
            time: Date.now(),
            chunk: { type: 'text-delta', index: 1, text: '2。' },
          },
        }
        await turnGate
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 11,
            time: Date.now(),
            data: {
              turn: 7,
              step: 1,
              message: {
                id: 'm1',
                role: 'assistant',
                source: { kind: 'model', provider: 'stub', model: 'stub' },
                content: [
                  { type: 'reasoning', text: '先想一想…' },
                  { type: 'text', text: '答案是 2。' },
                ],
              },
              stream: [
                { type: 'reasoning-chunks', time0: 0, index: 0, dt: [1], texts: ['先想一想…'] },
                { type: 'text-chunks', time0: 1, index: 1, dt: [1, 1], texts: ['答案是 ', '2。'] },
              ],
            },
          },
        }
        yield {
          type: 'event',
          event: {
            type: 'turn/end',
            seq: 12,
            time: Date.now(),
            data: { turn: 7, reason: { kind: 'completed' } },
          },
        }
      })()
    },
  },
}

apply(ctx, { autoStart: false })

const server = http.createServer((req, res) => {
  const route = routes.find((r) => {
    if (r.kind === 'exact') return req.url.split('?')[0] === r.path
    return req.url === r.path || req.url.startsWith(r.path + '/')
  })
  if (!route) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    res.writeHead(500)
    res.end(String(err))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

const health = await fetch(`${base}/phone-bridge/health`).then((r) => r.json())
check('health', health.ok === true && health.name === 'phone-bridge')
// The stub binds 127.0.0.1, which is exactly the situation that used to leave
// users with an unreachable plugin and no explanation.
check('health reports the bound host', health.boundHost === '127.0.0.1', health.boundHost)
check('health flags loopback-only binding', health.loopbackOnly === true)

const html = await fetch(`${base}/phone-bridge/`).then(async (r) => ({
  status: r.status,
  type: r.headers.get('content-type'),
  text: await r.text(),
}))
check(
  'app html served',
  html.status === 200 && html.type.includes('text/html') && html.text.includes('DSH 手机同步'),
  `status=${html.status} type=${html.type} len=${html.text.length}`,
)

const noSlash = await fetch(`${base}/phone-bridge`)
const noSlashText = await noSlash.text()
check('app html at bare prefix', noSlash.status === 200 && noSlashText.includes('<!DOCTYPE html>'))

const statusAuth = await fetch(`${base}/phone-bridge/api/status`).then((r) => r.status)
check('status is local-admin authorized', statusAuth === 200, `code=${statusAuth}`)

const sessions = await fetch(`${base}/phone-bridge/api/sessions`).then((r) => r.json())
check(
  'sessions endpoint',
  sessions.ok === true && sessions.items.length === 1 && sessions.items[0].sessionId === 'session-aaa',
  JSON.stringify(sessions.items),
)

const qr = await fetch(`${base}/phone-bridge/qr.svg`).then(async (r) => ({
  status: r.status,
  type: r.headers.get('content-type'),
  text: await r.text(),
}))
check('qr.svg', qr.status === 200 && qr.text.startsWith('<svg'), `status=${qr.status}`)

const badPrefs = await fetch(`${base}/phone-bridge/api/prefs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-aaa' }),
}).then((r) => r.json())
check('prefs sets sessionId', badPrefs.sessionId === 'session-aaa')

const send = await fetch(`${base}/phone-bridge/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello from phone', showThinking: false }),
}).then((r) => r.json())
check('send accepts text', send.ok === true && typeof send.job === 'string', JSON.stringify(send))

const emptySend = await fetch(`${base}/phone-bridge/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '   ', images: [] }),
}).then(async (r) => ({ status: r.status, body: await r.json() }))
check('send rejects empty content', emptySend.status === 400, JSON.stringify(emptySend.body))

const poll = await fetch(`${base}/phone-bridge/api/poll?job=${send.job}`).then((r) => r.json())
check(
  'poll returns the job',
  poll.ok === true && poll.job === send.job && ['queued', 'running'].includes(poll.status),
  `status=${poll.status}`,
)

// --- the scripted turn -------------------------------------------------------
check(
  'prompt carried the phone text',
  capturedPrompt && capturedPrompt.sessionId === 'session-aaa' && capturedPrompt.mode === 'queue' &&
    capturedPrompt.content.length === 1 && capturedPrompt.content[0].text === 'hello from phone',
  JSON.stringify(capturedPrompt && capturedPrompt.content),
)

// let the scripted turn finish, then poll again
releaseTurn()
await new Promise((r) => setTimeout(r, 200))

const finished = await fetch(`${base}/phone-bridge/api/poll?job=${send.job}`).then((r) => r.json())
check(
  'turn completed with durable text',
  finished.status === 'done' && finished.final === '答案是 2。',
  `status=${finished.status} final=${JSON.stringify(finished.final)}`,
)
check(
  'reasoning suppressed by default',
  finished.reasoning === '',
  `reasoning=${JSON.stringify(finished.reasoning)}`,
)

const sendThink = await fetch(`${base}/phone-bridge/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'with thinking', showThinking: true }),
}).then((r) => r.json())
await new Promise((r) => setTimeout(r, 200))
const finishedThink = await fetch(`${base}/phone-bridge/api/poll?job=${sendThink.job}`).then((r) => r.json())
check(
  'reasoning returned when the toggle is on',
  finishedThink.status === 'done' && finishedThink.reasoning.includes('先想一想'),
  `reasoning=${JSON.stringify(finishedThink.reasoning)}`,
)

// --- image content ----------------------------------------------------------
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const sendImage = await fetch(`${base}/phone-bridge/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: '看这张图',
    images: [{ mediaType: 'image/png', data: `data:image/png;base64,${pngBase64}`, name: 'x.png' }],
  }),
}).then((r) => r.json())
check('send accepts an image', sendImage.ok === true, JSON.stringify(sendImage))
check(
  'image part normalized (data URL stripped, mediaType kept)',
  capturedPrompt.content.length === 2 &&
    capturedPrompt.content[1].type === 'image' &&
    capturedPrompt.content[1].mediaType === 'image/png' &&
    !capturedPrompt.content[1].data.startsWith('data:'),
  JSON.stringify(capturedPrompt.content.map((c) => c.type)),
)

// --- sessions endpoint shape -------------------------------------------------
check(
  'subagent session filtered out and label resolved',
  sessions.items.length === 1 && sessions.items[0].label === '示例会话',
  JSON.stringify(sessions.items),
)
check('sessions used the required signal', followSignal !== null, 'follow received a signal')

const notFound = await fetch(`${base}/phone-bridge/api/nope`).then((r) => r.status)
check('unknown route 404', notFound === 404)

// A foreign token from the tunnel must be rejected: cloudflared marks remote
// traffic with cf-* / x-forwarded-* headers, which defeats the loopback admin path.
const tunneledBad = await fetch(`${base}/phone-bridge/api/status`, {
  headers: {
    authorization: 'Bearer 000000000000000000000000000000000000000000000000',
    'cf-connecting-ip': '203.0.113.9',
  },
}).then((r) => r.status)
check('tunneled bad token rejected', tunneledBad === 401, `code=${tunneledBad}`)

const tunneledNoToken = await fetch(`${base}/phone-bridge/api/status`, {
  headers: { 'x-forwarded-for': '203.0.113.9' },
}).then((r) => r.status)
check('tunneled no token rejected', tunneledNoToken === 401, `code=${tunneledNoToken}`)

const tunneledHealth = await fetch(`${base}/phone-bridge/health`, {
  headers: { 'cf-connecting-ip': '203.0.113.9' },
}).then((r) => r.status)
check('tunneled health stays public', tunneledHealth === 200, `code=${tunneledHealth}`)

server.close()
for (const effect of effects) {
  const dispose = effect()
  if (typeof dispose === 'function') dispose()
}
console.log('done')
