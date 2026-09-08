/**
 * node-qrcode's Reed-Solomon block table, which it does not export publicly.
 *
 * Only the tests reach in here: blocks.ts carries its own copy of ISO Table 9, and
 * audit.test.ts pins that copy against this one for all 40 versions -- the same
 * arrangement geometry.ts has with `isReserved()`. Shipping code never imports it,
 * so an internal reshuffle in a future node-qrcode breaks a test rather than the app.
 */
declare module 'qrcode/lib/core/error-correction-code.js' {
  const ECCode: {
    getBlocksCount(version: number, level: unknown): number
    getTotalCodewordsCount(version: number, level: unknown): number
  }
  export default ECCode
}

declare module 'qrcode/lib/core/error-correction-level.js' {
  const ECLevel: Record<'L' | 'M' | 'Q' | 'H', { bit: number }>
  export default ECLevel
}

declare module 'qrcode/lib/core/utils.js' {
  const Utils: { getSymbolTotalCodewords(version: number): number }
  export default Utils
}
