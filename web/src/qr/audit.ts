/**
 * Is the information still recoverable? -- answered from the design, not by decoding.
 *
 * A decode result is one boolean covering two independent failures, which is why the
 * old badge had to say "shrink the logo or raise the contrast": it genuinely could
 * not tell which. This module answers only the first question, exactly:
 *
 *     Is enough of every Reed-Solomon block intact for a decoder to repair the rest?
 *
 * `validate.ts` still answers the second -- can a real scanner resolve it -- because
 * that one is optical and only a sweep can answer it.
 *
 * Three things make this precise where "the logo covers 31%" is not:
 *
 *   - Per block, not global. 30% is level H's *average*; Reed-Solomon repairs per
 *     block and interleaving spreads a centred logo over the blocks unevenly. The
 *     binding constraint is the worst block, never the mean.
 *   - Structural modules have no error correction at all. Finders, timing, alignment
 *     and format info are read before any repair happens, so one wrong module there
 *     is fatal however healthy the blocks look. Area percentage cannot see this.
 *   - A covered module is only an error if it *binarizes* wrong. Counting coverage
 *     calls a code dead that scans fine, because under a mid-tone plate roughly half
 *     the modules still read correctly. So the modules are measured from the rendered
 *     design rather than assumed.
 *
 * Mirrors server/inscode/audit.py -- change both together. The integer half
 * (blocks.ts) is identical in both by construction; the measured half samples each
 * side's own rasteriser, so the two agree on verdicts rather than on luminance.
 */
import { svgToImage, withPixelSize } from '../export/render'
import { blockPlan, moduleCodewords } from './blocks'
import { buildSvg } from './build'
import type { Matrix } from './encode'
import {
  cellKey,
  finderBoxes,
  formatInfoCopies,
  FUNCTION_BCH_CORRECTS,
  gridKinds,
  versionInfoCopies,
  type GridKind,
} from './geometry'
import { PRODUCTION, reads, type Verdict } from './oracle'
import type { ECLevel, QRSpec } from './spec'

/** Pixels per module when sampling. Odd, so every module has a true centre pixel. */
const RASTER_SCALE = 9
/**
 * Sample the middle third of each module -- the part a scanner reads, and the part
 * two different rasterisers agree on. Module edges are all antialiasing.
 */
const CENTRE = 3
/** Buckets in the luminance histogram, as in zxing's GlobalHistogramBinarizer. */
const BUCKETS = 32
/**
 * The run a decoder scans for through the centre of a finder -- the 1:1:3:1:1 ratio of
 * ISO/IEC 18004 §6.3.3 -- widened by one module each side, because the finder has to
 * be *isolated* for the ratio to match. A dark module against the outer ring merges
 * the runs and the scan stops finding it, which is why separator damage kills a code
 * while timing and alignment damage does not. Checked against zxing over 21 degrees of
 * separator damage, this agrees on 20 and errs one step early on the last.
 */
const FINDER_PROFILE = [false, true, false, true, true, true, false, true, false]

/**
 * Wrong modules tolerated in a finder's surrounding ring -- the 9x9 detection area
 * minus the 7x7 pattern itself, i.e. the separator and the quiet-zone edge.
 *
 * Zero, and that is measured rather than cautious. Swept over the calibration matrix
 * (2215 rows, zxing-cpp, "phone" profile), holding everything else constant:
 *
 *     tolerance   false pass    false fail   agreement
 *             0    33 (1.5%)    65 (2.9%)       95.6%
 *             1    48 (2.2%)    47 (2.1%)       95.7%
 *             2    52 (2.3%)    15 (0.7%)       97.0%
 *             5   108 (4.9%)    12 (0.5%)       94.6%
 *
 * Tolerance 2 has the best raw agreement. Zero is chosen anyway, because a false pass
 * is the product telling somebody a logo is safe when their phone cannot read the
 * result, and a false fail only costs them a slightly smaller logo.
 *
 * Before this check existed the model scored 114 false passes (5.1%); 76 of them were
 * a logo pushed toward a corner, with the centre-run profile passing every time.
 *
 * See server/inscode/audit.py -- change both together.
 */
