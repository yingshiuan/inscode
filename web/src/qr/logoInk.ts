/**
 * Is the logo damaging the code with its artwork, or with its own background?
 *
 * A logo covers modules over its whole bounding *rectangle*, not just where its ink
 * is. So the same mark costs very different amounts depending on how it was
 * exported: keep the alpha channel and only the artwork lands on the code; flatten
 * it onto white and the empty corners of the box damage modules exactly as the ink
 * does.
 *
 * Measured on one design -- the same artwork, the same size, the same payload, only
 * the file changing:
 *
 *     logo file                                largest logo a decoder still reads
 *     colour, alpha preserved                  0.52
 *     same artwork forced to black-and-white   0.52   <- tone costs nothing
 *     colour, alpha flattened onto white       0.46
 *     black-and-white, flattened onto white    0.46
 *     flattened onto black                     0.42
 *
 * Tone is not the variable; opacity is. That matters because it is invisible in the
 * preview -- a flattened white background looks like nothing at all against a white
 * canvas, while quietly holding the safe logo size down. The design just gets a
 * smaller `estimatedSafeScale` and the user is given no reason why.
 *
 * This module supplies the reason. It reports what share of the artwork is a flat
 * opaque field, and how many of the modules the logo covers are that field rather
 * than ink -- the modules that keying the background out would give straight back.
 *
 * Mirrors server/inscode/logoink.py. `profilePixels` is the parity-tested half: pure
 * integer work over an RGBA buffer, identical in both languages. The half above it
 * decodes and scales the image with each side's own machinery -- a canvas here, PIL
 * there -- so the two agree on verdicts rather than on pixels, as in audit.ts.
 */
import type { QRSpec } from './spec'
import type { Matrix } from './encode'
import { logoRect, type Rect } from './layout'

/**
 * Alpha at or below this counts as transparent. Matches the clearance tests in
 * sampler.ts, so "opaque" means the same thing everywhere in the codebase.
 */
const ALPHA_INK = 16

/**
 * Samples per edge when profiling the artwork. Bounded so a 4000px logo costs no
 * more than a 200px one, and fixed so both languages sample the same grid.
 */
export const PROFILE_GRID = 96

/**
 * Samples at each edge of that grid taken as "the border". Three deep, because a
 * one-pixel ring catches JPEG ringing and a matted edge; three does not.
 */
const BORDER_BAND = 3

/**
 * Per-channel distance within which two colours are the same flat field. Wide
 * enough for JPEG's quantisation of a solid area, far short of any real artwork.
 */
const TONE_TOLERANCE = 12

/**
 * Share of the border that must be opaque before a flat background is even
 * possible. Below it the artwork already has a cutout, and there is nothing to key.
 */
const BORDER_OPAQUE = 0.9

/**
 * Share of the *opaque* border that must be one colour before it is called the
 * background. Not near-1.0: artwork routinely bleeds into the edge of its own box --
 * the reference logo puts ink in 24% of its border and is still a mark on a field.
 */
const BORDER_DOMINANCE = 0.6

/**
 * Above this opaque share the artwork has no usable transparency at all. Not 1.0: a
 * "transparent" PNG that has been through a matting step often keeps a handful of
 * stray alpha pixels, and those do not make it a cutout.
 */
const FLAT_ALPHA = 0.98

/** Below this there is not enough background to be worth saying anything about. */
const MIN_BACKGROUND = 0.15

/**
 * Longest edge the artwork is reduced to before sampling. The grid above is coarser
 * than this, so the reduction costs nothing and bounds the memory both sides hold.
 */
const PROFILE_MAX = 512

export type RGB = [number, number, number]

/** What the artwork is made of, before any question about the code. */
export interface Ink {
  /** Share of the bounding box that is opaque. */
  opaque: number
  /** The flat field the border sits on, if there is one. */
  background: RGB | null
  /** Share of the bounding box that is that flat field. */
  backgroundShare: number
}

/**
 * `n` evenly spaced pixel indices across `extent`, at the centre of each cell.
 *
 * Integer arithmetic, so Python picks the same pixels rather than nearly the same
 * ones -- the difference is invisible until a parity test disagrees by one.
 */
export function sampleAxis(n: number, extent: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.floor(((2 * i + 1) * extent) / (2 * n)))
  return out
}

