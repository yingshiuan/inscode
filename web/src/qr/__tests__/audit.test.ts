import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import ECCode from 'qrcode/lib/core/error-correction-code.js';
import ECLevel from 'qrcode/lib/core/error-correction-level.js';
import Utils from 'qrcode/lib/core/utils.js';
import {
  blockPlan,
  dataModules,
  EC_LEVELS,
  moduleCodewords,
  placementOrder,
} from '../blocks';
import {
  binarize,
  estimateBlackPoint,
  finderProfiles,
  readCentres,
} from '../audit';
import {
  cellKey,
  darkModule,
  finderBoxes,
  formatInfoCopies,
  reservedCells,
  structuralCells,
  gridKinds,
  versionInfoCopies,
} from '../geometry';
import { encode, matrixFromEncoded } from '../encode';
import type { ECLevel as Level } from '../spec';

/**
 * The data-integrity audit is only worth having if it is exactly right, and its
 * integer half is the part that can be proven. These are the two proofs: the block
 * table against node-qrcode's own copy, and the codeword placement walk against a
 * real payload read back out of a real matrix.
 *
 * The measured half -- sampling the rendered design and binarising it -- needs a
 * canvas, so it is exercised on the Python side in server/tests/test_audit.py, where
 * the same algorithm runs against resvg and zxing.
 */

