/**
 * Turns the edited spec into SVG, re-deriving only what actually changed.
 *
 * The art-mode sampling canvas is tiny -- 3 samples per module, so roughly
 * 160x160px for a typical code -- which is why dragging can resample on every
 * frame instead of debouncing and showing stale marks.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { QRSpec } from './spec'
import { encode, matrixFromEncoded, type Matrix } from './encode'
import { encodeCells, loadImage } from './sampler'
import { buildSvg } from './build'

export interface RenderResult {
  svg: string
  matrix: Matrix | null
  /** The spec as rendered, including the encode result and art cells to send to the API. */
  resolved: QRSpec | null
  aspect: number
  /** The decoded artwork, so the audit can redraw the design at trial logo sizes. */
  img: HTMLImageElement | null
  error: string | null
}

const EMPTY: RenderResult = {
  svg: '', matrix: null, resolved: null, aspect: 1, img: null, error: null,
}

/** Decoded logo images, keyed by data URI, so a re-render never re-decodes. */
function useLogoImage(src: string | undefined) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cache = useRef(new Map<string, HTMLImageElement>())

  useEffect(() => {
    if (!src) {
      setImg(null)
      setError(null)
      return
    }
    const hit = cache.current.get(src)
    if (hit) {
      setImg(hit)
      setError(null)
      return
    }
    let live = true
    loadImage(src)
      .then((loaded) => {
        if (!live) return
        cache.current.set(src, loaded)
        setImg(loaded)
        setError(null)
      })
      .catch(() => live && setError('That file could not be read as an image.'))
    return () => {
      live = false
    }
  }, [src])

  return { img, error }
}

export function useRender(spec: QRSpec): RenderResult {
  const { img, error: imgError } = useLogoImage(spec.logo?.src)

  // Encoding depends only on the payload, so styling changes never re-encode.
  const encoded = useMemo(() => {
    try {
      return encode(spec.content.text, spec.content.ecLevel)
    } catch {
      return null
    }
  }, [spec.content.text, spec.content.ecLevel])

  return useMemo(() => {
    if (!encoded) return { ...EMPTY, error: 'That content is too long to fit in a QR code.' }
    const matrix = matrixFromEncoded(encoded)

    try {
      const { spec: effective, svg, cells, aspect } = buildSvg({ ...spec, encoded }, matrix, img)

      // Ship the derived work with the spec so the API draws it rather than redoing it.
      const resolved: QRSpec = {
        ...effective,
        art: { ...effective.art, cells: cells ? encodeCells(cells) : undefined },
      }
      return { svg, matrix, resolved, aspect, img, error: imgError }
    } catch (e) {
      return { ...EMPTY, matrix, error: e instanceof Error ? e.message : String(e) }
    }
  }, [spec, encoded, img, imgError])
}