const FINDER_RING_TOLERANCE = 0

/** How to name each kind of grid damage. Which one it is changes what to do. */
const KIND_NAMES: Record<GridKind, string> = {
  alignment: 'alignment pattern',
  timing: 'timing pattern',
  separator: 'finder separator',
}
/**
 * A design with a headroom this thin is reported as marginal rather than safe: the
 * binariser here is a global threshold, where a real decoder's is local, so the last
 * codeword or two of margin is not something to promise.
 */
const THIN_MARGIN = 1
/**
 * Binary-search steps for the heuristic bracket. Each one costs a raster, and seven of
 * them resolve the answer to under a percent -- finer than the number is reported.
 */
const SEARCH_STEPS = 7
/** Below this a logo is a speck; if the data is still lost there, size is not the problem. */
const MIN_SCALE = 0.02

export type IntegrityGrade = 'ok' | 'marginal' | 'fail'

export interface BlockDamage {
  index: number
  dataCodewords: number
  ecCodewords: number
  correctable: number
  /** Codewords holding at least one wrong module. The unit Reed-Solomon spends. */
  corrupted: number
  headroom: number
}

export interface IntegrityReport {
  grade: IntegrityGrade
  message: string
  intact: boolean
  version: number
  ecLevel: ECLevel
  /**
   * False when the histogram has too little dynamic range to binarise at all -- a
   * contrast failure, which no amount of shrinking the logo will fix.
   */
  contrastOk: boolean
  /** Luminance between the two histogram peaks. The contrast the design actually has. */
  contrastSpread: number
  /** The threshold the histogram settled on, below which a module reads dark. */
  blackPoint: number
  /**
   * Wrong modules in the timing and alignment patterns and the finder separators.
   * Nothing corrects these -- but nothing much reads them either: a decoder locks the
   * grid from the finder patterns, and destroying every one of these still decodes.
   * Reported as a caution, not a cause of death. See `geometry.gridKinds`.
   */
  gridFlips: number
  /** Those flips broken down by what was hit, so the message can name it. */
  gridKinds: Partial<Record<GridKind, number>>
  /**
   * Wrong modules in each of the two copies of the format information. Each copy is a
   * BCH(15,5) codeword that survives up to FUNCTION_BCH_CORRECTS of them, and a
   * decoder reads whichever copy comes back cleaner.
   */
  formatErrors: [number, number]
  formatOk: boolean
  /** The same for version information, or null on versions 1-6, which carry none. */
  versionErrors: [number, number] | null
  versionOk: boolean
  /**
   * Whether each of the three finders can still be found: its centre run reads
   * 1:1:3:1:1 *and* the ring around it is clear. Not a module-by-module diff of the
   * 7x7 -- that would condemn a circular finder, which scans perfectly well.
   */
  findersOk: boolean[]
  /** The centre-run check alone, kept apart so a tolerance can be re-calibrated. */
  finderRunsOk: boolean[]
  /** Wrong modules in each finder's surrounding ring. */
  finderRingDamage: number[]
  brokenFinders: number
  modulesFlipped: number
  blocks: BlockDamage[]
  worstBlock: number
  /** Codewords of damage the design could still absorb, in its worst block. */
  headroom: number
  /**
   * The model's estimate of the largest logo scale whose data stays recoverable. Fast,
   * and wrong 4.4% of the time against the calibration matrix -- never present it as a
   * verified answer. null when there is no logo, or when even the smallest one does
   * not fix the design. The decoder's answer lives in the store, not here: it is
   * asynchronous and this report is not.
   */
  estimatedSafeScale: number | null
  logoScale: number | null
}

/** ITU-R BT.601 luma, in integers so Python computes the same number. */
const luminance = (r: number, g: number, b: number) =>
  Math.floor((299 * r + 587 * g + 114 * b) / 1000)