/** Everything below the header of a byte-mode segment, as bits. */
function readMessage(text: string, level: Level): string {
  const enc = encode(text, level);
  const matrix = matrixFromEncoded(enc);
  const plan = blockPlan(enc.version, level);
  const masks = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const masked = masks[enc.maskPattern];

  const bits = placementOrder(enc.version)
    .map(({ row, col }) =>
      matrix.get(row, col) !== masked(row, col) ? '1' : '0',
    )
    .join('');

  const codewords: number[] = [];
  for (let i = 0; i < plan.totalCodewords; i++) {
    codewords.push(parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  }

  const perBlock = new Map<number, number[]>(
    plan.blocks.map((b) => [b.index, []]),
  );
  const dataCount = plan.blocks.reduce((n, b) => n + b.dataCodewords, 0);
  for (let i = 0; i < dataCount; i++)
    perBlock.get(plan.owners[i])!.push(codewords[i]);

  return plan.blocks
    .flatMap((b) => perBlock.get(b.index)!)
    .map((x) => x.toString(2).padStart(8, '0'))
    .join('');
}

describe('block table vs node-qrcode', () => {
  for (let version = 1; version <= 40; version++) {
    it(`agrees for version ${version}`, () => {
      for (const level of EC_LEVELS) {
        const plan = blockPlan(version, level);
        const count = ECCode.getBlocksCount(version, ECLevel[level]);
        const ecTotal = ECCode.getTotalCodewordsCount(version, ECLevel[level]);

        expect(`v${version}${level} blocks ${plan.blocks.length}`).toBe(
          `v${version}${level} blocks ${count}`,
        );
        const ourEcTotal = plan.blocks.reduce((n, b) => n + b.ecCodewords, 0);
        expect(`v${version}${level} ec ${ourEcTotal}`).toBe(
          `v${version}${level} ec ${ecTotal}`,
        );
        expect(plan.totalCodewords).toBe(
          Utils.getSymbolTotalCodewords(version),
        );
      }
    });
  }
});

describe('the codeword budget comes out of the geometry', () => {
  it('needs no second table', () => {
    // reservedCells already says which modules carry no data, and geometry.test.ts
    // pins that against node-qrcode for every version. Everything else follows.
    for (let version = 1; version <= 40; version++) {
      const available = dataModules(version);
      for (const level of EC_LEVELS) {
        const plan = blockPlan(version, level);
        expect(plan.totalCodewords * 8 + plan.remainderBits).toBe(available);
        expect(plan.owners.length).toBe(plan.totalCodewords);
      }
    }
  });

  it('reproduces the standard remainder-bit column', () => {
    const expected: Record<number, number> = {
      1: 0,
      2: 7,
      7: 0,
      14: 3,
      21: 4,
      28: 3,
      35: 0,
      40: 0,
    };
    for (const [version, bits] of Object.entries(expected)) {
      expect(
        `v${version} ${blockPlan(Number(version), 'H').remainderBits}`,
      ).toBe(`v${version} ${bits}`);
    }
  });
});

describe('placement walk', () => {
  it('visits every data module exactly once, and no function pattern', () => {
    for (let version = 1; version <= 40; version++) {
      const order = placementOrder(version);
      const keys = new Set(order.map(({ row, col }) => cellKey(row, col)));
      expect(`v${version} ${order.length} ${keys.size}`).toBe(
        `v${version} ${dataModules(version)} ${dataModules(version)}`,
      );
      const reserved = reservedCells(version);
      const trespass = [...keys].filter((k) => reserved.has(k));
      expect(`v${version} trespass ${trespass.length}`).toBe(
        `v${version} trespass 0`,
      );
    }
  });

  it('leaves the remainder bits unowned', () => {
    for (let version = 1; version <= 40; version++) {
      const plan = blockPlan(version, 'H');
      expect(moduleCodewords(version, 'H').size).toBe(plan.totalCodewords * 8);
    }
  });

  /**
   * The proof that the walk, the interleaving and the block sizes are all right.
   * Read the modules in placement order, undo the mask, de-interleave into blocks,
   * concatenate the blocks' data codewords and parse the byte-mode header. If any of
   * those three were wrong the payload would come back as noise -- as it does if you
   * perturb the walk by a single column.
   */
  for (const text of [
    'https://insdash.ch',
    'hello world',
    'x'.repeat(120),
    'z'.repeat(700),
  ]) {
    for (const level of EC_LEVELS) {
      it(`reads "${text.slice(0, 16)}" (${text.length} chars, ${level}) back out of its matrix`, () => {
        const version = encode(text, level).version;
        const message = readMessage(text, level);
        expect(message.slice(0, 4)).toBe('0100'); // byte mode
        const countBits = version <= 9 ? 8 : 16;
        const length = parseInt(message.slice(4, 4 + countBits), 2);
        expect(length).toBe(text.length);
        const body = message.slice(4 + countBits);
        let decoded = '';
        for (let i = 0; i < length; i++) {
          decoded += String.fromCharCode(
            parseInt(body.slice(i * 8, i * 8 + 8), 2),
          );
        }
        expect(decoded).toBe(text);
      });
    }
  }
});

describe('estimateBlackPoint', () => {
  it('refuses a single population rather than inventing a split', () => {
    expect(estimateBlackPoint(new Array(500).fill(200))).toEqual({
      blackPoint: 128,
      spread: 0,
    });
  });

  it('refuses two populations too close to tell apart', () => {
    // The failure the old badge could not name: nothing is covered, so a coverage
    // percentage sees a perfect code, but no decoder can binarise it.
    const values = [...new Array(250).fill(242), ...new Array(250).fill(255)];
    expect(estimateBlackPoint(values).spread).toBe(0);
  });

  it('separates real black from real white', () => {
    const values = [...new Array(250).fill(0), ...new Array(250).fill(255)];
    const { blackPoint, spread } = estimateBlackPoint(values);
    expect(spread).toBeGreaterThan(0);
    expect(blackPoint).toBeGreaterThan(0);
    expect(blackPoint).toBeLessThan(255);
  });
});

describe('a real design', () => {
  it('has more than one block, hit unevenly by a centred logo', () => {
    // Not an assertion about damage -- that needs a canvas -- but about the premise:
    // if a version-3 H code were one block, "the worst block binds" would be empty.
    const enc = QRCode.create('https://insdash.ch', {
      errorCorrectionLevel: 'H',
    });
    expect(blockPlan(enc.version, 'H').blocks.length).toBeGreaterThan(1);
  });
});

describe('readCentres', () => {
  /**
   * Everything above this function needs a real browser -- an SVG decoded into an
   * <img>, drawn to a canvas, read back as pixels -- so it cannot be run here. The
   * offset arithmetic can be, and it is the part that fails silently: off by one and
   * the audit reports confident numbers about the wrong modules.
   */
  const SCALE = 9; // must match RASTER_SCALE in audit.ts

  it('reads the centre of each module and ignores its edges', () => {
    const size = 21;
    const quietZone = 4;
    const px = (size + 2 * quietZone) * SCALE;
    const data = new Uint8ClampedArray(px * px * 4);

    // Garbage everywhere, including the whole quiet zone: only the centres are truth.
    data.fill(255);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;

    const wanted: number[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const grey = (r * size + c) % 200;
        wanted.push(grey);
        const x0 = (c + quietZone) * SCALE;
        const y0 = (r + quietZone) * SCALE;
        for (let y = y0; y < y0 + SCALE; y++) {
          for (let x = x0; x < x0 + SCALE; x++) {
            // The middle third carries the value; the ring around it is the opposite,
            // which is what a module edge looks like once a shape is antialiased.
            const centre =
              x >= x0 + 3 && x < x0 + 6 && y >= y0 + 3 && y < y0 + 6;
            const v = centre ? grey : 255 - grey;
            const i = (y * px + x) * 4;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
          }
        }
      }
    }

    expect(readCentres(data, px, size, quietZone)).toEqual(wanted);
  });
});

