/**
 * The preview, and the drag surface for the logo.
 *
 * The QR itself is the rendered SVG string, injected as markup. The interactive
 * layer is a separate SVG sharing the same viewBox, so handles are positioned in
 * module units and stay aligned at any zoom without a second coordinate system.
 */
import { useCallback, useRef, useState } from 'react'
import type { QRSpec } from '../../qr/spec'
import type { RenderResult } from '../../qr/useRender'
import { canvasSize, logoRect } from '../../qr/layout'
import { useQrStore } from '../../store/useQrStore'

/** Snap the logo to the centre lines within this fraction of the code width. */
const SNAP = 0.014

/** Grab area around each corner handle, in module units. */
const HANDLE_TOUCH = 2.6

type Drag =
  | { kind: 'move'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'scale'; corner: number; startScale: number; startDist: number }

export function QrCanvas({ spec, render }: { spec: QRSpec; render: RenderResult }) {
  const { patchLogo, begin, end } = useQrStore()
  const surfaceRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false })

  const matrix = render.matrix
  const total = matrix ? canvasSize(matrix.size, spec.canvas.quietZone) : 1
  const rect = matrix && spec.logo ? logoRect(spec, matrix.size, render.aspect) : null

  /** Client pixels -> module units on the canvas. */
  const toModules = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const box = surfaceRef.current!.getBoundingClientRect()
      return {
        x: ((e.clientX - box.left) / box.width) * total,
        y: ((e.clientY - box.top) / box.height) * total,
      }
    },
    [total],
  )

  const startDrag = (e: React.PointerEvent, make: (p: { x: number; y: number }) => Drag) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragRef.current = make(toModules(e))
    begin()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || !matrix || !spec.logo) return
    const size = matrix.size
    const p = toModules(e)

    if (drag.kind === 'move') {
      let x = drag.originX + (p.x - drag.startX) / size
      let y = drag.originY + (p.y - drag.startY) / size
      // Alt bypasses snapping for fine placement.
      const snapping = !e.altKey
      const snapX = snapping && Math.abs(x - 0.5) < SNAP
      const snapY = snapping && Math.abs(y - 0.5) < SNAP
      if (snapX) x = 0.5
      if (snapY) y = 0.5
      setGuides({ x: snapX, y: snapY })
      // Keep the centre inside the code area; the logo may overhang, the grip may not.
      patchLogo({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) })
    } else {
      const cx = spec.canvas.quietZone + spec.logo.x * size
      const cy = spec.canvas.quietZone + spec.logo.y * size
      const dist = Math.hypot(p.x - cx, p.y - cy)
      const next = drag.startScale * (dist / Math.max(drag.startDist, 0.001))
      patchLogo({ scale: clamp(next, 0.04, 1) })
    }
  }

  const stop = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    setGuides({ x: false, y: false })
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    end()
  }

  const transparent = spec.canvas.bg === null

  return (
    <div className="relative w-full">
      <div
        className={`relative w-full overflow-hidden rounded-xl border border-line shadow-sm ${
          transparent ? 'checker' : ''
        }`}
        style={{ aspectRatio: '1 / 1' }}
      >
        <div
          className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: render.svg }}
        />

        <svg
          ref={surfaceRef}
          viewBox={`0 0 ${total} ${total}`}
          className="absolute inset-0 h-full w-full touch-none"
          onPointerMove={onPointerMove}
          onPointerUp={stop}
          onPointerCancel={stop}
        >
          {guides.x && <line x1={total / 2} y1={0} x2={total / 2} y2={total} stroke="#2563eb" strokeWidth={0.08} strokeDasharray="0.6 0.4" />}
          {guides.y && <line x1={0} y1={total / 2} x2={total} y2={total / 2} stroke="#2563eb" strokeWidth={0.08} strokeDasharray="0.6 0.4" />}

          {rect && spec.logo && (
            <g>
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                fill="transparent"
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={(e) =>
                  startDrag(e, (p) => ({
                    kind: 'move',
                    startX: p.x,
                    startY: p.y,
                    originX: spec.logo!.x,
                    originY: spec.logo!.y,
                  }))
                }
              />
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                fill="none"
                stroke="#2563eb"
                strokeWidth={0.07}
                strokeDasharray="0.5 0.35"
                pointerEvents="none"
              />
              {[
                [rect.x, rect.y],
                [rect.x + rect.w, rect.y],
                [rect.x + rect.w, rect.y + rect.h],
                [rect.x, rect.y + rect.h],
              ].map(([hx, hy], i) => (
                <g
                  key={i}
                  className={i % 2 === 0 ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}
                  onPointerDown={(e) =>
                    startDrag(e, (p) => {
                      const cx = spec.canvas.quietZone + spec.logo!.x * matrix!.size
                      const cy = spec.canvas.quietZone + spec.logo!.y * matrix!.size
                      return {
                        kind: 'scale',
                        corner: i,
                        startScale: spec.logo!.scale,
                        startDist: Math.hypot(p.x - cx, p.y - cy),
                      }
                    })
                  }
                >
                  {/* A fingertip is far wider than the drawn handle, and on a phone
                      the whole code may be 340px across. The target is invisible and
                      generous; the handle stays small enough to see past. */}
                  <rect
                    x={hx - HANDLE_TOUCH / 2}
                    y={hy - HANDLE_TOUCH / 2}
                    width={HANDLE_TOUCH}
                    height={HANDLE_TOUCH}
                    fill="transparent"
                  />
                  <rect
                    x={hx - 0.45}
                    y={hy - 0.45}
                    width={0.9}
                    height={0.9}
                    rx={0.18}
                    fill="#fff"
                    stroke="#2563eb"
                    strokeWidth={0.09}
                    pointerEvents="none"
                  />
                </g>
              ))}
            </g>
          )}
        </svg>
      </div>

      {spec.logo && (
        <p className="mt-2 text-center text-[11px] leading-snug text-muted">
          Drag the logo to move it · corners resize
          <span className="hidden lg:inline">
            {' '}· hold <kbd className="rounded border border-line bg-panel px-1">Alt</kbd> to
            bypass snapping
          </span>
        </p>
      )}
    </div>
  )
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
