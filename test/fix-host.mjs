// The one-click repair edits a file the user maintains by hand, so the rewrite
// is exercised against every shape it is expected to meet - and against shapes it
// must refuse rather than corrupt. The helper is not exported from index.js, so
// it is lifted out of the source and evaluated here. That keeps the test honest:
// if the function is renamed or its contract changes, this fails loudly.
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')

const start = source.indexOf('function webserverRow(')
const end = source.indexOf('/** The service name the running DSH uses')
if (start === -1 || end === -1) {
  console.error('FAIL  could not locate the patch helpers in index.js')
  process.exit(1)
}

// `ensureWildcardHost` calls `webserverRow`, so both come along.
const body = source.slice(start, end)
const ensureWildcardHost = new Function(`${body}; return ensureWildcardHost`)()

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`PASS  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

const NAME = '@deepseek-ai/dsh-host-webserver'

// --- 1. no webserver entry: append a complete one -----------------------------
{
  const before = '# my profile\n- id: phone-bridge\n  name: dsh-phone-bridge\n'
  const r = ensureWildcardHost(before, NAME)
  check('append: reports a change', r.ok === true && r.changed === true, r.mode)
  check('append: keeps existing content', r.text.startsWith(before))
  check('append: adds the id', /^-\s+id:\s*webserver$/m.test(r.text))
  check('append: sets the wildcard host', /host:\s*'0\.0\.0\.0'/.test(r.text))
  check('append: restates compression', /compression:\s*gzip/.test(r.text))
  check('append: keeps the !!js tag', /!!js ctx\.webStartup\.port/.test(r.text))
  check('append: uses the given service name', r.text.includes(NAME))
}

// --- 2. entry exists with a loopback host: replace just that line -------------
{
  const before = [
    '- id: webserver',
    `  name: '${NAME}'`,
    '  inject: [webStartup]',
    '  config:',
    "    host: '127.0.0.1'",
    '    port: !!js ctx.webStartup.port ?? 3080',
    '    compression: gzip',
    '- id: tool-plugin-manager',
    '  disabled: false',
    '',
  ].join('\n')
  const r = ensureWildcardHost(before, NAME)
  check('replace: reports a change', r.ok === true && r.changed === true, r.mode)
  check('replace: host becomes wildcard', /host:\s*'0\.0\.0\.0'/.test(r.text))
  check('replace: loopback is gone', !r.text.includes("'127.0.0.1'"))
  check('replace: other keys survive', r.text.includes('port: !!js ctx.webStartup.port'))
  check('replace: comments of the next entry survive', r.text.includes('- id: tool-plugin-manager'))
  check(
    'replace: only one line changed',
    r.text.split('\n').length === before.split('\n').length,
    `${before.split('\n').length} -> ${r.text.split('\n').length}`,
  )
}

// --- 3. entry exists without a host line: insert one inside config ------------
{
  const before = [
    '- id: webserver',
    `  name: '${NAME}'`,
    '  config:',
    '    compression: gzip',
    '    compressionLevel: 1',
    '- id: ui-chat',
    '  config:',
    '    transcriptView: standard',
    '',
  ].join('\n')
  const r = ensureWildcardHost(before, NAME)
  check('insert: reports a change', r.ok === true && r.changed === true, r.mode)
  check('insert: host lands inside webserver config', /host:\s*'0\.0\.0\.0'/.test(r.text))
  const lines = r.text.split('\n')
  const hostAt = lines.findIndex((l) => /host:/.test(l))
  const nextAt = lines.findIndex((l) => l === '- id: ui-chat')
  check('insert: does not leak into the next entry', hostAt !== -1 && hostAt < nextAt, `${hostAt} < ${nextAt}`)
  check('insert: keeps the existing config keys', r.text.includes('compressionLevel: 1'))
}

// --- 4. already wildcard: no change, no write --------------------------------
{
  const before = [
    '- id: webserver',
    `  name: '${NAME}'`,
    '  config:',
    "    host: '0.0.0.0'",
    '    compression: gzip',
    '',
  ].join('\n')
  const r = ensureWildcardHost(before, NAME)
  check('noop: reports no change', r.ok === true && r.changed === false, r.mode)
  check('noop: text is byte-identical', r.text === before)
}

// --- 5. double-quoted and bare forms are recognised as already set -----------
{
  for (const form of ['0.0.0.0', '"0.0.0.0"']) {
    const before = `- id: webserver\n  config:\n    host: ${form}\n`
    const r = ensureWildcardHost(before, NAME)
    check(`noop: ${form} counts as set`, r.changed === false, r.mode)
  }
}

// --- 6. traps -----------------------------------------------------------------
{
  // A `host:` line for a different service must not be mistaken for ours.
  const otherHost = [
    '- id: llm-openai',
    '  config:',
    "    host: '127.0.0.1'",
    '- id: webserver',
    '  inject: [webStartup]',
    '  config:',
    '    compression: gzip',
    '',
  ].join('\n')
  const r = ensureWildcardHost(otherHost, NAME)
  check('trap: unrelated host untouched', r.text.includes('host: ' + "'127.0.0.1'"))
  check('trap: our host still added', (r.text.match(/0\.0\.0\.0/g) || []).length === 1)

  // An entry with no config block cannot be patched safely; refuse it.
  const noConfig = `- id: webserver\n  name: '${NAME}'\n  inject: [webStartup]\n`
  const bad = ensureWildcardHost(noConfig, NAME)
  check('trap: no config block is refused', bad.ok === false, bad.mode)
  check('trap: refused text is unchanged', bad.text === noConfig)

  // CRLF files must not accumulate blank lines.
  const crlf = '- id: webserver\r\n  config:\r\n    host: \'127.0.0.1\'\r\n'
  const cr = ensureWildcardHost(crlf, NAME)
  check('trap: crlf input still patches', cr.ok === true && cr.changed === true)

  // Empty file: a fresh profile.
  const empty = ensureWildcardHost('', NAME)
  check('trap: empty file gets a block', empty.ok === true && empty.changed === true, empty.mode)
  check('trap: empty file output parses as a list item', /^-\s+id:\s*webserver/m.test(empty.text))
}

if (failures > 0) {
  console.log(`\n${failures} FIX-HOST CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL FIX-HOST CHECKS PASSED')
