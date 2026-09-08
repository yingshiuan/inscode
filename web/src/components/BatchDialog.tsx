import { useState } from 'react'
import type { QRSpec } from '../qr/spec'
import { renderBatch } from '../api/client'
import { download } from '../export/render'

/**
 * One design, many payloads. Styling is already settled by the time you get here;
 * only the URL changes -- menus, table tents, a campaign's worth of links.
 */
export function BatchDialog({ spec, onClose }: { spec: QRSpec; onClose: () => void }) {
  const [text, setText] = useState('')
  const [format, setFormat] = useState<'png' | 'svg' | 'jpg'>('png')
  const [px, setPx] = useState(1024)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // "url" or "url, name" per line -- the name becomes the filename in the ZIP.
  const items = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [url, ...rest] = line.split(',')
      return { text: url.trim(), name: rest.join(',').trim() || undefined }
    })

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      // The template's own encode belongs to a different payload; the server
      // re-encodes per item.
      const template = { ...spec, encoded: undefined, art: { ...spec.art, cells: undefined } }
      download(await renderBatch(template, items, format, px), 'qr-codes.zip')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Batch failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-line bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">Batch generate</h2>
        <p className="mt-1 text-[11px] leading-snug text-muted">
          One line per code, in the current style. Add a comma and a name to set the filename:
          <br />
          <code className="text-[10px]">https://insdash.ch/table/1, table-1</code>
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={'https://insdash.ch/table/1, table-1\nhttps://insdash.ch/table/2, table-2'}
          className="mt-3 w-full resize-none rounded-md border border-line p-2.5 font-mono text-[11px] outline-none focus:border-ink"
        />

        <div className="mt-3 flex items-center gap-3">
          <div className="flex gap-1">
            {(['png', 'svg', 'jpg'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`h-7 rounded border px-2 text-[11px] uppercase transition ${
                  format === f ? 'border-ink bg-ink text-white' : 'border-line hover:bg-panel'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          {format !== 'svg' && (
            <div className="flex gap-1">
              {[512, 1024, 2048].map((s) => (
                <button
                  key={s}
                  onClick={() => setPx(s)}
                  className={`h-7 rounded border px-2 text-[11px] tabular-nums transition ${
                    px === s ? 'border-ink bg-ink text-white' : 'border-line hover:bg-panel'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto text-[11px] tabular-nums text-muted">
            {items.length} code{items.length === 1 ? '' : 's'}
          </span>
        </div>

        {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}

        <p className="mt-3 border-t border-line pt-2 text-[11px] leading-snug text-muted">
          Every code here carries a different payload, so each one damages the logo
          differently. Only the design on the canvas has been checked with a decoder —
          scan a few from the ZIP before you print the run.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="h-8 rounded-md border border-line px-3 text-xs hover:bg-panel">
            Cancel
          </button>
          <button
            onClick={run}
            disabled={busy || items.length === 0 || items.length > 200}
            className="h-8 rounded-md bg-ink px-3 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
          >
            {busy ? 'Generating…' : `Download ZIP`}
          </button>
        </div>
        {items.length > 200 && (
          <p className="mt-2 text-right text-[11px] text-amber-700">Limit is 200 codes per batch.</p>
        )}
      </div>
    </div>
  )
}
