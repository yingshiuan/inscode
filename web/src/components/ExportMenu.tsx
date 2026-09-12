import { useEffect, useRef, useState } from 'react'
import type { QRSpec } from '../qr/spec'
import { download, filenameFor, rasterize, svgBlob, svgLogoAsPng, withPixelSize } from '../export/render'
import { ApiError, apiAvailable, renderOnServer } from '../api/client'
import { describeOutput, exportPxFor, PRINT_DPI, pxToMm } from '../qr/output'
import { designKey, PRODUCTION, reads } from '../qr/oracle'
import { decideExport, decideServerExport, type ExportDecision } from '../qr/exportGuard'
import { useQrStore } from '../store/useQrStore'

const SIZES = [512, 1024, 2048, 4096]

/**
 * PNG, JPG and SVG all come from the same markup the preview shows, so what you see is
 * what lands in the file.
 *
 * Export is the one place nothing is taken on trust. Clicking a format puts the exact
 * artifact -- the drawing that is about to be written to disk -- through the production
 * decoder, and the file is produced only if it comes back readable.
 *
 * `verifiedSafeScale` deliberately does not authorize this. It is the answer to a
 * search that samples logo sizes on a 0.02 grid, and the decoder is not monotone in
 * logo size, so a failure narrower than the grid sits between two passing samples: the
 * calibration matrix contains a design whose verified answer is 0.459 and which does
 * not read at 0.45. It is wrong the other way too, finding no answer at all for designs
 * that read perfectly well. The number keeps its job in the badge and in the *Shrink
 * logo to N%* suggestion; it just does not get to sign anything off.
 *
 * When this browser cannot run the check -- no canvas filters, so the production
 * profile cannot be applied -- the API is asked instead. `POST /api/render` performs
 * the identical check on the identical drawing and returns the file with it, so the
 * fallback is a real decoder verdict rather than a shrug.
 */

