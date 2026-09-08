/**
 * The half of the logo profile that has to be identical in Python.
 *
 * `profilePixels` decides whether a user is told to change their asset, so a
 * browser that answers differently from the API would have the tool contradicting
 * itself about the same file. The buffers below are built from arithmetic that
 * server/tests/test_logoink.py repeats exactly, and the expected values are the
 * same literals there -- if either side drifts, one of the two suites goes red.
 *
 * Everything above this line needs a canvas to get at the pixels, so it is not
 * reachable from a node test; it is covered on the Python side instead.
 */
import { describe, expect, it } from 'vitest'
import { parseSpec } from '../spec'
import { coveredCentres, isTone, profilePixels, sampleAxis } from '../logoInk'

type Pixel = [number, number, number, number]

/** Mirrors `buf` in test_logoink.py. */
function buf(w: number, h: number, fn: (x: number, y: number) => Pixel): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  let i = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y)
      out[i++] = r
      out[i++] = g
      out[i++] = b
      out[i++] = a
    }
  }
  return out
}

/** A disc of ink on transparency -- what a properly exported logo looks like. */
const cutout = (x: number, y: number): Pixel =>
  (x - 32) ** 2 + (y - 32) ** 2 <= 24 * 24 ? [20, 40, 90, 255] : [0, 0, 0, 0]

const flatWhite = (x: number, y: number): Pixel =>
  x >= 12 && x < 52 && y >= 20 && y < 44 ? [16, 24, 56, 255] : [255, 255, 255, 255]

const flatBlack = (x: number, y: number): Pixel =>
  x >= 12 && x < 52 && y >= 20 && y < 44 ? [240, 240, 240, 255] : [0, 0, 0, 255]

const photo = (x: number, y: number): Pixel => [
  (x * 7 + y * 3) % 256,
  (x * 3 + y * 11) % 256,
  (x * 13 + y * 5) % 256,
  255,
]

const duotone = (x: number, y: number): Pixel =>
  (x + y) % 40 < 20 ? [230, 90, 40, 255] : [20, 40, 90, 255]

describe('sampleAxis', () => {
  it('lands on cell centres', () => {
    expect(sampleAxis(4, 64)).toEqual([8, 24, 40, 56])
    expect(sampleAxis(3, 3)).toEqual([0, 1, 2])
  })

  it('never runs off the end, whatever the ratio', () => {
    for (const extent of [1, 7, 64, 512, 4000]) {
      const got = sampleAxis(Math.min(96, extent), extent)
      expect(got[0]).toBeGreaterThanOrEqual(0)
      expect(got[got.length - 1]).toBeLessThan(extent)
      expect(got).toEqual([...got].sort((a, b) => a - b))
    }
  })
})

describe('profilePixels', () => {
  // The same five rows as test_logoink.py::test_profile_pixels, same literals.
  const cases: [string, (x: number, y: number) => Pixel, number, string | null, number][] = [
    // A cutout has a transparent border, so no background is claimed at all.
    ['cutout', cutout, 0.4377, null, 0],
    ['flat white', flatWhite, 1, '255,255,255', 0.7656],
    ['flat black', flatBlack, 1, '0,0,0', 0.7656],
    // Both of these are opaque and neither has a field to key out.
    ['photo', photo, 1, null, 0],
    ['duotone', duotone, 1, null, 0],
  ]

  it.each(cases)('%s', (_name, fn, opaque, background, share) => {
    const ink = profilePixels(buf(64, 64, fn), 64, 64)
    expect(Number(ink.opaque.toFixed(4))).toBe(opaque)
    expect(ink.background ? ink.background.join(',') : null).toBe(background)
    expect(Number(ink.backgroundShare.toFixed(4))).toBe(share)
  })

  it('finds a flat field but scores it below the floor when it is only a margin', () => {
    const hairline = (x: number, y: number): Pixel =>
      x < 2 || y < 2 || x > 61 || y > 61 ? [255, 255, 255, 255] : [30, 60, 120, 255]
    const ink = profilePixels(buf(64, 64, hairline), 64, 64)
    expect(ink.background).toEqual([255, 255, 255])
    expect(ink.backgroundShare).toBeLessThan(0.15)
  })
})

describe('isTone', () => {
  it('absorbs compression noise without reaching real artwork', () => {
    expect(isTone(250, 252, 255, [255, 255, 255])).toBe(true)
    expect(isTone(230, 255, 255, [255, 255, 255])).toBe(false)
  })
})

describe('coveredCentres', () => {
  const spec = (rotation = 0) =>
    parseSpec({
      content: { text: 'https://insdash.ch' },
      logo: { src: 'data:,', scale: 0.3, rotation, plate: { enabled: false } },
    })

  /** The rect logoRect would produce for a square logo on a 25-module code. */
  const rect = { x: 4 + 25 * 0.35, y: 4 + 25 * 0.35, w: 25 * 0.3, h: 25 * 0.3 }

  it('counts the module centres under the artwork', () => {
    const n = [...coveredCentres(spec(), 25, rect)].length
    // A 7.5-module box lands on 7 or 8 centres per side depending on phase.
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(64)
  })

  it('reports where inside the artwork each centre falls', () => {
    for (const { u, v } of coveredCentres(spec(), 25, rect)) {
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('turns the rectangle with the image rather than ignoring rotation', () => {
    const straight = [...coveredCentres(spec(0), 25, rect)].map((p) => `${p.u},${p.v}`)
    const turned = [...coveredCentres(spec(30), 25, rect)].map((p) => `${p.u},${p.v}`)
    expect(turned).not.toEqual(straight)
  })
})
