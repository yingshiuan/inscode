/**
 * Module and finder shapes as SVG path data.
 *
 * Everything is in *module units*: module (r, c) occupies [c, c+1] x [r, r+1].
 * Pixel size is applied once, at export, via width/height on the root -- so the
 * preview and a 4000px PNG come from identical path data.
 *
 * All coordinates go through fmt(). Both renderers rounding identically is what
 * lets the parity test diff two SVG strings.
 *
 * Mirrors server/inscode/shapes.py -- change both together.
 */
import type { MarkShape, ModuleShape } from './spec'

/** 4dp, trailing zeros stripped. Must match the Python `fmt`. */
export function fmt(n: number): string {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? '0' : String(r)
}

const P = (...parts: (string | number)[]) => parts.map((p) => (typeof p === 'number' ? fmt(p) : p)).join(' ')

/** Axis-aligned rectangle. */
export function rectPath(x: number, y: number, w: number, h: number): string {
  return P('M', x, y, 'h', w, 'v', h, 'h', -w, 'Z')
}

/** Circle as two half arcs. */
export function circlePath(cx: number, cy: number, r: number): string {
  return P('M', cx - r, cy, 'a', r, r, 0, 1, 0, 2 * r, 0, 'a', r, r, 0, 1, 0, -2 * r, 0, 'Z')
}

/** Rounded rectangle with independent corner radii, clockwise from top-left. */
export function roundedPath(
  x: number,
  y: number,
  w: number,
  h: number,
  [tl, tr, br, bl]: [number, number, number, number],
): string {
  const lim = Math.min(w, h) / 2
  const a = Math.min(tl, lim), b = Math.min(tr, lim), c = Math.min(br, lim), d = Math.min(bl, lim)
  const arc = (r: number, dx: number, dy: number) => (r > 0 ? P('a', r, r, 0, 0, 1, dx, dy) : '')
  return [
    P('M', x + a, y),
    P('h', w - a - b),
    arc(b, b, b),
    P('v', h - b - c),
    arc(c, -c, c),
    P('h', -(w - c - d)),
    arc(d, -d, -d),
    P('v', -(h - d - a)),
    arc(a, a, -a),
    'Z',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Four-pointed star -- the `cross` mark from the original script. */
export function starPath(cx: number, cy: number, r: number): string {
  const w = r * 0.4
  const pts: [number, number][] = [
    [cx, cy - r], [cx + w, cy - w], [cx + r, cy], [cx + w, cy + w],
    [cx, cy + r], [cx - w, cy + w], [cx - r, cy], [cx - w, cy - w],
  ]
  return 'M ' + pts.map(([px, py]) => `${fmt(px)} ${fmt(py)}`).join(' L ') + ' Z'
}

export function diamondPath(cx: number, cy: number, r: number): string {
  return P('M', cx, cy - r, 'L', cx + r, cy, 'L', cx, cy + r, 'L', cx - r, cy, 'Z')
}

/** A small mark at a module centre, used by art mode. */
export function markPath(cx: number, cy: number, r: number, shape: MarkShape): string {
  if (shape === 'dot') return circlePath(cx, cy, r)
  if (shape === 'square') return rectPath(cx - r, cy - r, 2 * r, 2 * r)
  return starPath(cx, cy, r)
}

export type IsDark = (row: number, col: number) => boolean

/** One module's path. `isDark` is only consulted by the `connected` shape. */
export function modulePath(
  row: number,
  col: number,
  shape: ModuleShape,
  gap: number,
  isDark: IsDark,
): string {
  const inset = gap / 2
  const s = 1 - gap
  const x = col + inset
  const y = row + inset
  const cx = col + 0.5
  const cy = row + 0.5

  switch (shape) {
    case 'circle':
      return circlePath(cx, cy, s / 2)
    case 'rounded':
      return roundedPath(x, y, s, s, [0.35, 0.35, 0.35, 0.35].map((r) => r * s) as [number, number, number, number])
    case 'cross':
      return starPath(cx, cy, s / 2)
    case 'diamond':
      return diamondPath(cx, cy, s / 2)
    case 'connected': {
      // Round only the corners whose two neighbours are both empty, so runs of
      // adjacent modules fuse into one continuous blob.
      const n = isDark(row - 1, col), so = isDark(row + 1, col)
      const w = isDark(row, col - 1), e = isDark(row, col + 1)
      const R = 0.5 * s
      const radii: [number, number, number, number] = [
        !n && !w ? R : 0,
        !n && !e ? R : 0,
        !so && !e ? R : 0,
        !so && !w ? R : 0,
      ]
      return roundedPath(x, y, s, s, radii)
    }
    default:
      return rectPath(x, y, s, s)
  }
}

/**
 * The three concentric rings of one finder pattern, outermost first.
 *
 * These stay solid in every style. Scanners lock onto the finders before they
 * read anything else, and breaking them into loose dots is the single biggest
 * reason decorative QR codes fail to scan.
 */
export function finderRings(
  row: number,
  col: number,
  shape: 'square' | 'rounded' | 'circle',
): [string, string, string] {
  const ring = (inset: number, radius: number) => {
    const size = 7 - 2 * inset
    if (shape === 'circle') return circlePath(col + 3.5, row + 3.5, size / 2)
    const r = shape === 'rounded' ? radius : 0
    return roundedPath(col + inset, row + inset, size, size, [r, r, r, r])
  }
  // Radii taper inward so the rings stay visually concentric (0.9 / 0.63 / 0.45).
  return [ring(0, 0.9), ring(1, 0.63), ring(2, 0.45)]
}
