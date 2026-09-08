/**
 * What a decoder actually does with the finished image. The authority, not a model.
 *
 * `audit.ts` models what a decoder should be able to recover. Against the committed
 * calibration matrix that model scores 33 false passes and 65 false fails over 2215
 * designs -- 95.6% agreement, which is useful and is not the same as correct. So a
 * number the user is about to act on does not come from the model: the model proposes
 * a candidate, and this decides.
 *
 * Mirrors server/inscode/oracle.py -- change both together. The profile has to match
 * the one the calibration matrix was swept with, or the browser and the API will
 * disagree about what "safe" means.
 */
import { readBarcodes } from 'zxing-wasm/reader'
import { svgToImage, withPixelSize } from '../export/render'

/**
 * How a finished code is presented to a decoder: a size, and the ways a real read is
 * worse than a render.
 *
 * One definition, used both for the production safety verdict here and for the
 * `validate.ts` legibility ladder -- two callers that were each carrying their own
 * copy of the same canvas work. The Python side mirrors this in `inscode/oracle.py`,
 * where `Profile` additionally covers JPEG and downscaling; those are not implemented
 * here because nothing in the browser asks for them yet.
 */
/**
 * How a finished code is presented to a decoder: a size, and the ways a real read is
 * worse than a render.
 *
 * One definition, used both for the production safety verdict here and for the
 * `validate.ts` legibility ladder -- two callers that were each carrying their own copy
 * of the same canvas work. The Python side mirrors this in `inscode/oracle.py`, where
 * `Profile` additionally covers JPEG and downscaling; those are not implemented here
 * because nothing in the browser asks for them yet.
 */
export interface Profile {
  name: string
  /** Pixels per *module*: 200px is generous for a version-2 code and hopeless for a version-25 one. */
  pxPerModule: number
  blur?: number
  /** CSS contrast factor. 1 leaves it alone; below that flattens it. */
  contrast?: number
  rotate?: number
}

/**
 * The verdict the product stands behind: a code filling a phone screen at arm's
 * length, slightly out of focus, on a screen or print that is not quite black on not
 * quite white. Every undamaged symbol from version 1 to 20 survives it, so a failure
 * here is about the design rather than the profile being unfair.
 */
export const PRODUCTION: Profile = { name: 'phone', pxPerModule: 4, blur: 1.6, contrast: 0.7 }

/**
 * A decoder's answer, or its refusal to give one.
 *
 * `unavailable` is not a pass. A browser that cannot apply the degradation cannot
 * verify anything, and reporting that as success would be exactly the silent
 * optimism this module exists to remove.
 */
export type Verdict = 'reads' | 'fails' | 'unavailable'

/**
 * The design as a decoder will receive it, or null if this browser cannot degrade it.
 *
 * Null is not a pass and not a fail. A browser without canvas filters cannot apply the
 * profile, and reporting that as success would be exactly the silent optimism this
 * module exists to remove -- so it says it could not do the job instead.
 */
export async function present(
  svg: string,
  modules: number,
  profile: Profile,
): Promise<Blob | null> {
  const px = Math.max(32, Math.round(modules * profile.pxPerModule))
  const img = await svgToImage(withPixelSize(svg, px))
  const angle = ((profile.rotate ?? 0) * Math.PI) / 180
  const box = Math.ceil(px * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle))))

  const canvas = document.createElement('canvas')
  canvas.width = box
  canvas.height = box
  const ctx = canvas.getContext('2d')!
  // Matte white: a transparent code is read against whatever it is placed on.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, box, box)

  const filters: string[] = []
  if (profile.blur) filters.push(`blur(${profile.blur}px)`)
  if (profile.contrast !== undefined && profile.contrast !== 1) {
    filters.push(`contrast(${profile.contrast})`)
  }
  if (filters.length) {
    // Browsers normalise the string they give back ("contrast(0.45)" either way), so
    // the test is whether it took at all, not whether it round-tripped.
    ctx.filter = filters.join(' ')
    if (ctx.filter === 'none') return null // no canvas filter support here
  }
  ctx.translate(box / 2, box / 2)
  if (angle) ctx.rotate(angle)
  ctx.drawImage(img, -px / 2, -px / 2, px, px)

  return new Promise((resolve, reject) =>
    // A failed encode is a failed read, not an untested condition -- those are only
    // ever a browser that cannot apply the degradation at all.
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), 'image/png'),
  )
}

/** Ask the decoder to read this design under `profile`. */
export async function reads(
  svg: string,
  expected: string,
  modules: number,
  profile: Profile = PRODUCTION,
): Promise<Verdict> {
  if (!svg || !expected || !modules) return 'unavailable'
  let blob: Blob | null
  try {
    blob = await present(svg, modules, profile)
  } catch {
    return 'fails' // a design that will not render will not read
  }
  if (blob === null) return 'unavailable'
  try {
    const results = await readBarcodes(blob, { formats: ['QRCode'], tryHarder: true })
    return results.some((r) => r.text === expected) ? 'reads' : 'fails'
  } catch {
    return 'unavailable'
  }
}

/**
 * Which design a verification result belongs to.
 *
 * Everything about the design except `logo.scale` -- because the scale is the thing
 * being solved for, and re-verifying while somebody drags the resize handle would
 * throw away a perfectly good answer on every frame. Anything else changing (payload,
 * position, colours, quiet zone, the logo image itself) invalidates it, and the export
 * path refuses to act on a result whose key no longer matches.
 *
 * The logo source is fingerprinted rather than compared: it is a data URI that can run
 * to hundreds of kilobytes, and hashing it on every render would cost more than the
 * verification it guards.
 */
export function designKey(spec: import('./spec').QRSpec): string {
  const logo = spec.logo
  const src = logo?.src ?? ''
  const fingerprint = `${src.length}:${src.slice(0, 48)}:${src.slice(-16)}`
  return JSON.stringify({
    content: spec.content,
    encoded: spec.encoded?.bits ?? null,
    mode: spec.mode,
    canvas: spec.canvas,
    modules: spec.modules,
    finders: spec.finders,
    art: { ...spec.art, cells: undefined },
    logo: logo
      ? { x: logo.x, y: logo.y, rotation: logo.rotation, plate: logo.plate, src: fingerprint }
      : null,
  })
}
