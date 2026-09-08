/**
 * Text -> QR matrix, plus the bit-packing used to ship a matrix inside a QRSpec.
 */
import QRCode from 'qrcode'
import type { ECLevel, Encoded, QRSpec } from './spec'

/** Matrix width in modules for a version, quiet zone excluded. */
export const symbolSize = (version: number) => version * 4 + 17

/**
 * A decoded matrix. `get` is the only accessor the renderer needs -- reserved
 * cells come from geometry.ts so that the browser and the Python API derive them
 * the same way, from the same rules.
 */
export interface Matrix {
  size: number
  version: number
  maskPattern: number
  get(row: number, col: number): boolean
}

function packBits(size: number, get: (r: number, c: number) => boolean): string {
  const bytes = new Uint8Array(Math.ceil((size * size) / 8))
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!get(r, c)) continue
      const i = r * size + c
      bytes[i >> 3] |= 0x80 >> (i & 7)
    }
  }
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unpackBits(size: number, b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const need = Math.ceil((size * size) / 8)
  if (bytes.length < need) throw new Error(`encoded.bits too short: ${bytes.length} < ${need}`)
  return bytes
}

/** node-qrcode types this 0..7 union; we validate the number at the boundary instead. */
type MaskPattern = NonNullable<Parameters<typeof QRCode.create>[1]>['maskPattern']

/** Encode text into a matrix. Pass `maskPattern` to reproduce an earlier encode exactly. */
export function encode(text: string, ecLevel: ECLevel, maskPattern?: number): Encoded {
  const qr = QRCode.create(text || ' ', {
    errorCorrectionLevel: ecLevel,
    ...(maskPattern === undefined ? {} : { maskPattern: maskPattern as MaskPattern }),
  })
  // Every renderer must reproduce this exact mask, so an unknown one is fatal
  // rather than something to paper over with a default.
  if (typeof qr.maskPattern !== 'number') {
    throw new Error('qrcode did not report a mask pattern; cannot guarantee render parity')
  }
  const size = qr.modules.size
  return {
    version: qr.version,
    maskPattern: qr.maskPattern,
    size,
    bits: packBits(size, (r, c) => Boolean(qr.modules.get(r, c))),
  }
}

export function matrixFromEncoded(enc: Encoded): Matrix {
  const { size, version, maskPattern } = enc
  const bytes = unpackBits(size, enc.bits)
  return {
    size,
    version,
    maskPattern,
    get(r, c) {
      if (r < 0 || c < 0 || r >= size || c >= size) return false
      const i = r * size + c
      return (bytes[i >> 3] & (0x80 >> (i & 7))) !== 0
    },
  }
}

/**
 * The matrix for a spec. `spec.encoded` wins when present -- it is the browser's
 * own encode result travelling with the design so every renderer draws the same
 * bits. Only re-encode when it is absent (direct API use).
 */
export function matrixFor(spec: QRSpec): Matrix {
  const enc = spec.encoded ?? encode(spec.content.text, spec.content.ecLevel)
  return matrixFromEncoded(enc)
}