/**
 * Module-centre luminance from RGBA pixels at RASTER_SCALE pixels per module.
 *
 * Split out from the canvas work so the offset arithmetic -- the part that silently
 * reports nonsense if it is off by one -- can be tested against a synthetic image,
 * which matters here because everything above it needs a real browser to run.
 */
export function readCentres(
  data: Uint8ClampedArray,
  px: number,
  size: number,
  quietZone: number,
): number[] {
  const off = (RASTER_SCALE - CENTRE) >> 1
  const out: number[] = []
  for (let r = 0; r < size; r++) {
    const y0 = (r + quietZone) * RASTER_SCALE + off
    for (let c = 0; c < size; c++) {
      const x0 = (c + quietZone) * RASTER_SCALE + off
      let acc = 0
      for (let y = y0; y < y0 + CENTRE; y++) {
        for (let x = x0; x < x0 + CENTRE; x++) {
          const i = (y * px + x) * 4
          acc += luminance(data[i], data[i + 1], data[i + 2])
        }
      }
      out.push(Math.floor(acc / (CENTRE * CENTRE)))
    }
  }
  return out
}

/** Luminance at the centre of every module of the rendered design, row-major. */
export async function sampleModules(
  svg: string,
  size: number,
  quietZone: number,
): Promise<number[]> {
  const px = (size + 2 * quietZone) * RASTER_SCALE
  const img = await svgToImage(withPixelSize(svg, px))
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // Matte white: a transparent code is read against whatever it is placed on, and
  // white is the honest best case for that.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, px, px)
  ctx.drawImage(img, 0, 0, px, px)
  return readCentres(ctx.getImageData(0, 0, px, px).data, px, size, quietZone)
}

/**
 * Threshold between the light and dark module populations, plus their separation.
 *
 * zxing's GlobalHistogramBinarizer, run over the module centres rather than the whole
 * image: it is the algorithm a real decoder uses to decide what counts as dark, so a
 * design it cannot split is one a decoder cannot read. A separation of 0 is returned
 * when the two peaks are too close to be two peaks.
 */
export function estimateBlackPoint(values: number[]): { blackPoint: number; spread: number } {
  const buckets = new Array<number>(BUCKETS).fill(0)
  for (const v of values) buckets[v >> 3]++

  let first = 0
  let maxCount = 0
  for (let x = 0; x < BUCKETS; x++) {
    if (buckets[x] > buckets[first]) first = x
    if (buckets[x] > maxCount) maxCount = buckets[x]
  }

  let second = 0
  let secondScore = 0
  for (let x = 0; x < BUCKETS; x++) {
    const d = x - first
    const score = buckets[x] * d * d
    if (score > secondScore) {
      second = x
      secondScore = score
    }
  }

  const lo = Math.min(first, second)
  const hi = Math.max(first, second)
  if (secondScore === 0 || hi - lo <= BUCKETS / 16) {
    // One population, or two too close to call apart. zxing does not need the first
    // guard -- it histograms a whole photograph, which is never one tone -- but a flat
    // swatch of a design is exactly that, and it must not read as a perfect split.
    return { blackPoint: 128, spread: 0 }
  }

  // The emptiest bucket between the peaks, biased away from the darker one.
  let valley = hi - 1
  let best = -1
  for (let x = hi - 1; x > lo; x--) {
    const fromLo = x - lo
    const score = fromLo * fromLo * (hi - x) * (maxCount - buckets[x])
    if (score > best) {
      valley = x
      best = score
    }
  }
  return { blackPoint: valley << 3, spread: (hi - lo) << 3 }
}

/**
 * The one-line verdict, in the order a decoder actually works: locate the finders,
 * establish the grid from timing and alignment, read the format bits, unmask, read the
 * data. Whatever fails first is what stopped it; everything after is downstream.
 */
