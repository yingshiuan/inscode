/**
 * Where the artwork sits on the canvas. Shared by the sampler, the finder-clearance
 * search and the renderer so all three agree on one placement.
 *
 * Units are modules, measured on the full canvas including the quiet zone.
 */
import type { QRSpec } from './spec'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Canvas width in modules, quiet zone included. */
export const canvasSize = (size: number, quietZone: number) => size + 2 * quietZone

/** The code area itself, quiet zone excluded. */
export function codeRect(size: number, quietZone: number): Rect {
  return { x: quietZone, y: quietZone, w: size, h: size }
}

/**
 * Artwork rectangle for a spec. `aspect` is the image's natural width / height;
 * the longest edge becomes `logo.scale` of the code width, so a wide and a tall
 * logo at the same scale read as the same visual size.
 */
export function logoRect(spec: QRSpec, size: number, aspect: number): Rect | null {
  const logo = spec.logo
  if (!logo) return null
  const { quietZone } = spec.canvas
  const longest = logo.scale * size
  const w = aspect >= 1 ? longest : longest * aspect
  const h = aspect >= 1 ? longest / aspect : longest
  return {
    x: quietZone + logo.x * size - w / 2,
    y: quietZone + logo.y * size - h / 2,
    w,
    h,
  }
}

/** Plate rectangle behind a centre logo, padded by `plate.pad` modules. */
export function plateRect(logo: Rect, pad: number): Rect {
  return { x: logo.x - pad, y: logo.y - pad, w: logo.w + 2 * pad, h: logo.h + 2 * pad }
}
