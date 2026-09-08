/**
 * QRSpec -> SVG. The single source of every pixel this tool produces: the on-screen
 * preview, the .svg export, and (via canvas) the PNG/JPG are all this same markup.
 *
 * Coordinates are module units; `moduleSize` only ever becomes real pixels in the
 * width/height attributes, so a 400px preview and a 4000px export are the same paths.
 *
 * Mirrors server/inscode/svg.py -- change both together.
 */
import { CellKind, type QRSpec } from './spec'
import type { Matrix } from './encode'
import { cellKey, finderBoxes, finderCells } from './geometry'
import { canvasSize, logoRect, plateRect } from './layout'
import { finderRings, fmt, markPath, modulePath, rectPath, roundedPath } from './shapes'

export interface RenderExtras {
  /** Art-mode per-module decisions. Required in art mode. */
  cells?: Uint8Array | null
  /** Natural width / height of the logo image. */
  logoAspect?: number
  /** Art mode: whether each finder disc is free of opaque artwork. */
  finderClear?: boolean[]
  /** Emit width/height in pixels as well as the viewBox. */
  withPixelSize?: boolean
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** The artwork <image>, rotated about its own centre. */
function imageTag(spec: QRSpec, rect: { x: number; y: number; w: number; h: number }, extra = '') {
  const rot = spec.logo!.rotation
  const t = rot
    ? ` transform="rotate(${fmt(rot)} ${fmt(rect.x + rect.w / 2)} ${fmt(rect.y + rect.h / 2)})"`
    : ''
  return (
    `<image href="${esc(spec.logo!.src)}" x="${fmt(rect.x)}" y="${fmt(rect.y)}" ` +
    `width="${fmt(rect.w)}" height="${fmt(rect.h)}" preserveAspectRatio="none"${t}${extra}/>`
  )
}

/** Building the module path dominates render cost, so it is cached across drags. */
const pathCache = new Map<string, string>()

function modulesPath(spec: QRSpec, matrix: Matrix): string {
  const { shape, gap } = spec.modules
  const key = `${matrix.version}:${matrix.maskPattern}:${matrix.size}:${shape}:${gap}:${spec.canvas.quietZone}`
  const hit = pathCache.get(key)
  if (hit !== undefined) return hit

  const { quietZone } = spec.canvas
  const skip = finderCells(matrix.size)
  const isDark = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < matrix.size && c < matrix.size && matrix.get(r, c)

  const parts: string[] = []
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.get(r, c) || skip.has(cellKey(r, c))) continue
      parts.push(modulePath(r + quietZone, c + quietZone, shape, gap, (rr, cc) =>
        isDark(rr - quietZone, cc - quietZone),
      ))
    }
  }
  const d = parts.join(' ')
  if (pathCache.size > 64) pathCache.clear()
  pathCache.set(key, d)
  return d
}

/**
 * The three finder patterns as one even-odd path: outer ring, middle subtracted,
 * inner dot. Even-odd means the middle ring shows whatever is behind it -- the
 * background colour, or real transparency -- with no white rectangle standing in.
 */
function findersPath(spec: QRSpec, matrix: Matrix): string {
  const { quietZone } = spec.canvas
  const parts: string[] = []
  for (const { row, col } of finderBoxes(matrix.size)) {
    parts.push(...finderRings(row + quietZone, col + quietZone, spec.finders.shape))
  }
  return parts.join(' ')
}

/** Art mode: split the per-module decisions into a dark path and a light path. */
function artPaths(spec: QRSpec, matrix: Matrix, cells: Uint8Array) {
  const { quietZone } = spec.canvas
  const r = spec.art.markSize / 2
  const dark: string[] = []
  const light: string[] = []

  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      const kind = cells[row * matrix.size + col]
      if (kind === CellKind.SKIP) continue
      const R = row + quietZone
      const C = col + quietZone
      if (kind === CellKind.SOLID_DARK) dark.push(rectPath(C, R, 1, 1))
      else if (kind === CellKind.SOLID_LIGHT) light.push(rectPath(C, R, 1, 1))
      else {
        const p = markPath(C + 0.5, R + 0.5, r, spec.art.mark)
        ;(kind === CellKind.MARK_DARK ? dark : light).push(p)
      }
    }
  }
  return { dark: dark.join(' '), light: light.join(' ') }
}

