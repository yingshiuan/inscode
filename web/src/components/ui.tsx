/** Small shared control primitives, so the two panels stay visually consistent. */
import type { ReactNode } from 'react'

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h2>
        {aside}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink">{label}</span>
        {hint && <span className="text-[11px] tabular-nums text-muted">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

export function Slider({
  value, min, max, step, onChange, onCommitStart, onCommitEnd,
}: {
  value: number; min: number; max: number; step: number
  onChange: (v: number) => void
  onCommitStart?: () => void
  onCommitEnd?: () => void
}) {
  return (
    <input
      type="range"
      className="w-full"
      value={value}
      min={min}
      max={max}
      step={step}
      onPointerDown={onCommitStart}
      onPointerUp={onCommitEnd}
      onKeyDown={onCommitStart}
      onKeyUp={onCommitEnd}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function SegmentedControl<T extends string>({
  options, value, onChange, columns = 3,
}: {
  options: { value: T; label: ReactNode; title?: string }[]
  value: T
  onChange: (v: T) => void
  columns?: number
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex h-10 items-center justify-center rounded-md border text-xs transition lg:h-9 ${
            value === o.value
              ? 'border-ink bg-ink text-white'
              : 'border-line bg-white text-ink hover:border-zinc-300 hover:bg-zinc-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 text-left"
    >
      <span>
        <span className="block text-xs font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-muted">{hint}</span>}
      </span>
      <span
        className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition ${
          checked ? 'bg-ink' : 'bg-zinc-300'
        }`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
            checked ? 'left-[16px]' : 'left-[2px]'
          }`}
        />
      </span>
    </button>
  )
}
