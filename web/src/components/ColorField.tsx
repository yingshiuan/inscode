import { useEffect, useRef, useState } from 'react'
import { HexColorPicker } from 'react-colorful'

/** A colour swatch that opens a picker. `null` renders as the transparency checker. */
export function ColorField({
  value, onChange, onCommitStart, onCommitEnd, allowTransparent = false,
}: {
  value: string | null
  onChange: (v: string | null) => void
  onCommitStart?: () => void
  onCommitEnd?: () => void
  allowTransparent?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false)
        onCommitEnd?.()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onCommitEnd])

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!open) onCommitStart?.()
            setOpen((v) => !v)
          }}
          className={`h-8 w-8 shrink-0 rounded-md border border-line ${value === null ? 'checker' : ''}`}
          style={value ? { background: value } : undefined}
          aria-label="Choose colour"
        />
        <input
          value={value ?? 'transparent'}
          disabled={value === null}
          onChange={(e) => {
            const v = e.target.value.trim()
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v)
          }}
          className="h-8 w-full min-w-0 rounded-md border border-line px-2 font-mono text-[11px] uppercase disabled:bg-panel disabled:text-muted"
        />
        {allowTransparent && (
          <button
            type="button"
            onClick={() => onChange(value === null ? '#ffffff' : null)}
            title={value === null ? 'Use a solid colour' : 'Make transparent'}
            className={`h-8 shrink-0 rounded-md border px-2 text-[11px] transition ${
              value === null ? 'border-ink bg-ink text-white' : 'border-line text-muted hover:border-zinc-300'
            }`}
          >
            None
          </button>
        )}
      </div>

      {open && value !== null && (
        <div className="absolute right-0 z-30 mt-2 rounded-lg border border-line bg-white p-2 shadow-lg">
          <HexColorPicker color={value} onChange={onChange} />
        </div>
      )}
    </div>
  )
}
