/**
 * Deterministic icon generation for the DSH Bot PWA shell.
 *
 * The workbench has no image toolchain, so the install icons are drawn here with
 * analytic anti-aliasing and encoded as PNG using only `node:zlib`. Same input,
 * same bytes: the build hash stays stable when nothing changed.
 */
import { deflateSync } from 'node:zlib'

const PINK = { r: 226, g: 61, b: 138 }
const WHITE = { r: 255, g: 255, b: 255 }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const body = Buffer.concat([head.subarray(4), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, data, crc])
}

/** Encode 8-bit RGBA pixels as a PNG. */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('encodePng: unexpected pixel buffer length')
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Coverage of a signed distance field, in pixels. Negative is inside. */
function coverage(sdf, aa = 1) {
  return clamp01(0.5 - sdf / aa)
}

function roundedRectSdf(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius)
  const qy = Math.abs(y - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

function circleSdf(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius
}

function blend(pixels, index, color, alpha) {
  if (alpha <= 0) return
  const offset = index * 4
  const srcA = (alpha * (color.a ?? 255)) / 255
  const dstA = pixels[offset + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) return
  pixels[offset] = Math.round((color.r * srcA + pixels[offset] * dstA * (1 - srcA)) / outA)
  pixels[offset + 1] = Math.round((color.g * srcA + pixels[offset + 1] * dstA * (1 - srcA)) / outA)
  pixels[offset + 2] = Math.round((color.b * srcA + pixels[offset + 2] * dstA * (1 - srcA)) / outA)
  pixels[offset + 3] = Math.round(outA * 255)
}

/** Eyes and a smile drawn as dots, matching the workbench's presence faces. */
function faceDots(size, maskable) {
  const unit = size * (maskable ? 0.62 : 0.72)
  const cx = size / 2
  const cy = size / 2
  const eyeY = cy - unit * 0.1
  const dots = [
    { x: cx - unit * 0.27, y: eyeY, r: unit * 0.095 },
    { x: cx + unit * 0.27, y: eyeY, r: unit * 0.095 },
  ]
  const smileRadius = unit * 0.3
  const smileCy = cy + unit * 0.02
  for (let index = 0; index < 5; index += 1) {
    const angle = ((25 + index * (130 / 4)) * Math.PI) / 180
    dots.push({
      x: cx + Math.cos(angle) * smileRadius,
      y: smileCy + Math.sin(angle) * smileRadius,
      r: unit * 0.05,
    })
  }
  return dots
}

/**
 * @param {number} size square edge in pixels
 * @param {{ maskable?: boolean }} [options] maskable keeps the face inside Android's safe zone
 */
export function drawIcon(size, options = {}) {
  const maskable = options.maskable === true
  const pixels = Buffer.alloc(size * size * 4)
  const radius = maskable ? 0 : size * 0.225
  const dots = faceDots(size, maskable)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x
      const px = x + 0.5
      const py = y + 0.5
      const plate = maskable ? 1 : coverage(roundedRectSdf(px, py, size / 2, size / 2, size / 2, size / 2, radius))
      if (plate <= 0) continue
      blend(pixels, index, PINK, plate)
      for (const dot of dots) {
        blend(pixels, index, WHITE, coverage(circleSdf(px, py, dot.x, dot.y, dot.r), 1.15))
      }
    }
  }
  return pixels
}

/** Markup for `/dsh-bot/favicon.svg`, the same shape as the raster icons. */
export function faviconSvg(size = 64) {
  const dots = faceDots(size, false)
  const circles = dots
    .map(dot => `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="${dot.r.toFixed(2)}"/>`)
    .join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
    `<rect width="${size}" height="${size}" rx="${(size * 0.225).toFixed(2)}" fill="#e23d8a"/>`,
    `<g fill="#fff">${circles}</g>`,
    `</svg>`,
    '',
  ].join('')
}

/** Every icon the manifest and Apple touch metadata point at. */
export function shellIcons() {
  return [
    { path: 'icons/icon-192.png', size: 192, maskable: false },
    { path: 'icons/icon-512.png', size: 512, maskable: false },
    { path: 'icons/icon-maskable-512.png', size: 512, maskable: true },
    { path: 'icons/apple-touch-icon-180.png', size: 180, maskable: true },
  ].map(icon => ({
    ...icon,
    png: encodePng(icon.size, icon.size, drawIcon(icon.size, { maskable: icon.maskable })),
  }))
}