/** Whether an opaque pixel belongs to a flat field of `colour`. */
export function isTone(r: number, g: number, b: number, colour: RGB): boolean {
  return (
    Math.abs(r - colour[0]) <= TONE_TOLERANCE &&
    Math.abs(g - colour[1]) <= TONE_TOLERANCE &&
    Math.abs(b - colour[2]) <= TONE_TOLERANCE
  )
}

/**
 * Opacity and flat-background analysis of an RGBA buffer.
 *
 * The parity-tested half: no image decoding, no floats that depend on a resampler,
 * nothing that differs between a browser and Python given the same bytes.
 *
 * A background is only claimed when the border agrees with itself. That guard is
 * what keeps a photograph -- which has no flat field to key out, and where the
 * advice would be wrong -- from being reported as one.
 */
export function profilePixels(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  grid = PROFILE_GRID,
): Ink {
  const n = Math.min(grid, w, h)
  if (n <= 0) return { opaque: 0, background: null, backgroundShare: 0 }

  const xs = sampleAxis(n, w)
  const ys = sampleAxis(n, h)
  const px: number[] = []
  for (const y of ys) {
    for (const x of xs) {
      const i = (y * w + x) * 4
      px.push(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
    }
  }

  const total = n * n
  let opaque = 0
  for (let s = 0; s < total; s++) if (px[s * 4 + 3] > ALPHA_INK) opaque++

  // The border, three samples deep on every side.
  const band = Math.min(BORDER_BAND, n)
  let edge = 0
  const solid: number[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!(r < band || r >= n - band || c < band || c >= n - band)) continue
      edge++
      const s = (r * n + c) * 4
      if (px[s + 3] > ALPHA_INK) solid.push(px[s], px[s + 1], px[s + 2])
    }
  }
  const solidCount = solid.length / 3
  if (!solidCount || solidCount < BORDER_OPAQUE * edge) {
    // A border that is partly transparent is already a cutout. Nothing to key.
    return { opaque: opaque / total, background: null, backgroundShare: 0 }
  }

  // Modal colour of the border, bucketed to absorb compression noise.
  const buckets = new Map<number, [number, number, number, number]>()
  for (let s = 0; s < solidCount; s++) {
    const r = solid[s * 3]
    const g = solid[s * 3 + 1]
    const b = solid[s * 3 + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const acc = buckets.get(key)
    if (acc) {
      acc[0]++
      acc[1] += r
      acc[2] += g
      acc[3] += b
    } else {
      buckets.set(key, [1, r, g, b])
    }
  }
  let bestKey = -1
  let best: [number, number, number, number] = [0, 0, 0, 0]
  for (const [key, acc] of buckets) {
    // Ties break on the bucket key, as `max(buckets, key=...)` does in Python.
    if (acc[0] > best[0] || (acc[0] === best[0] && key > bestKey)) {
      bestKey = key
      best = acc
    }
  }
  const [count, sr, sg, sb] = best
  if (count < BORDER_DOMINANCE * solidCount) {
    // Two or more tones share the border: this is artwork running to the edge, not a
    // mark sitting on a field. Keying one of them out is not the advice.
    return { opaque: opaque / total, background: null, backgroundShare: 0 }
  }

  const bg: RGB = [Math.floor(sr / count), Math.floor(sg / count), Math.floor(sb / count)]
  let share = 0
  for (let s = 0; s < total; s++) {
    const i = s * 4
    if (px[i + 3] > ALPHA_INK && isTone(px[i], px[i + 1], px[i + 2], bg)) share++
  }
  return { opaque: opaque / total, background: bg, backgroundShare: share / total }
}

/** The artwork profile, and what it costs this particular code. */
export interface LogoInk {
  opaque: number
  /** The flat field, as hex, or null when there is none to key out. */
  background: string | null
  backgroundShare: number
  /** Module centres that fall under the artwork rectangle. */
  modulesCovered: number
  /**
   * Those that land on the flat background rather than on ink -- the ones a
   * transparent export would hand straight back to the code.
   */
  modulesBackground: number
  /**
   * Set when a plate is already clearing these modules, which changes the advice:
   * keying the logo out gains nothing until the plate is off too.
   */
  plate: boolean
  /** No usable transparency: the whole bounding box lands on the code. */
  flat: boolean
  /** Whether there is a flat background worth telling the user about. */
  removable: boolean
  message: string | null
}

