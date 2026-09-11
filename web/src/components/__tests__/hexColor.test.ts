import { describe, expect, it } from 'vitest'
import { parseHex } from '../hexColor'

describe('parseHex reads a colour as it arrives on the clipboard', () => {
  it('takes #rrggbb in either case', () => {
    expect(parseHex('#ff0000')).toBe('#ff0000')
    expect(parseHex('#FF00AA')).toBe('#ff00aa')
  })

  it('takes the digits without a hash, the way design tools copy them', () => {
    expect(parseHex('1A2B3C')).toBe('#1a2b3c')
  })

  it('ignores whitespace around the value', () => {
    expect(parseHex('  #00ff00\n')).toBe('#00ff00')
  })

  it('expands #rgb shorthand', () => {
    expect(parseHex('#fa0')).toBe('#ffaa00')
    expect(parseHex('FA0')).toBe('#ffaa00')
  })

  it('rejects anything that is not exactly one colour', () => {
    for (const text of ['', '#', '#12345', '#1234567', '#12345g', '#000000#ff0000', 'rgb(0,0,0)', 'red'])
      expect(parseHex(text), text).toBeNull()
  })
})
