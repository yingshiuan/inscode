/**
 * Art mode: decide, per module, whether to draw a solid block, a small mark, or
 * leave the artwork alone.
 *
 * A scanner samples the *middle* of each module, so a small mark at each centre
 * carries the data while the artwork stays visible in between. That is also why
 * brightness is measured at the module centre and not averaged over the whole
 * module -- the edges are exactly the part the scanner ignores.
 *
 * The result travels in `spec.art.cells`, so the Python renderer draws these
 * decisions rather than reproducing this sampling bit-for-bit. It can still
 * compute its own for direct API use; the two agree to within a threshold.
 */
import { CellKind, DARK_OK, LIGHT_OK, type QRSpec } from './spec'
import type { Matrix } from './encode'
import { cellKey, finderCells, finderCentres, structuralCells } from './geometry'
import { canvasSize, logoRect } from './layout'

/** Samples per module edge. 3 keeps the centre third addressable, as in the original. */
const SAMPLE_RES = 3

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not decode the image'))
    img.src = src
  })
}

/**
 * Luminance under every module, at SAMPLE_RES x SAMPLE_RES per module.
 * `light` is what shows through where the artwork is transparent -- on a
 * transparent background that is whatever the code is eventually placed on, which
 * we have to assume is white.
 */
export function sampleLuminance(
  spec: QRSpec,
  matrix: Matrix,
  img: HTMLImageElement,
  light: string,
): Uint8ClampedArray {
  const { quietZone } = spec.canvas
  const total = canvasSize(matrix.size, quietZone)
  const px = total * SAMPLE_RES

  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = light
  ctx.fillRect(0, 0, px, px)

  const aspect = img.naturalWidth / img.naturalHeight || 1
  const rect = logoRect(spec, matrix.size, aspect)
  if (rect) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, rect.x * SAMPLE_RES, rect.y * SAMPLE_RES, rect.w * SAMPLE_RES, rect.h * SAMPLE_RES)
  }

  const { data } = ctx.getImageData(0, 0, px, px)
  const lum = new Uint8ClampedArray(px * px)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Rec. 601 luma, matching PIL's "L" conversion.
    lum[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  }
  return lum
}

/**
 * Per-module draw decisions, row-major over the *code* area (matrix.size^2).
 */
export function decideCells(
  spec: QRSpec,
  matrix: Matrix,
  lum: Uint8ClampedArray | null,
): Uint8Array {
  const { size, version } = matrix
  const { quietZone } = spec.canvas
  const total = canvasSize(size, quietZone)
  const skip = finderCells(size)
  const solid = spec.art.loose ? new Set<number>() : structuralCells(version)

  const out = new Uint8Array(size * size)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c
      const key = cellKey(r, c)
      if (skip.has(key)) {
        out[i] = CellKind.SKIP // finders are drawn as rings, separately
        continue
      }
      const dark = matrix.get(r, c)
      if (solid.has(key)) {
        out[i] = dark ? CellKind.SOLID_DARK : CellKind.SOLID_LIGHT
        continue
      }
      if (!lum) {
        out[i] = dark ? CellKind.MARK_DARK : CellKind.SKIP
        continue
      }
      // Centre sub-cell of this module, on the quiet-zone-inclusive sample grid.
      const sx = (c + quietZone) * SAMPLE_RES + 1
      const sy = (r + quietZone) * SAMPLE_RES + 1
      const L = lum[sy * total * SAMPLE_RES + sx]
      if (dark && L > DARK_OK) out[i] = CellKind.MARK_DARK
      else if (!dark && L < LIGHT_OK) out[i] = CellKind.MARK_LIGHT
      else out[i] = CellKind.SKIP // the artwork already reads correctly here
    }
  }
  return out
}

/** Run-length encode cells to base64: repeating (kind, count) byte pairs. */
export function encodeCells(cells: Uint8Array): string {
  const bytes: number[] = []
  let i = 0
  while (i < cells.length) {
    const kind = cells[i]
    let run = 1
    while (i + run < cells.length && cells[i + run] === kind && run < 255) run++
    bytes.push(kind, run)
    i += run
  }
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function decodeCells(b64: string, count: number): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(count)
  let at = 0
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const kind = bin.charCodeAt(i)
    const run = bin.charCodeAt(i + 1)
    for (let k = 0; k < run && at < count; k++) out[at++] = kind
  }
  if (at !== count) throw new Error(`art.cells covers ${at} modules, expected ${count}`)
  return out
}

/**
 * Whether each finder disc is free of opaque artwork.
 *
 * Art mode needs this because artwork showing through a finder's middle ring
 * reads as a dark module and kills the lock-on. Tested against the alpha channel,
 * not the bounding box, so a round logo is not punished for its corners.
 */
export function finderClearance(spec: QRSpec, matrix: Matrix, img: HTMLImageElement): boolean[] {
  const { quietZone } = spec.canvas
  const total = canvasSize(matrix.size, quietZone)
  const px = total * SAMPLE_RES
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const aspect = img.naturalWidth / img.naturalHeight || 1
  const rect = logoRect(spec, matrix.size, aspect)
  if (!rect) return [true, true, true]
  ctx.drawImage(img, rect.x * SAMPLE_RES, rect.y * SAMPLE_RES, rect.w * SAMPLE_RES, rect.h * SAMPLE_RES)
  const { data } = ctx.getImageData(0, 0, px, px)

  return finderCentres(matrix.size).map(({ cx, cy }) => {
    const dx = (cx + quietZone) * SAMPLE_RES
    const dy = (cy + quietZone) * SAMPLE_RES
    const rad = 3.5 * SAMPLE_RES
    for (let y = Math.max(0, Math.floor(dy - rad)); y < Math.min(px, Math.ceil(dy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(dx - rad)); x < Math.min(px, Math.ceil(dx + rad)); x++) {
        if (data[(y * px + x) * 4 + 3] <= 16) continue
        if ((x + 0.5 - dx) ** 2 + (y + 0.5 - dy) ** 2 <= rad * rad) return false
      }
    }
    return true
  })
}
