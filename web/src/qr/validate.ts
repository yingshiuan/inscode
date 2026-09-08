/**
 * Can a real scanner resolve this? -- the optical half of the question.
 *
 * `audit.ts` answers the other half exactly, from the design itself: is the data
 * still recoverable. That is a property of the drawing and needs no decoding. This is
 * the part that genuinely cannot be computed, only swept: lenses, noise, print gain
 * and motion blur all live here, and the only honest tool is to degrade the image the
 * way a real read degrades it and see what survives.
 *
 * Two things this deliberately does not do:
 *
 *   - It does not measure in pixels. 180px is generous for a version-2 code and
 *     hopeless for a version-20 one -- the ratio a scanner sees is pixels per
 *     *module*, so that is the unit the sweep is expressed in.
 *   - It does not reward a decode below the Nyquist limit. The browser draws perfect
 *     antialiased geometry and zxing will recover a code at 1.35 px/module from it; a
 *     phone camera never will. Passing at that size is an artefact of the test, not
 *     evidence about the design, so the sweep does not go there.
 *
 * Mirrors server/inscode/validate.py -- change both together.
 */
import { readBarcodes } from 'zxing-wasm/reader'
import { present, type Profile } from './oracle'
import { MIN_MODULE_MM } from './output'

export type Grade = 'ok' | 'risky' | 'fragile' | 'fail' | 'pending'

/**
 * The ladder, as `Profile`s -- the same type the production oracle uses, so both go
 * through one piece of canvas code rather than two that drift apart.
 *
 * 4 px/module is a code filling a phone screen at arm's length; 2.5 is a business
 * card; below 2 the sampling grid itself aliases and no design survives.
 */
const CONDITIONS: Profile[] = [
  { name: 'large', pxPerModule: 8 },
  { name: 'screen', pxPerModule: 4 },
  { name: 'small print', pxPerModule: 2.5 },
  { name: 'soft focus', pxPerModule: 4, blur: 1.6 },
  { name: 'low contrast', pxPerModule: 4, contrast: 0.45 },
  { name: 'rotated 12°', pxPerModule: 4, rotate: 12 },
]

const CLEAN = new Set(['large', 'screen', 'small print'])
/** The user's own output size, swept alongside the standard ladder. */
const AT_YOUR_SIZE = 'at your size'

export interface Condition {
  label: string
  pxPerModule: number
  px: number
  /** null when the browser cannot apply the degradation, so it was not tested. */
  ok: boolean | null
}

export interface ScanReport {
  grade: Grade
  passed: number
  total: number
  /** The fewest pixels per module that still decoded from a clean render. */
  minPxPerModule: number | null
  /** Print width this design needs, or null when it is too fragile to quote one. */
  minWidthMm: number | null
  /** Whether the design survived blur, fade and rotation -- what print does to it. */
  degradedOk: boolean
  /** The decode at the size actually being produced, when one was given. */
  atYourSize: Condition | null
  message: string
  conditions: Condition[]
}

const PENDING: ScanReport = {
  grade: 'pending', passed: 0, total: CONDITIONS.length, minPxPerModule: null,
  minWidthMm: null, degradedOk: false, atYourSize: null, message: '', conditions: [],
}

/**
 * Sweep a design across the conditions above. `modules` includes the quiet zone.
 *
 * `atPxPerModule` adds the user's own output size to the sweep, which is the only
 * condition they actually care about -- the ladder exists to say how much room they
 * have either side of it. Pass it for a screen target; a print target's limit is
 * physical rather than pixel, so it is answered from `minWidthMm` instead.
 */
export async function checkScannable(
  svg: string,
  expected: string,
  modules: number,
  atPxPerModule?: number,
): Promise<ScanReport> {
  if (!svg || !expected || !modules) return PENDING

  const ladder: Profile[] =
    atPxPerModule && atPxPerModule > 0
      ? [{ name: AT_YOUR_SIZE, pxPerModule: atPxPerModule }, ...CONDITIONS]
      : CONDITIONS

  const conditions: Condition[] = []
  for (const profile of ladder) {
    const px = Math.max(32, Math.round(modules * profile.pxPerModule))
    let ok: boolean | null = false
    try {
      const blob = await present(svg, modules, profile)
      ok = blob === null
        ? null
        : (await readBarcodes(blob, { formats: ['QRCode'], tryHarder: true }))
            .some((r) => r.text === expected)
    } catch {
      ok = false // a failed rasterise is a failed read
    }
    conditions.push({ label: profile.name, pxPerModule: profile.pxPerModule, px, ok })
  }

  const tested = conditions.filter((c) => c.ok !== null)
  const passed = tested.filter((c) => c.ok).length
  const score = tested.length ? passed / tested.length : 0
  const clean = conditions.filter((c) => c.ok && CLEAN.has(c.label))
  const minPxPerModule = clean.length ? Math.min(...clean.map((c) => c.pxPerModule)) : null
  const degradedOk = conditions.every(
    (c) => CLEAN.has(c.label) || c.label === AT_YOUR_SIZE || c.ok !== false,
  )

  // Only quote a print size for a design that survived the degraded conditions. A
  // code that needs a perfect render is not one to hand somebody a millimetre figure
  // for -- saying so is more use than a number that implies confidence.
  const minWidthMm =
    degradedOk && minPxPerModule ? Math.ceil(modules * MIN_MODULE_MM) : null

  let grade: Grade
  let message: string
  if (score === 1) {
    grade = 'ok'
    message = 'Scans under every condition tested'
  } else if (score >= 0.6) {
    grade = 'risky'
    message = `Fails when: ${tested.filter((c) => !c.ok).map((c) => c.label).join(', ')}`
  } else if (passed) {
    grade = 'fragile'
    message = 'Only scans in ideal conditions'
  } else {
    grade = 'fail'
    message = 'Does not scan at any size tested'
  }

  return {
    grade,
    passed,
    total: tested.length,
    minPxPerModule,
    minWidthMm,
    degradedOk,
    atYourSize: conditions.find((c) => c.label === AT_YOUR_SIZE) ?? null,
    message,
    conditions,
  }
}
