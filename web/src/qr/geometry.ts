/**
 * Function-pattern geometry, derived from version + size alone.
 *
 * `node-qrcode` exposes `modules.isReserved()` which would answer this directly,
 * but python-qrcode has no equivalent -- so deriving it from the spec's rules in
 * both languages is what keeps the two renderers agreeing. `isReserved()` earns
 * its keep as the oracle in geometry.test.ts, which checks this port against it
 * for every version 1..40.
 *
 * Mirrors server/inscode/geometry.py -- change both together.
 */

export interface Cell {
  row: number
  col: number
}

export const cellKey = (r: number, c: number) => r * 256 + c

/** Top-left corners of the three 7x7 finder patterns. Quiet zone excluded. */
export function finderBoxes(size: number): Cell[] {
  return [
    { row: 0, col: 0 },
    { row: 0, col: size - 7 },
    { row: size - 7, col: 0 },
  ]
}

/** Centres of the three finder patterns, in module coordinates. */
export function finderCentres(size: number): { cx: number; cy: number }[] {
  return finderBoxes(size).map(({ row, col }) => ({ cx: col + 3.5, cy: row + 3.5 }))
}

/** The 7x7 finder cells themselves, without separators. */
export function finderCells(size: number): Set<number> {
  const out = new Set<number>()
  for (const { row, col } of finderBoxes(size)) {
    for (let r = row; r < row + 7; r++) for (let c = col; c < col + 7; c++) out.add(cellKey(r, c))
  }
  return out
}

/**
 * Alignment-pattern centre coordinates for a version.
 * Version 1 has none; otherwise 6 and size-7 always bracket the run.
 */
export function alignmentCoords(version: number): number[] {
  if (version <= 1) return []
  const size = version * 4 + 17
  const posCount = Math.floor(version / 7) + 2
  const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2
  const positions = [size - 7]
  for (let i = 1; i < posCount - 1; i++) positions.push(positions[i - 1] - interval)
  positions.push(6)
  return positions.reverse()
}

/** 5x5 alignment patterns, skipping the three that would sit on a finder. */
export function alignmentCells(version: number): Set<number> {
  const size = version * 4 + 17
  const coords = alignmentCoords(version)
  const out = new Set<number>()
  for (const a of coords) {
    for (const b of coords) {
      const onFinder =
        (a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6)
      if (onFinder) continue
      for (let r = a - 2; r <= a + 2; r++) for (let c = b - 2; c <= b + 2; c++) out.add(cellKey(r, c))
    }
  }
  return out
}

/**
 * Every cell a scanner uses to find and decode the grid before it reads any data:
 * finders, separators, timing, alignment, format info, the dark module, and
 * version info on version 7 and up.
 *
 * Art mode paints these solid. Drawn as loose marks over artwork they stop
 * resolving and the code dies -- this is the same reasoning behind keeping the
 * finder patterns solid in classic mode.
 */
export function reservedCells(version: number): Set<number> {
  const size = version * 4 + 17
  const out = new Set<number>()
  const add = (r: number, c: number) => {
    if (r >= 0 && c >= 0 && r < size && c < size) out.add(cellKey(r, c))
  }

  // Finders plus their 1-module separators: an 8x8 block at each corner.
  for (const { row, col } of finderBoxes(size)) {
    const r0 = row === 0 ? 0 : row - 1
    const c0 = col === 0 ? 0 : col - 1
    for (let r = r0; r < r0 + 8; r++) for (let c = c0; c < c0 + 8; c++) add(r, c)
  }

  // Timing patterns: the full row 6 and column 6.
  for (let i = 0; i < size; i++) {
    add(6, i)
    add(i, 6)
  }

  for (const k of alignmentCells(version)) out.add(k)

  // Format information, mirrored around the finders, plus the always-dark module.
  for (let i = 0; i < 9; i++) {
    add(8, i)
    add(i, 8)
  }
  for (let i = 0; i < 8; i++) {
    add(8, size - 1 - i)
    add(size - 1 - i, 8)
  }

  // Version information: two 6x3 blocks, versions 7+.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        add(i, size - 11 + j)
        add(size - 11 + j, i)
      }
    }
  }

  return out
}

