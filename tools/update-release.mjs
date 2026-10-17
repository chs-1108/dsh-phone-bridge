// Updates a GitHub release body without going through PowerShell's JSON
// serialiser. `ConvertTo-Json` + `Invoke-RestMethod -ContentType 'application/json'`
// sent the Chinese text as escaped code points that GitHub then decoded as
// Latin-1, turning the whole release page into question marks.
//
// Here the body is read as UTF-8, JSON-escaped by hand (only the characters JSON
// actually requires), and sent as an explicit UTF-8 byte array.
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import os from 'node:os'

const [, , notesPath, releaseIdArg] = process.argv
const releaseId = releaseIdArg || '415637924'

const authPath = path.join(os.homedir(), '.dsh', 'github-ops-auth.json')
const token = JSON.parse(fs.readFileSync(authPath, 'utf8')).token

const markdown = fs.readFileSync(notesPath, 'utf8')

// Sanity: refuse to publish if the source itself is not clean UTF-8.
if (markdown.includes('\uFFFD')) {
  console.error('FAIL  source contains U+FFFD replacement characters')
  process.exit(1)
}
if (!/[\u4e00-\u9fff]/.test(markdown)) {
  console.error('FAIL  source contains no CJK - the read may have decoded wrongly')
  process.exit(1)
}

const payload = Buffer.from(JSON.stringify({ body: markdown }), 'utf8')

const options = {
  hostname: 'api.github.com',
  path: `/repos/chs-1108/dsh-phone-bridge/releases/${releaseId}`,
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'dsh',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  },
}

const req = https.request(options, (res) => {
  const chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    if (res.statusCode !== 200) {
      console.error(`FAIL  HTTP ${res.statusCode}`)
      console.error(text.slice(0, 400))
      process.exit(1)
    }
    const body = JSON.parse(text)
    // Read the value back from the API response, not from our own variable:
    // that is what visitors will actually see.
    const roundTrip = body.body || ''
    const hasCJK = /[\u4e00-\u9fff]/.test(roundTrip)
    const hasReplacement = roundTrip.includes('\uFFFD')
    console.log(`HTTP 200  body=${roundTrip.length} chars`)
    console.log(`round-trip CJK     : ${hasCJK ? 'yes' : 'NO'}`)
    console.log(`round-trip U+FFFD  : ${hasReplacement ? 'YES' : 'no'}`)
    if (!hasCJK || hasReplacement) {
      console.error('FAIL  the stored body did not survive the round trip')
      process.exit(1)
    }
    console.log('\n--- first 200 chars as stored ---')
    console.log(roundTrip.slice(0, 200))
    console.log('\nRELEASE BODY OK')
  })
})

req.on('error', (e) => {
  console.error(`FAIL  ${e.message}`)
  process.exit(1)
})
req.write(payload)
req.end()
