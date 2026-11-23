/** Minimal POSIX ustar writer for a two-file snapshot archive. No third-party zip dependency. */

function tarHeader(name: string, size: number, mtime: number): Buffer {
  const buf = Buffer.alloc(512, 0)
  const write = (offset: number, value: string, length: number) => {
    buf.write(value.slice(0, length), offset, 'utf8')
  }
  write(0, name, 100)
  write(100, '0000644\0', 8)
  write(108, '0000000\0', 8)
  write(116, '0000000\0', 8)
  write(124, `${size.toString(8).padStart(11, '0')}\0`, 12)
  write(136, `${Math.max(0, Math.floor(mtime)).toString(8).padStart(11, '0')}\0`, 12)
  write(148, '        ', 8)
  buf[156] = 0x30 // file
  write(257, 'ustar\0', 6)
  write(263, '00', 2)
  let checksum = 0
  for (const byte of buf) checksum += byte
  write(148, `${checksum.toString(8).padStart(6, '0')}\0 `, 8)
  return buf
}

function pad512(bytes: Buffer): Buffer {
  const rem = bytes.length % 512
  if (rem === 0) return bytes
  return Buffer.concat([bytes, Buffer.alloc(512 - rem)])
}

export function packUstar(files: readonly { name: string; body: Buffer; mtime?: number }[]): Buffer {
  const parts: Buffer[] = []
  const mtime = Math.floor(Date.now() / 1000)
  for (const file of files) {
    if (file.name.length > 100) throw new Error(`tar name too long: ${file.name}`)
    parts.push(tarHeader(file.name, file.body.length, file.mtime ?? mtime))
    parts.push(pad512(file.body))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
