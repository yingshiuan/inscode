/**
 * Render every golden fixture through the TypeScript renderer.
 *
 * The Python parity test renders the same fixtures and diffs the SVG strings, so
 * this output is the reference the two implementations are held to.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseSpec } from '../src/qr/spec'
import { encode, matrixFromEncoded } from '../src/qr/encode'
import { renderSvgString } from '../src/qr/renderSvg'
import { blockPlan, EC_LEVELS, placementOrder } from '../src/qr/blocks'
import { auditSamples } from '../src/qr/audit'
import type { Matrix } from '../src/qr/encode'

const DIR = new URL('../../server/tests/fixtures/', import.meta.url).pathname
const OUT = join(DIR, 'ts')
mkdirSync(OUT, { recursive: true })

let n = 0
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const spec = parseSpec(JSON.parse(readFileSync(join(DIR, file), 'utf8')))
  // Encode here rather than in the fixture, so the two sides are also compared on
  // agreeing about version and mask for the same payload.
  const encoded = encode(spec.content.text, spec.content.ecLevel)
  const matrix = matrixFromEncoded(encoded)
  const svg = renderSvgString({ ...spec, encoded }, matrix, { logoAspect: 1 })
  writeFileSync(join(OUT, basename(file, '.json') + '.svg'), svg)
  // Full encode result, bits included: the Python side renders from *these* bits to
  // prove the renderers agree, and separately proves it can reproduce them by pin.
  writeFileSync(join(OUT, basename(file, '.json') + '.encoded.json'), JSON.stringify(encoded))
  n++
}
/**
 * The audit's integer half, for every version and EC level.
 *
 * Unlike the renderers, this part must agree *exactly* across the two languages --
 * it is pure arithmetic over (version, level), with no image and no rasteriser in
 * it, so anything less than identical is a bug rather than a tolerance. The block
 * plan is written out in full because a mismatch there needs to name the version;
 * the placement walk and the interleaving are folded to a checksum because a
 * disagreement in 1000+ cells is only ever read as "these differ".
 */
const fold = (xs: number[]) => xs.reduce((h, x) => (Math.imul(h, 31) + x) >>> 0, 0)

const plans: Record<string, unknown> = {}
for (let version = 1; version <= 40; version++) {
  const walk = placementOrder(version)
  for (const level of EC_LEVELS) {
    const plan = blockPlan(version, level)
    plans[`${version}${level}`] = {
      blocks: plan.blocks.length,
      ecPerBlock: plan.blocks[0].ecCodewords,
      correctable: plan.blocks[0].correctable,
      dataCodewords: plan.blocks.map((b) => b.dataCodewords),
      totalCodewords: plan.totalCodewords,
      remainderBits: plan.remainderBits,
      owners: fold(plan.owners),
      placement: fold(walk.map(({ row, col }) => row * 256 + col)),
    }
  }
}
writeFileSync(join(OUT, 'blocks.json'), JSON.stringify(plans, null, 1))

/**
 * The audit's accounting, on a synthetic symbol damaged in a fixed pattern.
 *
 * The two implementations sample their own rasterisers, so their *pixels* legitimately
 * differ and only their verdicts can be compared. Their arithmetic cannot: given the
 * same measured luminances, what a flipped module costs which Reed-Solomon block is a
 * fact, and this pins it. The matrix is made up rather than encoded, because the
 * accounting does not care whether the bits spell anything -- and using a real payload
 * would drag node-qrcode's segmentation into a test that is not about encoding.
 */
const DAMAGE_VERSIONS = [1, 3, 7, 14, 21, 40]

const damage: Record<string, unknown> = {}
for (const version of DAMAGE_VERSIONS) {
  const size = version * 4 + 17
  const dark = (r: number, c: number) => (r * 7 + c * 13) % 3 === 0
  const matrix: Matrix = { size, version, maskPattern: 0, get: dark }

  // Every eleventh module reads as the opposite of what it should.
  const lums: number[] = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const flipped = (r * 31 + c) % 11 === 0
      lums.push(dark(r, c) !== flipped ? 0 : 255)
    }
  }

  for (const level of EC_LEVELS) {
    const a = auditSamples(lums, matrix, level)
    damage[`${version}${level}`] = {
      blackPoint: a.blackPoint,
      contrastSpread: a.contrastSpread,
      gridFlips: a.gridFlips,
      gridKinds: a.gridKinds,
      formatErrors: a.formatErrors,
      formatOk: a.formatOk,
      versionErrors: a.versionErrors,
      versionOk: a.versionOk,
      findersOk: a.findersOk,
      finderRunsOk: a.finderRunsOk,
      finderRingDamage: a.finderRingDamage,
      brokenFinders: a.brokenFinders,
      modulesFlipped: a.modulesFlipped,
      worstBlock: a.worstBlock,
      headroom: a.headroom,
      grade: a.grade,
      corrupted: a.blocks.map((b) => b.corrupted),
    }
  }
}
writeFileSync(join(OUT, 'audit-damage.json'), JSON.stringify(damage, null, 1))

console.log(`rendered ${n} fixtures -> ${OUT}`)
console.log(`wrote block plans for 40 versions x 4 levels -> ${join(OUT, 'blocks.json')}`)
console.log(`wrote damage accounting for ${DAMAGE_VERSIONS.length} versions x 4 levels`)
