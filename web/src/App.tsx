import { useEffect, useState } from 'react'
import { useCanRedo, useCanUndo, useQrStore } from './store/useQrStore'
import { useRender } from './qr/useRender'
import { LeftPanel } from './components/LeftPanel/LeftPanel'
import { Inspector } from './components/Inspector/Inspector'
import { QrCanvas } from './components/Canvas/QrCanvas'
import { ScanBadge } from './components/Canvas/ScanBadge'
import { ExportMenu } from './components/ExportMenu'
import { BatchDialog } from './components/BatchDialog'

export default function App() {
  const [batchOpen, setBatchOpen] = useState(false)
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-[4px] bg-ink text-[10px] font-bold text-white">
            ▣
          </span>
          <h1 className="text-sm font-semibold tracking-tight">inscode</h1>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={undo}
            disabled={!canUndo}
            title="Undo (⌘Z)"
            className="h-8 w-8 rounded-md border border-line text-xs transition hover:bg-panel disabled:opacity-30"
          >
            ↶
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title="Redo (⇧⌘Z)"
            className="h-8 w-8 rounded-md border border-line text-xs transition hover:bg-panel disabled:opacity-30"
          >
            ↷
          </button>
          <button
            onClick={reset}
            title="Start over"
            className="mr-1 h-8 rounded-md border border-line px-2.5 text-xs transition hover:bg-panel"
          >
            Reset
          </button>
          <ExportMenu
            spec={spec}
            svg={render.svg}
            resolved={render.resolved}
            modules={render.matrix ? render.matrix.size + 2 * spec.canvas.quietZone : 0}
            onBatch={() => setBatchOpen(true)}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[288px] shrink-0 border-r border-line">
          <LeftPanel render={render} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-auto bg-panel p-6">
          <QrCanvas spec={spec} render={render} />
          <ScanBadge render={render} spec={spec} />
        </main>

        <aside className="w-[300px] shrink-0 border-l border-line">
          <Inspector render={render} />
        </aside>
      </div>

      {batchOpen && <BatchDialog spec={spec} onClose={() => setBatchOpen(false)} />}
    </div>
  )
}