export function ExportMenu({
  spec, svg, resolved, modules, onBatch,
}: {
  spec: QRSpec
  svg: string
  /** The spec as rendered, with encode result and art cells, for the API. */
  resolved: QRSpec | null
  /** Symbol width including the quiet zone, for sizing the decoder check. */
  modules: number
  onBatch: () => void
}) {
  const output = useQrStore((s) => s.output)
  const safety = useQrStore((s) => s.safety)
  const patchLogo = useQrStore((s) => s.patchLogo)
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(1024)
  const [busy, setBusy] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<ExportDecision | null>(null)
  const [server, setServer] = useState(false)
  const [hasApi, setHasApi] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && !hasApi) apiAvailable().then(setHasApi)
  }, [open, hasApi])

  useEffect(() => {
    if (!open) return
    // pointerdown so a tap outside closes it; touch screens synthesise mousedown
    // late enough that the menu can eat the next tap.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const transparent = spec.canvas.bg === null
  const stem = filenameFor(spec.content.text)
  // Keyed off `resolved`, not `spec`: the badge computes its key from the spec *plus*
  // the encode result, and `spec` alone carries no `encoded`, so keying on it never
  // matches and every refusal silently loses its shrink suggestion.
  const fresh = resolved !== null && safety.key === designKey(resolved)
  // Advisory only: shown before the click so a doomed export can be avoided, never
  // consulted for permission.
  const advice =
    spec.logo && fresh && safety.status === 'verified' && safety.verified !== null &&
    spec.logo.scale > safety.verified + 0.005
      ? safety.verified
      : null

  /** Export through the API, whose 422 is a decoder verdict on this exact artifact. */
  const saveViaServer = async (format: 'png' | 'jpg' | 'svg', drawn: QRSpec): Promise<ExportDecision | null> => {
    try {
      download(await renderOnServer(drawn, format, size), `${stem}.${format}`)
      setOpen(false)
      return null
    } catch (e) {
      return decideServerExport(
        e instanceof ApiError
          ? { ok: false, status: e.status, message: e.message, verifiedSafeScale: e.verifiedSafeScale }
          : { ok: false, status: 0, message: String(e), verifiedSafeScale: null },
      )
    }
  }

  const save = async (format: 'png' | 'jpg' | 'svg') => {
    if (!svg) return
    setBusy(format)
    setBlocked(null)
    try {
      // Figma draws nothing for an <image> holding an SVG, so an .svg file carries a
      // vector logo as a PNG -- and it is that file, not the preview, that gets checked.
      const logoSrc = format === 'svg' ? spec.logo?.src : undefined
      const png = logoSrc ? await svgLogoAsPng(logoSrc, size) : null
      const fileSvg = logoSrc && png ? svg.split(logoSrc).join(png) : svg
      const fileSpec = png && resolved?.logo ? { ...resolved, logo: { ...resolved.logo, src: png } } : resolved

      // The whole gate: this exact artifact, put to the production decoder.
      const verdict = await reads(fileSvg, spec.content.text, modules, PRODUCTION)

      if (verdict === 'unavailable' && fileSpec) {
        // Borrow the API's verdict rather than refusing on no evidence. Verification
        // there is part of rendering, so the answer arrives as the file itself.
        setBlocked(await saveViaServer(format, fileSpec))
        return
      }

      const decision = decideExport(verdict, {
        verified: fresh ? safety.verified : null,
        unstable: fresh ? safety.unstable : false,
        currentScale: spec.logo?.scale ?? null,
      })
      if (!decision.allowed) {
        setBlocked(decision)
        return
      }
      if (server && fileSpec) {
        // The resolved spec carries the browser's own encode and art decisions, so
        // the server draws what the preview showed instead of deciding again.
        setBlocked(await saveViaServer(format, fileSpec))
        return
      } else if (format === 'svg') {
        download(svgBlob(withPixelSize(fileSvg, size)), `${stem}.svg`)
      } else if (format === 'png') {
        download(await rasterize(svg, size), `${stem}.png`)
      } else {
        // JPEG has no alpha, so a transparent design has to be flattened onto
        // something. White is the honest default rather than a silent black.
        download(
          await rasterize(svg, size, { matte: '#ffffff', type: 'image/jpeg', quality: 0.95 }),
          `${stem}.jpg`,
        )
      }
      setOpen(false)
    } catch (e) {
      console.error(e)
      setBlocked({
        allowed: false,
        reason: 'That export could not be produced. Try a different format or size.',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!svg}
        className="h-9 rounded-md bg-ink px-3 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 lg:h-8"
      >
        Export ▾
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 max-h-[75dvh] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-lg border border-line bg-white p-3 shadow-xl">
          <div className="mb-1.5 text-[11px] font-medium text-ink">Size</div>
          {/* The size the design is actually for, so the export does not have to be
              worked out backwards from a round number of pixels. */}
          <button
            onClick={() => setSize(exportPxFor(output))}
            className={`mb-1 flex h-9 w-full items-center justify-between rounded border px-2 text-[11px] transition lg:h-7 ${
              size === exportPxFor(output)
                ? 'border-ink bg-ink text-white'
                : 'border-line hover:bg-panel'
            }`}
          >
            <span>Final size · {describeOutput(output)}</span>
            <span className="tabular-nums">{exportPxFor(output)} px</span>
          </button>
          <div className="grid grid-cols-4 gap-1">
            {SIZES.map((s) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                className={`h-9 rounded border text-[11px] tabular-nums transition lg:h-7 ${
                  size === s ? 'border-ink bg-ink text-white' : 'border-line hover:bg-panel'
                }`}
              >
                {s >= 1024 ? `${s / 1024}k` : s}
              </button>
            ))}
          </div>
          <p className="mb-3 mt-1.5 text-[10px] text-muted">
            {size} px is {Math.round(pxToMm(size))} mm at {PRINT_DPI} dpi
          </p>

          {blocked && !blocked.allowed ? (
            <div className="mb-2 rounded-md border border-red-200 bg-red-50 p-2">
              <p className="text-[11px] leading-snug text-red-900">{blocked.reason}</p>
              {blocked.shrinkTo !== undefined && (
                <button
                  onClick={() => {
                    patchLogo({ scale: blocked.shrinkTo! })
                    setBlocked(null)
                  }}
                  className="mt-1.5 w-full rounded border border-red-300 bg-white px-2 py-1 text-[11px] font-medium text-red-900 transition hover:bg-red-100"
                >
                  Shrink logo to {Math.round(blocked.shrinkTo * 100)}% and try again
                </button>
              )}
            </div>
          ) : (
            advice !== null && (
              <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2">
                <p className="text-[11px] leading-snug text-amber-900">
                  The logo is at {Math.round(spec.logo!.scale * 100)}%. The decoder read this
                  design up to {Math.round(advice * 100)}% — export will check this exact file
                  before writing it.
                </p>
                <button
                  onClick={() => patchLogo({ scale: advice })}
                  className="mt-1.5 w-full rounded border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100"
                >
                  Shrink logo to {Math.round(advice * 100)}%
                </button>
              </div>
            )
          )}

          <div className="space-y-1">
            {(['png', 'svg', 'jpg'] as const).map((f) => (
              <button
                key={f}
                onClick={() => save(f)}
                disabled={busy !== null}
                className="flex w-full items-center justify-between rounded-md px-2 py-2.5 text-left text-xs transition hover:bg-panel disabled:opacity-50 lg:py-2"
              >
                <span className="font-medium uppercase">{f}</span>
                <span className="text-[11px] text-muted">
                  {busy === f
                    ? 'Checking…'
                    : f === 'svg'
                      ? 'Vector, editable'
                      : f === 'png'
                        ? transparent ? 'Keeps transparency' : `${size}px`
                        : transparent ? 'Flattened on white' : `${size}px`}
                </span>
              </button>
            ))}
          </div>

          {transparent && (
            <p className="mt-2 border-t border-line pt-2 text-[11px] leading-snug text-muted">
              JPEG has no alpha channel, so a transparent design is flattened onto white. Use PNG
              or SVG to keep it.
            </p>
          )}

          <div className="mt-2 space-y-2 border-t border-line pt-2">
            {hasApi && (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={server}
                  onChange={(e) => setServer(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-[11px] leading-snug text-muted">
                  <span className="font-medium text-ink">Render on server</span> — same drawing,
                  produced by the Python API. Useful for very large print sizes.
                </span>
              </label>
            )}
            <button
              onClick={() => {
                setOpen(false)
                onBatch()
              }}
              className="w-full rounded-md border border-line px-2 py-2 text-left text-[11px] transition hover:bg-panel"
            >
              <span className="font-medium text-ink">Batch generate…</span>
              <span className="block text-muted">Many links, one style, as a ZIP</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