function describe(r: Omit<IntegrityReport, 'grade' | 'message'>): { grade: IntegrityGrade; message: string } {
  if (!r.contrastOk) {
    return { grade: 'fail', message: 'Modules and background are too close in tone to tell apart' }
  }
  if (r.brokenFinders > 0) {
    return {
      grade: 'fail',
      message: `${r.brokenFinders} of 3 finder patterns no longer reads — a scanner cannot locate the code`,
    }
  }
  if (!r.formatOk) {
    return {
      grade: 'fail',
      message:
        'Both copies of the format information are damaged — a scanner cannot tell which mask or error correction level was used',
    }
  }
  if (!r.versionOk) {
    return {
      grade: 'fail',
      message:
        'Both copies of the version information are damaged — a scanner cannot tell how large the symbol is',
    }
  }
  const w = r.blocks[r.worstBlock]
  if (w.headroom < 0) {
    return {
      grade: 'fail',
      message: `Data lost: block ${w.index} is ${-w.headroom} codeword${w.headroom === -1 ? '' : 's'} past what it can repair`,
    }
  }
  if (w.headroom <= THIN_MARGIN) {
    return {
      grade: 'marginal',
      message: `Data intact, but block ${w.index} has only ${w.headroom} codeword${w.headroom === 1 ? '' : 's'} of margin`,
    }
  }
  if (r.gridFlips > 0) {
    const n = r.gridFlips
    const names = (Object.entries(r.gridKinds) as [GridKind, number][])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind]) => KIND_NAMES[kind])
    const where =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    return {
      grade: 'marginal',
      message: `Data intact — ${n} module${n > 1 ? 's' : ''} of the ${where} obscured, which scanners usually tolerate`,
    }
  }
  return {
    grade: 'ok',
    message: `Data intact — ${w.headroom} codewords of margin in block ${w.index}`,
  }
}

/**
 * The ring a decoder needs clear around each finder, in-symbol cells only.
 *
 * The detection area is 9x9 -- the 7x7 pattern, its one-module separator, and the
 * quiet-zone edge beyond. This is that area *minus* the pattern itself, because the
 * pattern is checked by its run profile instead: the renderer restyles those 49
 * modules on purpose, and a circular finder that differs from the matrix in 16 of them
 * still scans. The ring is the part that simply has to be empty.
 */
export function finderRings(size: number): Set<number>[] {
  return finderBoxes(size).map(({ row, col }) => {
    const ring = new Set<number>()
    for (let r = row - 1; r <= row + 7; r++) {
      for (let c = col - 1; c <= col + 7; c++) {
        const insideDisc = r >= row && r < row + 7 && c >= col && c < col + 7
        if (!insideDisc && r >= 0 && c >= 0 && r < size && c < size) ring.add(cellKey(r, c))
      }
    }
    return ring
  })
}

/**
 * Whether each finder still scans, by the criterion a decoder actually uses.
 *
 * A finder is not read as 49 bits -- it is *found*, by scanning for the 1:1:3:1:1 run
 * of dark and light through its centre, isolated from whatever is around it. Comparing
 * it module for module against the matrix is the wrong test twice over: it condemns a
 * circular finder, which preserves the run exactly and scans perfectly well, and it
 * misses separator damage, which does not touch the 7x7 at all but merges the outer
 * run into its surroundings and stops the scan matching.
 *
 * The run is read one module wider than the finder on each side. Outside the symbol
 * that module is the quiet zone, taken to be light -- a design whose artwork spills
 * past the code edge into it is the one case this does not see.
 */
export function finderProfiles(dark: boolean[], size: number): boolean[] {
  const at = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < size && c < size ? dark[r * size + c] : false

  return finderBoxes(size).map(({ row, col }) => {
    const cr = row + 3
    const cc = col + 3
    const across: boolean[] = []
    const down: boolean[] = []
    for (let i = -4; i <= 4; i++) {
      across.push(at(cr, cc + i))
      down.push(at(cr + i, cc))
    }
    return (
      across.every((v, i) => v === FINDER_PROFILE[i]) &&
      down.every((v, i) => v === FINDER_PROFILE[i])
    )
  })
}