export function renderSvgString(spec: QRSpec, matrix: Matrix, extras: RenderExtras = {}): string {
  const { quietZone, moduleSize, bg } = spec.canvas
  const total = canvasSize(matrix.size, quietZone)
  const transparent = bg === null
  /** What shows through where nothing is drawn. Transparent exports assume white. */
  const light = bg ?? '#ffffff'
  const fg = spec.modules.color
  const finderFill = spec.finders.color ?? fg

  const defs: string[] = []
  const body: string[] = []

  if (!transparent) body.push(`<rect width="${fmt(total)}" height="${fmt(total)}" fill="${bg}"/>`)

  const aspect = extras.logoAspect ?? 1
  const lRect = spec.logo ? logoRect(spec, matrix.size, aspect) : null

  if (spec.mode === 'art') {
    const cells = extras.cells
    if (!cells) throw new Error('art mode needs sampled cells; call decideCells() first')
    const { dark, light: lightPath } = artPaths(spec, matrix, cells)

    // On a transparent background a light module is cut out of the artwork rather
    // than painted over, so the surface behind the code supplies the light value.
    if (lRect) {
      if (transparent && lightPath) {
        defs.push(
          `<mask id="qr-art"><rect width="${fmt(total)}" height="${fmt(total)}" fill="#fff"/>` +
            `<path fill="#000" d="${lightPath}"/></mask>`,
        )
      }
      body.push(imageTag(spec, lRect, transparent && lightPath ? ' mask="url(#qr-art)"' : ''))
    }

    // Artwork showing through a finder's middle ring reads as a dark module, so
    // cover it -- but only where artwork actually reaches, or a transparent export
    // grows three opaque discs it does not need.
    const clear = extras.finderClear ?? [true, true, true]
    const backdrops = finderBoxes(matrix.size)
      .map((b, i) => (clear[i] ? '' : rectPath(b.col + quietZone, b.row + quietZone, 7, 7)))
      .filter(Boolean)
      .join(' ')
    if (backdrops) body.push(`<path fill="${light}" d="${backdrops}"/>`)

    if (!transparent && lightPath) body.push(`<path fill="${light}" d="${lightPath}"/>`)
    if (dark) body.push(`<path fill="${fg}" d="${dark}"/>`)
  } else {
    // Classic: the plate is a painted rounded rect whenever it has a colour to
    // paint -- which is the common case, and needs no <mask> at all. Only a
    // transparent plate has to actually punch a hole through the modules.
    const plate = lRect && spec.logo!.plate.enabled ? plateRect(lRect, spec.logo!.plate.pad) : null
    const plateFill = spec.logo?.plate.color ?? bg
    let maskAttr = ''
    let platePath = ''
    if (plate) {
      const r = Math.min(plate.w, plate.h) * spec.logo!.plate.radius
      platePath = roundedPath(plate.x, plate.y, plate.w, plate.h, [r, r, r, r])
      if (plateFill === null) {
        defs.push(
          `<mask id="qr-plate"><rect width="${fmt(total)}" height="${fmt(total)}" fill="#fff"/>` +
            `<path fill="#000" d="${platePath}"/></mask>`,
        )
        maskAttr = ' mask="url(#qr-plate)"'
      }
    }

    body.push(`<g${maskAttr}>`)
    body.push(`<path fill="${fg}" d="${modulesPath(spec, matrix)}"/>`)
    body.push(`<path fill="${finderFill}" fill-rule="evenodd" d="${findersPath(spec, matrix)}"/>`)
    body.push('</g>')

    if (platePath && plateFill !== null) body.push(`<path fill="${plateFill}" d="${platePath}"/>`)

    if (lRect) body.push(imageTag(spec, lRect))
  }

  if (spec.mode === 'art') {
    body.push(`<path fill="${finderFill}" fill-rule="evenodd" d="${findersPath(spec, matrix)}"/>`)
  }

  const px = fmt(total * moduleSize)
  const sizeAttrs = extras.withPixelSize ? ` width="${px}" height="${px}"` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(total)} ${fmt(total)}"${sizeAttrs} shape-rendering="geometricPrecision">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    '</svg>'
  )
}
