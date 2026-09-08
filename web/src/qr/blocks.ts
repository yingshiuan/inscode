/**
 * Which codeword does each module carry, and how much damage can each block take?
 *
 * This is the exact half of the scannability question. A QR code is not protected as
 * one lump: the payload is split into Reed-Solomon blocks, each with its own error
 * budget, and the codewords are interleaved across the symbol so that a scratch in
 * one place is spread over every block. So "the logo covers 31%, level H recovers
 * 30%" is not a calculation -- it is an average compared against an area. The real
 * constraint is the *worst* block, and answering that needs the module -> codeword
 * map.
 *
 * Everything here is integer arithmetic over (version, EC level). No rendering, no
 * decoding, no images: two designs with the same version and EC level have the same
 * map, and it is the same map in every implementation of ISO/IEC 18004.
 *
 * Mirrors server/inscode/blocks.py -- change both together.
 */
import { cellKey, reservedCells } from './geometry'
import type { ECLevel } from './spec'

export const EC_LEVELS: ECLevel[] = ['L', 'M', 'Q', 'H']

// ISO/IEC 18004 Table 9, indexed [(version - 1) * 4 + level]. The same layout both
// node-qrcode and python-qrcode use internally, which is what audit.test.ts and
// test_audit.py check this against -- neither library exposes it as public API, so
// the table lives here and each side is pinned to its own library's copy.

/** Reed-Solomon blocks the payload is split into. */
const EC_BLOCKS = [
  1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 2, 2, 1, 2, 2, 4,
  1, 2, 4, 4, 2, 4, 4, 4,
  2, 4, 6, 5, 2, 4, 6, 6,
  2, 5, 8, 8, 4, 5, 8, 8,
  4, 5, 8, 11, 4, 8, 10, 11,
  4, 9, 12, 16, 4, 9, 16, 16,
  6, 10, 12, 18, 6, 10, 17, 16,
  6, 11, 16, 19, 6, 13, 18, 21,
  7, 14, 21, 25, 8, 16, 20, 25,
  8, 17, 23, 25, 9, 17, 23, 34,
  9, 18, 25, 30, 10, 20, 27, 32,
  12, 21, 29, 35, 12, 23, 34, 37,
  12, 25, 34, 40, 13, 26, 35, 42,
  14, 28, 38, 45, 15, 29, 40, 48,
  16, 31, 43, 51, 17, 33, 45, 54,
  18, 35, 48, 57, 19, 37, 51, 60,
  19, 38, 53, 63, 20, 40, 56, 66,
  21, 43, 59, 70, 22, 45, 62, 74,
  24, 47, 65, 77, 25, 49, 68, 81,
]

/** Error-correction codewords in each of those blocks. Uniform within a version/level. */
const EC_PER_BLOCK = [
  7, 10, 13, 17, 10, 16, 22, 28,
  15, 26, 18, 22, 20, 18, 26, 16,
  26, 24, 18, 22, 18, 16, 24, 28,
  20, 18, 18, 26, 24, 22, 22, 26,
  30, 22, 20, 24, 18, 26, 24, 28,
  20, 30, 28, 24, 24, 22, 26, 28,
  26, 22, 24, 22, 30, 24, 20, 24,
  22, 24, 30, 24, 24, 28, 24, 30,
  28, 28, 28, 28, 30, 26, 28, 28,
  28, 26, 26, 26, 28, 26, 30, 28,
  28, 26, 28, 30, 28, 28, 30, 24,
  30, 28, 30, 30, 30, 28, 30, 30,
  26, 28, 30, 30, 28, 28, 28, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
  30, 28, 30, 30, 30, 28, 30, 30,
]

/**
 * Misdecode protection: ISO/IEC 18004 spends a few of the smallest symbols' error
 * correction codewords on detecting a wrong decode rather than repairing one, so
 * those blocks correct fewer errors than ec/2. Zero from version 4 up, which is every
 * code this tool realistically produces -- but the small ones should not quietly
 * overstate their budget.
 */
const PROTECTION: Record<string, number> = {
  '1L': 3, '1M': 2, '1Q': 1, '1H': 1, '2L': 2, '3L': 1,
}