/**
 * Per-module dark/light, plus the black point and the contrast spread.
 *
 * One threshold for the whole symbol, and that is a measured choice rather than a
 * simplification. zxing binarises *locally*, so a local model should be the more
 * faithful one -- it was tried, in the shape of zxing's HybridBinarizer on the module
 * grid, and it did not pay:
 *
 *     binariser                     false pass    false fail   agreement
 *     global histogram              33 (1.5%)     65 (2.9%)       95.6%
 *     local, 8-module blocks        37 (1.7%)     60 (2.7%)       95.6%
 *     local, 4-module blocks        34 (1.5%)     63 (2.8%)       95.6%
 *
 * All three within noise of each other, and the local variants slightly *worse* on the
 * metric that matters. Where the model is actually wrong is the finder rings, and that
 * is where the work went.
 */
export function binarize(lums: number[], size: number) {
  const { blackPoint, spread } = estimateBlackPoint(lums)
  void size
  return { dark: lums.map((lum) => lum < blackPoint), blackPoint, spread }
}

/**
 * Charge measured module errors to the Reed-Solomon blocks that carry them.
 *
 * Pure integer accounting over sampled luminances: no image, no rasteriser. This is
 * the half of the measurement that *must* be identical in both languages, and
 * test_parity.py holds it to that against a synthetic damage pattern -- the pixels
 * two rasterisers produce may differ, but what a flipped module costs may not.
 */
export function auditSamples(
  lums: number[],
  matrix: Matrix,
  ecLevel: ECLevel,
): IntegrityReport {
  const size = matrix.size
  const { dark, blackPoint, spread } = binarize(lums, size)

  const plan = blockPlan(matrix.version, ecLevel)
  const codewordAt = moduleCodewords(matrix.version, ecLevel)
  // Finder discs are excluded: the renderer restyles them on purpose, and their
  // correctness is the profile check above, not a module-by-module diff. Format and
  // version info are excluded too -- they carry their own error correction, and are
  // counted per copy afterwards rather than charged as fatal damage.
  const grid = gridKinds(matrix.version)
  const rings = finderRings(size)
  // Ring cells are the finders' business, not the grid's: a wrong module there stops
  // the corner being found at all, which no amount of "usually tolerated" covers.
  const ringCells = new Set<number>(rings.flatMap((ring) => [...ring]))

  let gridFlips = 0
  let modulesFlipped = 0
  const kindCounts: Partial<Record<GridKind, number>> = {}
  const hit = new Set<number>()
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark[r * size + c] === matrix.get(r, c)) continue
      modulesFlipped++
      const key = cellKey(r, c)
      const kind = ringCells.has(key) ? undefined : grid.get(key)
      if (kind !== undefined) {
        gridFlips++
        kindCounts[kind] = (kindCounts[kind] ?? 0) + 1
      } else {
        const cw = codewordAt.get(key)
        if (cw !== undefined) hit.add(cw) // remainder and finder modules carry nothing
      }
    }
  }

  const corrupted = new Array<number>(plan.blocks.length).fill(0)
  for (const cw of hit) corrupted[plan.owners[cw]]++

  const blocks: BlockDamage[] = plan.blocks.map((b) => ({
    index: b.index,
    dataCodewords: b.dataCodewords,
    ecCodewords: b.ecCodewords,
    correctable: b.correctable,
    corrupted: corrupted[b.index],
    headroom: b.correctable - corrupted[b.index],
  }))
  const worstBlock = blocks.reduce((w, b) => (b.headroom < blocks[w].headroom ? b.index : w), 0)
  const headroom = blocks[worstBlock].headroom

  const wrong = (cells: Set<number>) => {
    let n = 0
    for (const key of cells) {
      const r = Math.floor(key / 256)
      const c = key % 256
      if (dark[r * size + c] !== matrix.get(r, c)) n++
    }
    return n
  }
  const [fmtA, fmtB] = formatInfoCopies(matrix.version)
  const verCopies = versionInfoCopies(matrix.version)
  const formatErrors: [number, number] = [wrong(fmtA), wrong(fmtB)]
  const versionErrors: [number, number] | null = verCopies
    ? [wrong(verCopies[0]), wrong(verCopies[1])]
    : null
  const formatOk = Math.min(...formatErrors) <= FUNCTION_BCH_CORRECTS
  const versionOk = !versionErrors || Math.min(...versionErrors) <= FUNCTION_BCH_CORRECTS

  const finderRingDamage = rings.map(wrong)
  const finderRunsOk = finderProfiles(dark, size)
  const findersOk = finderRunsOk.map(
    (ok, i) => ok && finderRingDamage[i] <= FINDER_RING_TOLERANCE,
  )
  const brokenFinders = findersOk.filter((ok) => !ok).length

  const base = {
    // Grid damage is deliberately absent: it is measurably survivable, and a verdict
    // that calls it fatal contradicts the phone in the user's hand.
    intact: spread > 0 && brokenFinders === 0 && formatOk && versionOk && headroom >= 0,
    version: matrix.version,
    ecLevel,
    contrastOk: spread > 0,
    contrastSpread: spread,
    blackPoint,
    gridFlips,
    gridKinds: kindCounts,
    formatErrors,
    formatOk,
    versionErrors,
    versionOk,
    findersOk,
    finderRunsOk,
    finderRingDamage,
    brokenFinders,
    modulesFlipped,
    blocks,
    worstBlock,
    headroom,
    estimatedSafeScale: null,
    logoScale: null,
  }
  return { ...base, ...describe(base) }
}

