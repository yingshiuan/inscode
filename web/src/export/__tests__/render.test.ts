import { describe, expect, it } from 'vitest'
import { withPixelSize } from '../render'
import { defaultSpec } from '../../qr/spec'
import { encode, matrixFor } from '../../qr/encode'
import { renderSvgString } from '../../qr/renderSvg'

/**
 * Every export, and the decoder check that gates it, goes through withPixelSize. It
 * used to strip width/height from the whole document, which erased the logo <image>,
 * the background <rect> and the plate mask from every file while the preview -- which
 * never goes through it -- still showed them.
 */

const TEXT = 'https://insdash.ch'

describe('withPixelSize sizes the root and nothing else', () => {
  for (const bg of ['#ffffff', null]) {
    it(`leaves the drawing untouched with a logo on ${bg ?? 'transparent'}`, () => {
      const s = defaultSpec(TEXT)
      s.encoded = encode(TEXT, s.content.ecLevel)
      s.canvas.bg = bg
      s.logo = {
        src: 'data:image/png;base64,AAAA',
        x: 0.5, y: 0.5, scale: 0.22, rotation: 0,
        plate: { enabled: true, pad: 0.7, radius: 0.18, color: null },
      }
      const svg = renderSvgString(s, matrixFor(s), { logoAspect: 1 })
      const sized = withPixelSize(svg, 1024)

      expect(sized.startsWith('<svg width="1024" height="1024" ')).toBe(true)
      expect(sized.slice(sized.indexOf('>'))).toBe(svg.slice(svg.indexOf('>')))
    })
  }

  it('replaces a size the root already has', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="200" height="200"><rect width="10" height="10"/></svg>'
    expect(withPixelSize(svg, 64)).toBe(
      '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    )
  })
})
