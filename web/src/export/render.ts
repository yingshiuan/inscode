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
  const url = URL.createObjectURL(svgBlob(svg))
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