/** Audit a design that has already been drawn. Costs one raster. */
export async function auditSvg(
  svg: string,
  spec: QRSpec,
  matrix: Matrix,
): Promise<IntegrityReport> {
  const lums = await sampleModules(svg, matrix.size, spec.canvas.quietZone)
  return {
    ...auditSamples(lums, matrix, spec.content.ecLevel),
    logoScale: spec.logo?.scale ?? null,
  }
}

/**
 * The model's answer: largest logo scale whose data the audit believes recoverable.
 *
 * Bisection is valid because the audit *is* monotone in scale -- measured over 192
 * series of the calibration matrix, 192 of them monotone. Fast enough to run while the
 * logo is being dragged, and wrong often enough that it is an estimate rather than a
 * verdict: `verifiedMaxScale` is what the export path uses.
 */
export async function heuristicMaxScale(
  spec: QRSpec,
  matrix: Matrix,
  img: HTMLImageElement | null,
  currentlyIntact?: boolean,
  steps = SEARCH_STEPS,
): Promise<number | null> {
  const logo = spec.logo
  if (!logo) return null
  const here = logo.scale

  const intactAt = async (scale: number) => {
    // The browser's art-mode sampling belongs to the scale it was taken at.
    const probe: QRSpec = {
      ...spec,
      logo: { ...logo, scale },
      art: { ...spec.art, cells: undefined },
    }
    const built = buildSvg(probe, matrix, img)
    return (await auditSvg(built.svg, built.spec, matrix)).intact
  }

  const ok = currentlyIntact ?? (await intactAt(here))
  let lo: number
  let hi: number
  if (ok) {
    if (await intactAt(1)) return 1 // nothing about the size binds
    lo = here
    hi = 1
  } else {
    if (!(await intactAt(MIN_SCALE))) return null // contrast or colour, not size
    lo = MIN_SCALE
    hi = here
  }

  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2
    if (await intactAt(mid)) lo = mid
    else hi = mid
  }
  return Math.round(lo * 1000) / 1000
}

/** The full data-integrity report for a design. */
export async function audit(
  spec: QRSpec,
  matrix: Matrix,
  img: HTMLImageElement | null,
  { withMaxScale = true } = {},
): Promise<IntegrityReport> {
  const built = buildSvg(spec, matrix, img)
  const report = await auditSvg(built.svg, built.spec, matrix)
  if (!withMaxScale || !spec.logo) return report
  return {
    ...report,
    estimatedSafeScale: await heuristicMaxScale(spec, matrix, img, report.intact),
  }
}

