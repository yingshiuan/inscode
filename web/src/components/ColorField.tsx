import { useEffect, useRef, useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { parseHex } from './hexColor'

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
  /** What is in the text box while it disagrees with `value`; null shows `value`. */
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // pointerdown, not mousedown: a tap on a touch screen only synthesises mouse
    // events after the gesture settles, which leaves the picker open under a finger.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false)
        onCommitEnd?.()
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, onCommitEnd])

  const apply = (text: string) => {
    const hex = parseHex(text)
    if (hex && hex !== value?.toLowerCase()) onChange(hex)
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!open) onCommitStart?.()
            setOpen((v) => !v)
          }}
          className={`h-10 w-10 shrink-0 rounded-md border border-line lg:h-8 lg:w-8 ${value === null ? 'checker' : ''}`}
          style={value ? { background: value } : undefined}
          aria-label="Choose colour"
        />
        <input
          value={draft ?? value ?? 'transparent'}
          disabled={value === null}
          onChange={(e) => {
            // The box has to hold half-typed text, or every keystroke short of a whole
            // colour snaps back and the field can't be edited at all. Only a complete
            // six-digit colour goes live: `#fff` is also the start of `#fff000`, and
            // applying it would land a history entry for a colour nobody chose.
            const text = e.target.value
            setDraft(text)
            if (text.trim().replace(/^#/, '').length === 6) apply(text)
          }}
          onPaste={(e) => {
            // A pasted colour replaces the field instead of being spliced in at the cursor.
            const hex = parseHex(e.clipboardData.getData('text'))
            if (!hex) return
            e.preventDefault()
            setDraft(null)
            apply(hex)
          }}
          onBlur={() => {
            if (draft !== null) apply(draft)
            setDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-10 w-full min-w-0 rounded-md border border-line px-2 font-mono text-[11px] uppercase disabled:bg-panel disabled:text-muted lg:h-8"
        />
        {allowTransparent && (
          <button
            type="button"
            onClick={() => onChange(value === null ? '#ffffff' : null)}
            title={value === null ? 'Use a solid colour' : 'Make transparent'}
            className={`h-10 shrink-0 rounded-md border px-2 text-[11px] transition lg:h-8 ${
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