export interface Block {
  index: number
  dataCodewords: number
  ecCodewords: number
  /**
   * Codewords in this block that Reed-Solomon can repair. Any wrong bit in a
   * codeword spends the whole codeword, however many of its 8 modules are wrong.
   */
  correctable: number
}

export interface BlockPlan {
  version: number
  ecLevel: ECLevel
  blocks: Block[]
  totalCodewords: number
  /** Trailing modules that carry no codeword. Damage here is free. */
  remainderBits: number
  /** Owning block for each codeword, in the interleaved order they are placed. */
  owners: number[]
}

/**
 * Modules available to codewords: everything that is not a function pattern.
 *
 * `reservedCells` already knows precisely which those are, so the codeword count and
 * the remainder bits fall out of the geometry rather than a second table.
 */
export function dataModules(version: number): number {
  const size = version * 4 + 17
  return size * size - reservedCells(version).size
}

export function blockPlan(version: number, ecLevel: ECLevel): BlockPlan {
  const i = (version - 1) * 4 + EC_LEVELS.indexOf(ecLevel)
  const count = EC_BLOCKS[i]
  const ecPerBlock = EC_PER_BLOCK[i]

  const available = dataModules(version)
  const total = Math.floor(available / 8)
  const dataTotal = total - count * ecPerBlock

  // Blocks come in at most two sizes, and the longer ones go last.
  const longBlocks = total % count
  const shortData = Math.floor(dataTotal / count)
  const correctable = Math.floor(
    (ecPerBlock - (PROTECTION[`${version}${ecLevel}`] ?? 0)) / 2,
  )

  const blocks: Block[] = []
  for (let b = 0; b < count; b++) {
    blocks.push({
      index: b,
      dataCodewords: shortData + (b >= count - longBlocks ? 1 : 0),
      ecCodewords: ecPerBlock,
      correctable,
    })
  }

  // Interleaving, ISO/IEC 18004 s8.6: the nth data codeword of every block in turn,
  // then the nth EC codeword of every block. This is why a logo cannot be "31% of one
  // block" -- a contiguous patch of the symbol lands on all of them at once.
  const owners: number[] = []
  const longest = Math.max(...blocks.map((b) => b.dataCodewords))
  for (let n = 0; n < longest; n++) {
    for (const b of blocks) if (n < b.dataCodewords) owners.push(b.index)
  }
  for (let n = 0; n < ecPerBlock; n++) {
    for (const b of blocks) owners.push(b.index)
  }

  return {
    version,
    ecLevel,
    blocks,
    totalCodewords: total,
    remainderBits: available - total * 8,
    owners,
  }
}

/**
 * Every data module, in the order the codeword bits are written into it.
 *
 * ISO/IEC 18004 s8.7.3: two-module-wide columns walked right to left, the symbol
 * traversed upward then downward in alternation, skipping the vertical timing pattern
 * so the pairing stays aligned. Function patterns are stepped over rather than
 * counted.
 */
export function placementOrder(version: number): { row: number; col: number }[] {
  const size = version * 4 + 17
  const reserved = reservedCells(version)
  const out: { row: number; col: number }[] = []
  let row = size - 1
  let col = size - 1
  let upward = true

  while (col > 0) {
    if (col === 6) col -= 1 // the timing column is never half of a data pair
    for (let n = 0; n < size; n++) {
      for (const c of [col, col - 1]) {
        if (!reserved.has(cellKey(row, c))) out.push({ row, col: c })
      }
      row += upward ? -1 : 1
    }
    row += upward ? 1 : -1 // back onto the symbol before turning around
    upward = !upward
    col -= 2
  }

  return out
}

/**
 * Module -> the index of the codeword whose bits it carries, keyed by `cellKey`.
 *
 * Remainder modules are absent: they hold padding bits no decoder reads, so damaging
 * them costs nothing and they should not be charged to a block.
 */
export function moduleCodewords(version: number, ecLevel: ECLevel): Map<number, number> {
  const plan = blockPlan(version, ecLevel)
  const out = new Map<number, number>()
  placementOrder(version).forEach(({ row, col }, i) => {
    const cw = i >> 3
    if (cw < plan.totalCodewords) out.set(cellKey(row, col), cw)
  })
  return out
}