/**
 * Steps and guards for decoder confirmation. Mirrors the Python constants -- a
 * verified answer that differs between the browser and the API is worse than none.
 */
const CONFIRM_STEP = 0.02
const CONFIRM_GUARD = 3
const CONFIRM_PROBE_UP = 2
const CONFIRM_BUDGET = 22

export interface VerifyResult {
  /** The largest scale a decoder confirmed, or null when it could not confirm one. */
  scale: number | null
  /** True when the browser could not run the decoder at all -- not a pass, not a fail. */
  unavailable: boolean
  /**
   * Some sizes read and none satisfied "nothing below fails". The design is not dead;
   * it is balanced on the decoder's threshold, reading at one size and failing a
   * smaller one -- which is worth refusing, and worth refusing for the right reason.
   */
  unstable: boolean
}

/**
 * Largest logo scale a real decoder confirms.
 *
 * The model only proposes: `heuristicMaxScale` finds the bracket cheaply, and the
 * oracle decides. Nothing is returned that has not itself been rendered under the
 * production profile and read back.
 *
 * The contract is deliberately stronger than "the largest size that reads". Decoder
 * PASS/FAIL is not monotone in logo size -- measured over 192 series, 2 of them read
 * again above a size that failed -- so the top of an isolated island of success would
 * be a trap: told "safe up to 35%", nobody expects 30% to fail. So the answer is the
 * largest size *below which nothing fails*, checked at sampled points underneath.
 *
 * Mirrors `verified_max_scale` in server/inscode/audit.py.
 */
export async function verifiedMaxScale(
  spec: QRSpec,
  matrix: Matrix,
  img: HTMLImageElement | null,
  candidate: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<VerifyResult> {
  const logo = spec.logo
  if (!logo) return { scale: null, unavailable: false, unstable: false }
  const modules = matrix.size + 2 * spec.canvas.quietZone

  const seen = new Map<number, Verdict>()
  let calls = 0

  const verdict = async (scale: number): Promise<Verdict> => {
    const key = Math.round(scale * 10000) / 10000
    const cached = seen.get(key)
    if (cached) return cached
    if (calls >= CONFIRM_BUDGET) return 'fails' // out of budget: refuse rather than guess
    calls++
    const probe: QRSpec = {
      ...spec,
      logo: { ...logo, scale: key },
      art: { ...spec.art, cells: undefined },
    }
    const built = buildSvg(probe, matrix, img)
    const answer = await reads(built.svg, spec.content.text, modules, PRODUCTION)
    seen.set(key, answer)
    return answer
  }

  let blocked = false
  const readsAt = async (scale: number) => {
    if (blocked) return false
    const answer = await verdict(scale)
    if (answer === 'unavailable') blocked = true
    return answer === 'reads'
  }

  const safeBelow = async (scale: number) => {
    const span = scale - MIN_SCALE
    if (span <= 0) return true
    for (let i = 0; i < CONFIRM_GUARD; i++) {
      if (!(await readsAt(MIN_SCALE + (span * (i + 1)) / (CONFIRM_GUARD + 1)))) return false
    }
    return true
  }

  // The heuristic is a little pessimistic at the Reed-Solomon cliff, so look up a
  // couple of steps before walking down.
  let scale = Math.min(1, candidate + CONFIRM_PROBE_UP * CONFIRM_STEP)
  while (scale >= MIN_SCALE && calls < CONFIRM_BUDGET && !blocked) {
    if (signal?.aborted) return { scale: null, unavailable: true, unstable: false }
    if ((await readsAt(scale)) && (await safeBelow(scale))) {
      return { scale: Math.round(scale * 1000) / 1000, unavailable: false, unstable: false }
    }
    scale = Math.round((scale - CONFIRM_STEP) * 10000) / 10000
  }

  const readsSomewhere = [...seen.values()].some((v) => v === 'reads')
  return { scale: null, unavailable: blocked, unstable: !blocked && readsSomewhere }
}