describe('finderProfiles', () => {
  /**
   * The regression that made the criterion right.
   *
   * Judging the finders module-by-module against the matrix condemned the circular
   * finder -- 48 "obscured" modules on a code with no logo on it at all -- because a
   * circle does not fill the corners of the 7x7 square. A decoder never reads those
   * 49 modules as bits: it *locates* the finder by the 1:1:3:1:1 run through its
   * centre, which a circle preserves exactly.
   */
  /** Binarise then check, the way `auditSamples` does. */
  const profiles = (lums: number[]) =>
    finderProfiles(binarize(lums, size).dark, size);

  /** Luminance for a plain square-finder code, with everything else light. */
  function baseline(size: number): number[] {
    const lums = new Array<number>(size * size).fill(255);
    for (const { row, col } of finderBoxes(size)) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          if (ring || core) lums[(row + r) * size + col + c] = 0;
        }
      }
    }
    return lums;
  }

  const size = 25;

  it('passes a plain square finder, isolated by its separator', () => {
    expect(profiles(baseline(size))).toEqual([true, true, true]);
  });

  it('fails when the separator beside a finder goes dark', () => {
    // The 7x7 is untouched; a decoder still cannot find it, because the outer run has
    // merged with what is next to it. This is the case a 7-module profile misses.
    const lums = baseline(size);
    const { row, col } = finderBoxes(size)[0];
    lums[(row + 3) * size + col + 7] = 0; // the separator on the centre row
    expect(profiles(lums)).toEqual([false, true, true]);
  });

  it('passes a circular finder, whose corners are deliberately empty', () => {
    const lums = baseline(size);
    let cleared = 0;
    for (const { row, col } of finderBoxes(size)) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          // Outside the inscribed circle: exactly what the circle style does not draw.
          if (Math.hypot(r - 3, c - 3) > 3.5) {
            lums[(row + r) * size + col + c] = 255;
            cleared++;
          }
        }
      }
    }
    expect(cleared).toBeGreaterThan(0);
    expect(profiles(lums)).toEqual([true, true, true]);
  });

  it('fails when a single module on the centre line is covered', () => {
    const lums = baseline(size);
    const { row, col } = finderBoxes(size)[0];
    lums[(row + 3) * size + col] = 255; // the leftmost dark run of the profile
    expect(profiles(lums)).toEqual([false, true, true]);
  });

  it('fails when the centre disc is covered', () => {
    const lums = baseline(size);
    const { row, col } = finderBoxes(size)[2];
    for (let r = 2; r <= 4; r++)
      for (let c = 2; c <= 4; c++) lums[(row + r) * size + col + c] = 255;
    expect(profiles(lums)).toEqual([true, true, false]);
  });
});

describe('the function patterns, split by what protects them', () => {
  /**
   * Three different things, and calling them one thing is what produced "14 modules
   * obscured in the format information — no error correction protects those" on a
   * design that was in fact perfectly readable:
   *
   *   - finder discs, *found* by their ratio rather than read (see finderProfiles);
   *   - format and version information, each a BCH codeword written twice;
   *   - timing, alignment and separators, read once with nothing behind them.
   *
   * Only the third kind is fatal per module. This is that partition, checked to be
   * exact and non-overlapping for every version.
   */
  it('partitions the structural cells exactly, for all 40 versions', () => {
    for (let version = 1; version <= 40; version++) {
      const [fmtA, fmtB] = formatInfoCopies(version);
      const ver = versionInfoCopies(version);
      const parts = [
        fmtA,
        fmtB,
        new Set([darkModule(version)]),
        new Set(gridKinds(version).keys()),
      ];
      if (ver) parts.push(...ver);

      const union = new Set<number>();
      let total = 0;
      for (const part of parts) {
        total += part.size;
        for (const k of part) union.add(k);
      }
      const cells = structuralCells(version);
      expect(`v${version} overlap ${total - union.size}`).toBe(
        `v${version} overlap 0`,
      );
      expect(`v${version} covers ${union.size}`).toBe(
        `v${version} covers ${cells.size}`,
      );
      const stray = [...union].filter((k) => !cells.has(k));
      expect(`v${version} stray ${stray.length}`).toBe(`v${version} stray 0`);
    }
  });

  it('has 15 format bits per copy, and 18 version bits from version 7', () => {
    for (let version = 1; version <= 40; version++) {
      const [a, b] = formatInfoCopies(version);
      expect(`v${version} ${a.size}/${b.size}`).toBe(`v${version} 15/15`);
      const ver = versionInfoCopies(version);
      if (version < 7) expect(ver).toBeNull();
      else
        expect(`v${version} ${ver![0].size}/${ver![1].size}`).toBe(
          `v${version} 18/18`,
        );
    }
  });

  it('names what is left: timing on row and column 6, alignment, separators', () => {
    const kinds = gridKinds(3);
    expect(kinds.get(cellKey(6, 12))).toBe('timing');
    expect(kinds.get(cellKey(12, 6))).toBe('timing');
    expect(kinds.get(cellKey(22, 22))).toBe('alignment'); // version 3's only one
    expect(kinds.has(cellKey(8, 2))).toBe(false); // format info: protected, counted apart
  });

  it('prefers the more specific name where an alignment pattern meets the timing run', () => {
    // Version 7 has an alignment pattern centred at row 6, column 22 -- the timing
    // row runs straight through it, and "alignment pattern" is the useful name.
    expect(gridKinds(7).get(cellKey(6, 22))).toBe('alignment');
  });
});
