/**
 * Read a hex colour the way people actually copy one: with or without the `#`
 * (design tools mostly copy it without), in either case, surrounding whitespace
 * ignored, `#rgb` shorthand expanded. Returns the canonical `#rrggbb`, or null.
 */
export function parseHex(text: string): string | null {
  const digits = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text.trim())?.[1]
  if (!digits) return null
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits
  return `#${full.toLowerCase()}`
}