const hex = (c: RGB) =>
  '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

/**
 * Module centres under the artwork, with where each lands inside it, 0..1.
 *
 * Rotation is undone about the rectangle's centre rather than ignored: the SVG
 * rotates the image, so a rotated logo covers a different set of modules and
 * counting the unrotated box would quietly overstate the damage.
 */
export function* coveredCentres(
  spec: QRSpec,
  size: number,
  rect: Rect,
): Generator<{ u: number; v: number }> {
  const { x, y, w, h } = rect
  if (w <= 0 || h <= 0) return
  const { quietZone } = spec.canvas
  const cx = x + w / 2
  const cy = y + h / 2
  const rot = spec.logo?.rotation ?? 0
  const a = rot ? (-rot * Math.PI) / 180 : 0
  const cos = Math.cos(a)
  const sin = Math.sin(a)

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let mx = c + quietZone + 0.5
      let my = r + quietZone + 0.5
      if (a) {
        const dx = mx - cx
        const dy = my - cy
        mx = cx + dx * cos - dy * sin
        my = cy + dx * sin + dy * cos
      }
      const u = (mx - x) / w
      const v = (my - y) / h
      if (u >= 0 && u < 1 && v >= 0 && v < 1) yield { u, v }
    }
  }
}

/**
 * The message, or null when the artwork is not costing anything avoidable.
 *
 * Mirrors `LogoInk.message` in logoink.py word for word: the browser and the API
 * telling a user two different things about the same file is worse than either.
 */
function advise(ink: Omit<LogoInk, 'message'>, art: boolean): string | null {
  if (art || !ink.removable || !ink.background) return null
  const n = ink.modulesBackground
  if (ink.plate) {
    return (
      `This logo has no transparent background — but the plate is clearing those ` +
      `modules anyway. Turn the plate off and key out the flat ${ink.background} to ` +
      `give ${n} of them back to the code.`
    )
  }
  return (
    `This logo has no transparent background: ${n} of the ${ink.modulesCovered} ` +
    `modules it covers are flat ${ink.background}, not artwork. Keying that out ` +
    `would give them back to the code.`
  )
}

/**
 * Profile the logo, and count what it costs this code in modules.
 *
 * The module count is taken at module *centres*, because that is where a decoder
 * reads and where audit.ts binarises -- a module whose centre sits on flat
 * background is a module the background is spending, and the one a cutout returns.
 */
export function logoInk(
  spec: QRSpec,
  matrix: Matrix,
  img: HTMLImageElement | null,
): LogoInk | null {
  if (!spec.logo || !img) return null

  const natural = { w: img.naturalWidth, h: img.naturalHeight }
  if (!natural.w || !natural.h) return null
  const aspect = natural.w / natural.h
  const longest = Math.max(natural.w, natural.h)
  const s = longest > PROFILE_MAX ? PROFILE_MAX / longest : 1
  const w = Math.max(1, Math.round(natural.w * s))
  const h = Math.max(1, Math.round(natural.h * s))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  const ink = profilePixels(data, w, h)

  let covered = 0
  let background = 0
  const rect = logoRect(spec, matrix.size, aspect)
  if (rect) {
    for (const { u, v } of coveredCentres(spec, matrix.size, rect)) {
      const x = Math.min(w - 1, Math.floor(u * w))
      const y = Math.min(h - 1, Math.floor(v * h))
      const i = (y * w + x) * 4
      // Transparent here: this module is not covered at all.
      if (data[i + 3] <= ALPHA_INK) continue
      covered++
      if (ink.background && isTone(data[i], data[i + 1], data[i + 2], ink.background)) {
        background++
      }
    }
  }

  const art = spec.mode === 'art'
  const base: Omit<LogoInk, 'message'> = {
    opaque: ink.opaque,
    background: ink.background ? hex(ink.background) : null,
    backgroundShare: ink.backgroundShare,
    modulesCovered: covered,
    modulesBackground: background,
    plate: spec.mode === 'classic' && spec.logo.plate.enabled,
    flat: ink.opaque >= FLAT_ALPHA,
    removable:
      !art &&
      ink.opaque >= FLAT_ALPHA &&
      ink.background !== null &&
      ink.backgroundShare >= MIN_BACKGROUND &&
      background > 0,
  }
  return { ...base, message: advise(base, art) }
}
