import { useRef, useState } from 'react'
import { useQrStore } from '../../store/useQrStore'
import { EC_LEVELS } from '../../qr/spec'
import { Field, Section, SegmentedControl, Slider } from '../ui'
import type { RenderResult } from '../../qr/useRender'

const EC_HINT: Record<string, string> = {
  L: 'Recovers ~7% — smallest code, no room for a logo',
  M: 'Recovers ~15%',
  Q: 'Recovers ~25%',
  H: 'Recovers ~30% — needed for logos',
}

export function LeftPanel({ render }: { render: RenderResult }) {
  const spec = useQrStore((s) => s.spec)
  const { setText, patch, setMode, setLogo, patchLogo, begin, end } = useQrStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const readFile = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setFileError('That is not an image file.')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setFileError('Images over 8 MB make exports sluggish — try a smaller one.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setFileError(null)
      setLogo({
        src: String(reader.result),
        x: 0.5,
        y: 0.5,
        scale: spec.mode === 'art' ? 1 : 0.22,
        rotation: 0,
        plate: { enabled: spec.mode !== 'art', pad: 0.7, radius: 0.18, color: null },
      })
    }
    reader.onerror = () => setFileError('That file could not be read.')
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title="Content">
        <Field label="Link or text" hint={render.matrix ? `v${render.matrix.version} · ${render.matrix.size}²` : undefined}>
          <textarea
            value={spec.content.text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="https://example.com"
            className="w-full resize-none rounded-md border border-line px-2.5 py-2 text-xs outline-none focus:border-ink"
          />
        </Field>
        <Field label="Error correction" hint={EC_HINT[spec.content.ecLevel]}>
          <SegmentedControl
            columns={4}
            value={spec.content.ecLevel}
            onChange={(v) => patch('content', { ecLevel: v })}
            options={EC_LEVELS.map((l) => ({ value: l, label: l, title: EC_HINT[l] }))}
          />
        </Field>
      </Section>

      <Section title="Style mode">
        <SegmentedControl
          columns={2}
          value={spec.mode}
          onChange={setMode}
          options={[
            { value: 'classic', label: 'Centre logo', title: 'A normal QR with the logo on top' },
            { value: 'art', label: 'Full bleed', title: 'Artwork fills the code; modules become marks' },
          ]}
        />
        <p className="text-[11px] leading-snug text-muted">
          {spec.mode === 'classic'
            ? 'The logo sits on a clear plate so it never covers live modules.'
            : 'Artwork fills the whole code and the modules become small marks drawn over it.'}
        </p>
      </Section>

      <Section
        title="Logo"
        aside={
          spec.logo && (
            <button onClick={() => setLogo(null)} className="text-[11px] text-muted underline hover:text-ink">
              Remove
            </button>
          )
        }
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={(e) => readFile(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDropping(false)
            readFile(e.dataTransfer.files?.[0])
          }}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-5 transition ${
            dropping ? 'border-accent bg-blue-50' : 'border-line hover:border-zinc-300 hover:bg-panel'
          }`}
        >
          {spec.logo ? (
            <img src={spec.logo.src} alt="" className="max-h-14 max-w-[70%] object-contain" />
          ) : (
            <span className="text-xl text-muted">＋</span>
          )}
          <span className="text-[11px] text-muted">
            {spec.logo ? 'Replace image' : 'Drop an image, or click to choose'}
          </span>
        </button>
        {fileError && <p className="text-[11px] text-red-600">{fileError}</p>}
        {render.error && <p className="text-[11px] text-red-600">{render.error}</p>}

        {spec.logo && (
          <>
            <Field label="Size" hint={`${Math.round(spec.logo.scale * 100)}%`}>
              <Slider
                min={0.04}
                max={1}
                step={0.005}
                value={spec.logo.scale}
                onChange={(v) => patchLogo({ scale: v })}
                onCommitStart={begin}
                onCommitEnd={end}
              />
            </Field>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted">
                Position {spec.logo.x === 0.5 && spec.logo.y === 0.5 ? '· centred' : `· ${Math.round(spec.logo.x * 100)}, ${Math.round(spec.logo.y * 100)}`}
              </span>
              <button
                onClick={() => patchLogo({ x: 0.5, y: 0.5 })}
                className="text-[11px] text-muted underline hover:text-ink"
              >
                Recentre
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  )
}
