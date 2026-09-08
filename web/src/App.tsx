import { useEffect, useState } from 'react'
import { useCanRedo, useCanUndo, useQrStore } from './store/useQrStore'
import { useRender } from './qr/useRender'
import { useMediaQuery } from './hooks/useMediaQuery'
import { LeftPanel } from './components/LeftPanel/LeftPanel'
import { Inspector } from './components/Inspector/Inspector'
import { ExportSize } from './components/Inspector/ExportSize'
import { QrCanvas } from './components/Canvas/QrCanvas'
import { ScanBadge } from './components/Canvas/ScanBadge'
import { ExportMenu } from './components/ExportMenu'
import { BatchDialog } from './components/BatchDialog'

/**
 * Two layouts, one tree.
 *
 * Wide: the familiar three columns, controls flanking the preview.
 *
 * Narrow: the preview and its verdict stay pinned at the top, because the whole
 * point of the tool is watching the code change as you edit it, and the controls
 * move into a tabbed drawer beneath. The panels are the same components in both —
 * moved, not duplicated, because ScanBadge owns the decoder run and a second copy
 * would quietly double every verification.
 */
const WIDE = '(min-width: 1024px)'

type Tab = 'content' | 'style' | 'size'

const TABS: { id: Tab; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'style', label: 'Style' },
  { id: 'size', label: 'Size' },
]

export default function App() {
  const [batchOpen, setBatchOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('content')
  const wide = useMediaQuery(WIDE)
  const spec = useQrStore((s) => s.spec)
  const { undo, redo, reset } = useQrStore()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const render = useRender(spec)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      e.preventDefault()
      e.shiftKey ? redo() : undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const modules = render.matrix ? render.matrix.size + 2 * spec.canvas.quietZone : 0

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3 lg:h-12 lg:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px] bg-ink text-[10px] font-bold text-white">
            ▣
          </span>
          <h1 className="truncate text-sm font-semibold tracking-tight">inscode</h1>
        </div>

        <div className="flex shrink-0 items-center gap-1 lg:gap-1.5">
          <button
            onClick={undo}
            disabled={!canUndo}
            title="Undo (⌘Z)"
            aria-label="Undo"
            className="h-9 w-9 rounded-md border border-line text-xs transition hover:bg-panel disabled:opacity-30 lg:h-8 lg:w-8"
          >
            ↶
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            className="h-9 w-9 rounded-md border border-line text-xs transition hover:bg-panel disabled:opacity-30 lg:h-8 lg:w-8"
          >
            ↷
          </button>
          <button
            onClick={reset}
            title="Start over"
            className="h-9 rounded-md border border-line px-2.5 text-xs transition hover:bg-panel lg:mr-1 lg:h-8"
          >
            Reset
          </button>
          <ExportMenu
            spec={spec}
            svg={render.svg}
            resolved={render.resolved}
            modules={modules}
            onBatch={() => setBatchOpen(true)}
          />
        </div>
      </header>

      {wide ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[288px] shrink-0 border-r border-line">
            <LeftPanel render={render} />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-auto bg-panel p-6">
            <div className="w-full max-w-[560px]">
              <QrCanvas spec={spec} render={render} />
            </div>
            <ScanBadge render={render} spec={spec} />
          </main>

          <aside className="w-[300px] shrink-0 border-l border-line">
            <Inspector render={render} />
          </aside>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The preview keeps its place on screen; only the report below it can
              grow, and it scrolls inside this block rather than pushing the
              controls off the bottom. */}
          <div className="flex max-h-[60dvh] shrink-0 flex-col items-center overflow-y-auto border-b border-line bg-panel px-3 py-3">
            <div className="w-full max-w-[42dvh]">
              <QrCanvas spec={spec} render={render} />
            </div>
            <ScanBadge render={render} spec={spec} />
          </div>

          <nav role="tablist" aria-label="Controls" className="flex shrink-0 border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`-mb-px h-11 flex-1 border-b-2 text-xs font-medium transition ${
                  tab === t.id ? 'border-ink text-ink' : 'border-transparent text-muted'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'content' && <LeftPanel render={render} />}
            {tab === 'style' && <Inspector render={render} withExport={false} />}
            {tab === 'size' && <ExportSize spec={spec} svg={render.svg} modules={modules} />}
          </div>
        </div>
      )}

      {batchOpen && <BatchDialog spec={spec} onClose={() => setBatchOpen(false)} />}
    </div>
  )
}
