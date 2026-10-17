// Renders the pairing QR to a PNG using the vendored generator, so the image
// can be printed or shown on screen without a browser.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const qr = require('../vendor/qrcode.cjs')

const payload = process.argv[2]
const out = process.argv[3] || 'pair-qr.png'
if (!payload) {
  console.error('usage: node render-qr.mjs <payload> [out.png]')
  process.exit(2)
}

const code = qr(0, 'M')
code.addData(payload)
code.make()

const count = code.getModuleCount()
const scale = 8
const quiet = 4
const size = (count + quiet * 2) * scale

// Minimal 1-bit PNG writer: black/white paletted rows, no dependencies.
const raw = Buffer.alloc((size + 1) * size * 3)
let o = 0
for (let y = 0; y < size; y++) {
  raw[o++] = 0 // filter: none
  const my = Math.floor(y / scale) - quiet
  for (let x = 0; x < size; x++) {
    const mx = Math.floor(x / scale) - quiet
    const dark =
      mx >= 0 && my >= 0 && mx < count && my < count && code.isDark(my, mx)
    const v = dark ? 0 : 255
    raw[o++] = v
    raw[o++] = v
    raw[o++] = v
  }
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0)
ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // truecolor
const zlib = await import('node:zlib')
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, png)
console.log(`wrote ${out} (${size}x${size}, ${png.length} bytes)`)
console.log(`payload: ${payload}`)