/** Reserved cells excluding the finder discs -- the set art mode draws as solid modules. */
export function structuralCells(version: number): Set<number> {
  const size = version * 4 + 17
  const finders = finderCells(size)
  const out = new Set<number>()
  for (const k of reservedCells(version)) if (!finders.has(k)) out.add(k)
  return out
}

/**
 * Format and version information are the only function patterns with error correction
 * of their own: 15 bits under BCH(15,5) and 18 under BCH(18,6), each written twice in
 * different corners. Both codes correct up to three wrong bits, and a decoder reads
 * whichever copy comes back cleaner -- so damage is fatal only when *both* copies are
 * past this.
 */
export const FUNCTION_BCH_CORRECTS = 3

export type GridKind = 'alignment' | 'timing' | 'separator'

/**
 * The two copies of the 15-bit format information (ISO/IEC 18004 §8.9).
 *
 * One wraps the top-left finder; the other is split between the top-right and
 * bottom-left. Column 6 and row 6 are skipped -- the timing patterns run through there
 * -- and the always-dark module is not part of either copy.
 */
export function formatInfoCopies(version: number): [Set<number>, Set<number>] {
  const size = version * 4 + 17
  const a = new Set<number>()
  const b = new Set<number>()
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      a.add(cellKey(8, i))
      a.add(cellKey(i, 8))
    }
  }
  for (let i = 0; i < 8; i++) b.add(cellKey(8, size - 1 - i))
  for (let i = 0; i < 7; i++) b.add(cellKey(size - 1 - i, 8))
  return [a, b]
}

/** The two copies of the 18-bit version information, or null below version 7. */
export function versionInfoCopies(version: number): [Set<number>, Set<number>] | null {
  if (version < 7) return null
  const size = version * 4 + 17
  const a = new Set<number>()
  const b = new Set<number>()
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      a.add(cellKey(i, size - 11 + j))
      b.add(cellKey(size - 11 + j, i))
    }
  }
  return [a, b]
}

/** The module that is always dark. No decoder reads it, so nothing depends on it. */
export const darkModule = (version: number) => cellKey(version * 4 + 17 - 8, 8)

/**
 * Cells that help a scanner lock the module grid, and what each one is.
 *
 * Everything here carries no error correction of its own -- but "no error correction"
 * is not the same as "fatal", and measuring the difference matters. A decoder built
 * like zxing (and, from the evidence, the iPhone camera) derives the grid from the
 * three finder patterns: their run widths give the module size and their spacing gives
 * the dimension. So:
 *
 *   - Timing and alignment damage is survivable, and by a wide margin. Destroying row
 *     6, column 6 and every alignment cell of a version-3 symbol still decodes at
 *     every size tested, blurred included; so does wiping all 325 alignment cells of a
 *     version-13 symbol under a 26% perspective tilt.
 *   - Separator damage is not, because it is really finder damage: a dark module
 *     against a finder's outer ring merges the runs and the 1:1:3:1:1 ratio scan stops
 *     matching. That failure is caught where it belongs, by widening `finderProfiles`
 *     to require the finder to be isolated.
 *
 * So this set is reported as a caution rather than a cause of death, named by kind
 * because which one it is changes what to do -- the timing patterns are at row and
 * column 6, the alignment patterns wherever the version puts them. Alignment is
 * classified first: an alignment pattern centred on row 6 genuinely overlaps the
 * timing run, and the more specific structure is the more useful name.
 *
 * Excluded: the finder discs (found by ratio, not read), the format and version
 * information (BCH-protected and duplicated), and the always-dark module.
 *
 * Mirrors `grid_kinds` in server/inscode/geometry.py.
 */
export function gridKinds(version: number): Map<number, GridKind> {
  const protectedCells = new Set<number>([darkModule(version)])
  for (const copies of [formatInfoCopies(version), versionInfoCopies(version)]) {
    if (copies) for (const set of copies) for (const k of set) protectedCells.add(k)
  }

  const alignment = alignmentCells(version)
  const out = new Map<number, GridKind>()
  for (const key of structuralCells(version)) {
    if (protectedCells.has(key)) continue
    const r = Math.floor(key / 256)
    const c = key % 256
    out.set(key, alignment.has(key) ? 'alignment' : r === 6 || c === 6 ? 'timing' : 'separator')
  }
  return out
}
