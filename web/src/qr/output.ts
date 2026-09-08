/**
 * How big this code will actually be.
 *
 * The preview is a 560px box whatever the design is, so a code destined for a 15mm
 * sticker looks exactly as crisp on screen as one going on a poster. That is the real
 * reason a scannability badge gets believed: it is read as a statement about the thing
 * on screen, which is always enormous. So the intended output is a first-class value
 * here, the verdict is given at *that* size, and the canvas shows the code at it.
 *
 * It is not part of `QRSpec`. A spec is the drawing -- what is drawn does not change
 * because you decide to print it smaller -- and keeping it out means the render
 * contract, the fixtures and the parity tests are untouched by it. It travels
 * alongside the spec instead, as its own field.
 */

/**
 * The conventional floor for the module size ("X-dimension") of a printed code read by
 * a phone. Below it, scanning depends on the camera and the light rather than on the
 * design, which is not something a report can speak for.
 */
export const MIN_MODULE_MM = 0.5

/** Print resolution the pixel <-> millimetre conversions assume. */
export const PRINT_DPI = 300

/** A comfortable pixels-per-module target for a code on a screen. */
export const GOOD_PX_PER_MODULE = 4

/**
 * Below this the sampling grid aliases and no design survives -- and, importantly, a
 * clean vector render decodes well past it, so a measured pass down there is an
 * artefact of the test rather than a fact about the design. It is a floor, checked
 * before any decoding, not something the sweep is allowed to argue with.
 */
export const MIN_PX_PER_MODULE = 2

export type Output =
  | { kind: 'print'; mm: number }
  | { kind: 'screen'; px: number }

export const DEFAULT_OUTPUT: Output = { kind: 'print', mm: 40 }

export const MM_RANGE = { min: 5, max: 300 }
export const PX_RANGE = { min: 48, max: 4096 }

export function isOutput(v: unknown): v is Output {
  const o = v as Output | undefined
  if (!o || typeof o !== 'object') return false
  if (o.kind === 'print') return typeof o.mm === 'number' && Number.isFinite(o.mm)
  if (o.kind === 'screen') return typeof o.px === 'number' && Number.isFinite(o.px)
  return false
}

/** CSS defines 1mm as exactly this many px, which is what makes a true-size preview possible. */
export const CSS_PX_PER_MM = 96 / 25.4

export const mmToPx = (mm: number, dpi = PRINT_DPI) => Math.round((mm / 25.4) * dpi)
export const pxToMm = (px: number, dpi = PRINT_DPI) => (px / dpi) * 25.4

/**
 * Size of one module at the intended output: millimetres for print, CSS pixels for
 * screen. `modules` includes the quiet zone, because that is part of the symbol and
 * a generous one really does eat into the budget.
 */
export function modulePitch(output: Output, modules: number): number {
  if (!modules) return 0
  return (output.kind === 'print' ? output.mm : output.px) / modules
}

/** A CSS length that renders the code at its intended physical or pixel size. */
export function outputCssWidth(output: Output): string {
  return output.kind === 'print' ? `${output.mm}mm` : `${output.px}px`
}

/** The smallest print width this many modules can be given at the floor above. */
export const recommendedMm = (modules: number) => Math.ceil(modules * MIN_MODULE_MM)

/** The smallest screen width that clears `GOOD_PX_PER_MODULE`. */
export const recommendedPx = (modules: number) => Math.ceil(modules * GOOD_PX_PER_MODULE)

/** Export width in pixels that produces this output at print resolution. */
export function exportPxFor(output: Output): number {
  return output.kind === 'print' ? mmToPx(output.mm) : output.px
}

/** The preview's width in CSS pixels, for deciding whether true size even fits. */
export function outputCssPx(output: Output): number {
  return output.kind === 'print' ? output.mm * CSS_PX_PER_MM : output.px
}

export function describeOutput(output: Output): string {
  return output.kind === 'print' ? `${output.mm} mm` : `${output.px} px`
}
