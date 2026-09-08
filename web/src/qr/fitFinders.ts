/**
 * Largest artwork scale whose opaque pixels stay clear of the three finder discs.
 *
 * Binary search on scale, testing the artwork's *alpha* channel rather than its
 * bounding box -- so a round logo can stay large where a square one has to shrink.
 * Port of `_fit_clear_of_finders` from the original script.
 */
import type { QRSpec } from './spec'
import type { Matrix } from './encode'
import { finderCentres } from './geometry'
import { canvasSize, logoRect } from './layout'

const RES = 3 // alpha samples per module
const GAP = 0.5 // modules of breathing room around each finder disc

export function fitClearOfFinders(spec: QRSpec, matrix: Matrix, img: HTMLImageElement): number {
  if (!spec.logo) return 1
  const { size } = matrix
  const { quietZone } = spec.canvas
  const total = canvasSize(size, quietZone)
  const px = total * RES

  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const aspect = img.naturalWidth / img.naturalHeight || 1

  const discs = finderCentres(size).map(({ cx, cy }) => ({
    x: (cx + quietZone) * RES,
    y: (cy + quietZone) * RES,
    r2: ((3.5 + GAP) * RES) ** 2,
  }))

  const hits = (scale: number): boolean => {
    ctx.clearRect(0, 0, px, px)
    const rect = logoRect({ ...spec, logo: { ...spec.logo!, scale } }, size, aspect)!
    ctx.drawImage(img, rect.x * RES, rect.y * RES, rect.w * RES, rect.h * RES)
    const { data } = ctx.getImageData(0, 0, px, px)
    for (const d of discs) {
      const x0 = Math.max(0, Math.floor(d.x - (3.5 + GAP) * RES))
      const x1 = Math.min(px, Math.ceil(d.x + (3.5 + GAP) * RES))
      const y0 = Math.max(0, Math.floor(d.y - (3.5 + GAP) * RES))
      const y1 = Math.min(px, Math.ceil(d.y + (3.5 + GAP) * RES))
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * px + x) * 4 + 3] <= 16) continue // effectively transparent
          if ((x + 0.5 - d.x) ** 2 + (y + 0.5 - d.y) ** 2 <= d.r2) return true
        }
      }
    }
    return false
  }

  const wanted = spec.logo.scale
  if (!hits(wanted)) return wanted
  let lo = 0.05
  let hi = wanted
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (hits(mid)) hi = mid
    else lo = mid
  }
  return lo
}
