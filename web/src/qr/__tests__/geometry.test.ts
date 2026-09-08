import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import {
  alignmentCoords,
  cellKey,
  finderBoxes,
  reservedCells,
  structuralCells,
} from '../geometry';
import { encode, matrixFromEncoded, symbolSize } from '../encode';

/**
 * node-qrcode knows exactly which cells are function patterns. Our geometry has to
 * derive the same answer from version alone, because the Python renderer has no
 * equivalent call and must agree module-for-module. This is that proof.
 */
describe('reservedCells vs node-qrcode isReserved()', () => {
  for (let version = 1; version <= 40; version++) {
    it(`agrees for version ${version}`, () => {
      const qr = QRCode.create('x', { version, errorCorrectionLevel: 'L' });
      const size = qr.modules.size;
      expect(size).toBe(symbolSize(version));

      const ours = reservedCells(version);
      const theirs = new Set<number>();
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (qr.modules.isReserved(r, c)) theirs.add(cellKey(r, c));
        }
      }

      const missing = [...theirs].filter((k) => !ours.has(k));
      const extra = [...ours].filter((k) => !theirs.has(k));
      const fmt = (ks: number[]) =>
        ks
          .slice(0, 8)
          .map((k) => `(${k >> 8},${k & 255})`)
          .join(' ');
      expect(`missing ${missing.length} [${fmt(missing)}]`).toBe(
        'missing 0 []',
      );
      expect(`extra ${extra.length} [${fmt(extra)}]`).toBe('extra 0 []');
    });
  }
});

describe('alignmentCoords', () => {
  it('version 1 has none', () => expect(alignmentCoords(1)).toEqual([]));
  it('matches the spec table for known versions', () => {
    expect(alignmentCoords(2)).toEqual([6, 18]);
    expect(alignmentCoords(7)).toEqual([6, 22, 38]);
    expect(alignmentCoords(32)).toEqual([6, 34, 60, 86, 112, 138]);
  });
});

describe('finder geometry', () => {
  it('places three boxes at the corners', () => {
    expect(finderBoxes(25)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 18 },
      { row: 18, col: 0 },
    ]);
  });
  it('structuralCells excludes the finder discs', () => {
    const s = structuralCells(7);
    expect(s.has(cellKey(0, 0))).toBe(false);
    expect(s.has(cellKey(6, 10))).toBe(true); // timing row
  });
});

describe('encode', () => {
  it('round-trips the matrix through base64 bits', () => {
    const enc = encode('https://insdash.ch', 'H');
    const m = matrixFromEncoded(enc);
    const direct = QRCode.create('https://insdash.ch', {
      errorCorrectionLevel: 'H',
      maskPattern: enc.maskPattern as 0,
    });
    for (let r = 0; r < enc.size; r++) {
      for (let c = 0; c < enc.size; c++) {
        expect(m.get(r, c)).toBe(Boolean(direct.modules.get(r, c)));
      }
    }
  });

  it('pins the mask pattern so a re-encode reproduces it exactly', () => {
    const a = encode('https://insdash.ch', 'H');
    const b = encode('https://insdash.ch', 'H', a.maskPattern);
    expect(b.maskPattern).toBe(a.maskPattern);
    expect(b.bits).toBe(a.bits);
    expect(b.version).toBe(a.version);
  });

  it('honours every mask 0..7', () => {
    const seen = new Set<string>();
    for (let mp = 0; mp <= 7; mp++) {
      const e = encode('https://insdash.ch', 'H', mp);
      expect(e.maskPattern).toBe(mp);
      seen.add(e.bits);
    }
    expect(seen.size).toBe(8); // each mask really does produce a different matrix
  });
});
