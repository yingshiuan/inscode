/**
 * Spec -> SVG, in one call.
 *
 * Mirrors `build_svg` in server/inscode/render.py. It exists as its own function
 * because two callers need it: the live preview, which draws it, and the audit,
 * which redraws the design at a dozen trial logo sizes to find the largest one the
 * data survives.
 */
import type { QRSpec } from './spec'
import type { Matrix } from './encode'
import { decideCells, finderClearance, sampleLuminance } from './sampler'
import { fitClearOfFinders } from './fitFinders'
import { renderSvgString } from './renderSvg'

export interface Built {
  /** The spec as actually drawn -- `clearFinders` may have shrunk the artwork. */
  spec: QRSpec
  svg: string
  /** Art-mode per-module decisions, to ship to the API so it draws these exact ones. */
  cells?: Uint8Array
  aspect: number
}

export function buildSvg(spec: QRSpec, matrix: Matrix, img: HTMLImageElement | null): Built {
  const aspect = img ? img.naturalWidth / img.naturalHeight || 1 : 1

  // clearFinders shrinks the artwork until it stops touching the corner discs.
  let effective = spec
  if (spec.mode === 'art' && spec.art.clearFinders && spec.logo && img) {
    const fitted = fitClearOfFinders(effective, matrix, img)
    if (fitted < spec.logo.scale) effective = { ...effective, logo: { ...spec.logo, scale: fitted } }
  }

  let cells: Uint8Array | undefined
  let finderClear: boolean[] | undefined
  if (effective.mode === 'art') {
    const lum = img ? sampleLuminance(effective, matrix, img, effective.canvas.bg ?? '#ffffff') : null
    cells = decideCells(effective, matrix, lum)
    finderClear = img ? finderClearance(effective, matrix, img) : [true, true, true]
  }

  return {
    spec: effective,
    svg: renderSvgString(effective, matrix, { cells, logoAspect: aspect, finderClear }),
    cells,
    aspect,
  }
}
