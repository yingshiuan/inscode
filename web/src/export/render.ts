/**
 * Export. Everything derives from the same SVG string the preview shows, so a
 * 4000px PNG is the preview at a different scale -- never a second drawing.
 */

/**
 * Force explicit pixel dimensions on an SVG root. Safari rasterises to nothing without them.
 *
 * The root tag only: every width/height inside is in module units, and an <image> or
 * <rect> stripped of them draws nothing -- the logo, the background and the plate mask
 * all silently vanish from the file.
 */
export function withPixelSize(svg: string, px: number): string {
  return svg.replace(/<svg\b[^>]*>/, (root) =>
    root.replace(/\s(width|height)="[^"]*"/g, '').replace('<svg ', `<svg width="${px}" height="${px}" `),
  )
}

export function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
}

/** Decode an SVG string into an <img>. Object URLs keep the canvas untainted. */
export function svgToImage(svg: string): Promise<HTMLImageElement> {
  return blobToImage(svgBlob(svg))
}

/**
 * The logo as a PNG data URI when it is an SVG, else null.
 *
 * Figma draws nothing for an <image> that holds an SVG, so a vector logo goes into .svg
 * files as pixels. Rendered at the export size, but no less than 2048px on its longest
 * edge so it survives being scaled up, and no more than 4096px so the file stays sane.
 */
export async function svgLogoAsPng(src: string, px: number): Promise<string | null> {
  if (!src.startsWith('data:image/svg+xml')) return null
  const img = await blobToImage(await (await fetch(src)).blob())
  // The renderer sizes the <image> by this same ratio, so the pixels are not stretched.
  const aspect = img.naturalWidth / img.naturalHeight || 1
  const edge = Math.min(Math.max(px, 2048), 4096)
  const canvas = document.createElement('canvas')
  canvas.width = aspect >= 1 ? edge : Math.round(edge * aspect)
  canvas.height = aspect >= 1 ? Math.round(edge / aspect) : edge
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('could not rasterise the SVG'))
    }
    img.src = url
  })
}

export async function rasterize(
  svg: string,
  px: number,
  { matte = null, type = 'image/png', quality = 0.95 }:
    { matte?: string | null; type?: string; quality?: number } = {},
): Promise<Blob> {
  const img = await svgToImage(withPixelSize(svg, px))
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')!
  if (matte) {
    ctx.fillStyle = matte
    ctx.fillRect(0, 0, px, px)
  }
  ctx.drawImage(img, 0, 0, px, px)
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), type, quality)
  })
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A filesystem-safe stem taken from the QR's own content. */
export function filenameFor(text: string): string {
  const stem = text
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase()
  return stem || 'qr-code'
}
