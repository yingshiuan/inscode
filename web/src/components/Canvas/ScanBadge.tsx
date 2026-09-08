import { useEffect, useMemo, useRef, useState } from 'react'
import { audit, heuristicMaxScale, verifiedMaxScale, type IntegrityReport } from '../../qr/audit'
import { logoInk, type LogoInk } from '../../qr/logoInk'
import { designKey } from '../../qr/oracle'
import { checkScannable, type ScanReport } from '../../qr/validate'
import type { RenderResult } from '../../qr/useRender'
import type { Matrix } from '../../qr/encode'
import type { QRSpec } from '../../qr/spec'
import {
  describeOutput,
  MIN_MODULE_MM,
  MIN_PX_PER_MODULE,
  modulePitch,
  recommendedMm,
  type Output,
} from '../../qr/output'
import { useQrStore, type Safety } from '../../store/useQrStore'

/**
 * What the design is, and what to do about it.
 *
 * The badge used to say "Will not scan — shrink the logo or raise the contrast",
 * which was honest about its own imprecision: a decode result is one boolean over two
 * independent failures and genuinely cannot tell them apart. So this reports them
 * apart. `audit.ts` answers *is the data still recoverable* exactly, per Reed-Solomon
 * block, from the design itself; `validate.ts` answers *can a scanner resolve it*
 * empirically. And because the first one is exact, it can also say how large the logo
 * is allowed to be -- which makes the fix a button rather than a suggestion.
 *
 * The second question is answered at the size the code will actually be, never in the
 * abstract. "Legible down to 2.5 px/module" is true and useless: the preview is a
 * 560px box whatever the design is, so a verdict that does not name a size gets read
 * as a verdict about the enormous thing on screen.
 *
 * And the largest-logo number comes in two grades that are never blurred together. The
 * model's estimate arrives immediately, because dragging cannot wait a second for a
 * decoder; the decoder's verdict follows once the user stops moving, and is what the
 * export path acts on. While it is outstanding the badge says so, rather than letting
 * the estimate quietly wear the decoder's authority.
 */

const TONE = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  marginal: 'border-amber-200 bg-amber-50 text-amber-800',
  risky: 'border-amber-200 bg-amber-50 text-amber-800',
  fragile: 'border-amber-200 bg-amber-50 text-amber-800',
  fail: 'border-red-200 bg-red-50 text-red-800',
  pending: 'border-line bg-panel text-muted',
} as const

const MARK = { ok: '●', marginal: '▲', risky: '▲', fragile: '▲', fail: '■', pending: '○' } as const

type Tone = keyof typeof TONE

function Pill({ tone, title, children }: { tone: Tone; title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${TONE[tone]}`}
    >
      <span aria-hidden>{MARK[tone]}</span>
      {children}
    </span>
  )
}

/** One block's error budget. Full means the next wrong codeword is unrecoverable. */
function BlockBar({ used, of, worst }: { used: number; of: number; worst: boolean }) {
  const over = used > of
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-muted">block {worst ? '▸' : ''}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-200">
        <div
          className={`h-full rounded-full ${over ? 'bg-red-500' : used / of > 0.8 ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${Math.min(100, (used / of) * 100)}%` }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted">
        {used}/{of}
      </span>
    </div>
  )
}

/** How the design fares at the size it is actually being made. */
function fitVerdict(
  output: Output,
  modules: number,
  optical: ScanReport | null,
): { tone: Tone; label: string; title: string } {
  if (!optical || !modules) return { tone: 'pending', label: 'Checking…', title: '' }
  const pitch = modulePitch(output, modules)
  const at = `At ${describeOutput(output)}`

  if (output.kind === 'print') {
    // Print is not a pixel question -- the limit is the physical module size against
    // what a camera can resolve, so the sweep's blur/fade/rotation stand in for the
    // conditions rather than for the size.
    const mm = `${pitch.toFixed(2)} mm per module`
    if (pitch < MIN_MODULE_MM) {
      return {
        tone: 'fail',
        label: `${at}: ${mm} — under the ${MIN_MODULE_MM} mm floor`,
        title: `Print at least ${recommendedMm(modules)} mm wide.`,
      }
    }
    if (!optical.degradedOk) {
      return {
        tone: 'risky',
        label: `${at}: ${mm}, but ${optical.message.toLowerCase()}`,
        title: 'Large enough, but it did not survive blur, fade or rotation.',
      }
    }
    return {
      tone: 'ok',
      label: `${at}: ${mm} — above the floor`,
      title: `${MIN_MODULE_MM} mm per module is the conventional minimum for a phone camera.`,
    }
  }

  const px = `${pitch.toFixed(1)} px per module`
  if (pitch < MIN_PX_PER_MODULE) {
    return {
      tone: 'fail',
      label: `${at}: ${px} — below the ${MIN_PX_PER_MODULE} px sampling floor`,
      title: `Needs at least ${Math.ceil(modules * MIN_PX_PER_MODULE)} px. A clean render decodes below this; a camera does not.`,
    }
  }
  if (optical.atYourSize?.ok === false) {
    return { tone: 'fail', label: `${at}: ${px} — does not decode`, title: 'Measured at this size.' }
  }
  if (!optical.degradedOk) {
    return { tone: 'risky', label: `${at}: ${px}, but ${optical.message.toLowerCase()}`, title: '' }
  }
  return { tone: 'ok', label: `${at}: ${px} — decodes`, title: 'Measured at this size.' }
}

/**
 * The logo profile, or nothing. Never allowed to take the audit down with it: this
 * is a note about an asset, and a design that has already been drawn and measured
 * does not lose its verdict because the artwork could not be profiled a second time.
 */
function safeInk(spec: QRSpec, matrix: Matrix, img: HTMLImageElement | null): LogoInk | null {
  try {
    return logoInk(spec, matrix, img)
  } catch {
    return null
  }
}

/** Where the decoder has got to. Never silent, because silence reads as approval. */
function SafetyPill({ safety, fresh }: { safety: Safety; fresh: boolean }) {
  if (!fresh || safety.status === 'verifying' || safety.status === 'idle') {
    return (
      <Pill tone="pending" title="The decoder is reading the design back. Until it answers, the size above is the model's estimate.">
        Verifying safe size…
      </Pill>
    )
  }
  if (safety.status === 'unverifiable') {
    return (
      <Pill tone="risky" title="This browser could not apply the degradation profile, so nothing could be decoded. The estimate stands unverified.">
        Not verified in this browser
      </Pill>
    )
  }
  if (safety.verified === null) {
    return safety.unstable ? (
      <Pill tone="fail" title="It reads at some logo sizes and fails at smaller ones, which means it is balanced on the decoder's threshold rather than safely inside it.">
        Reads only at some sizes
      </Pill>
    ) : (
      <Pill tone="fail" title="No logo size for this design was read back successfully.">
        No safe logo size found
      </Pill>
    )
  }
  return (
    <Pill tone="ok" title="Rendered under the production profile and read back by the decoder.">
      Verified safe at {Math.round(safety.verified * 100)}%
    </Pill>
  )
}

export function ScanBadge({ render, spec }: { render: RenderResult; spec: QRSpec }) {
  const patchLogo = useQrStore((s) => s.patchLogo)
  const output = useQrStore((s) => s.output)
  const safety = useQrStore((s) => s.safety)
  const setSafety = useQrStore((s) => s.setSafety)
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [ink, setInk] = useState<LogoInk | null>(null)
  const [optical, setOptical] = useState<ScanReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [open, setOpen] = useState(false)

  const { svg, matrix, resolved, img } = render
  const modules = matrix ? matrix.size + 2 * spec.canvas.quietZone : 0
  const encoded = resolved?.encoded

  // The unfitted spec plus the fresh encode: the audit re-renders the design at trial
  // logo sizes and must apply `clearFinders` itself at each one.
  const subject = useMemo(
    () => (encoded ? ({ ...spec, encoded } as QRSpec) : null),
    [spec, encoded],
  )

  useEffect(() => {
    if (!svg || !subject || !matrix) return
    let live = true
    setChecking(true)
    // Both passes rasterise the design several times over; there is no value in
    // doing that mid-drag.
    const id = setTimeout(async () => {
      try {
        const data = await audit(subject, matrix, img)
        if (!live) return
        setIntegrity(data)
        // An advisory about the file the user supplied, not about the symbol. It is
        // computed on the audit's debounce because it rasterises the artwork, and it
        // is kept out of every grade below: a flattened logo is a reason a design is
        // tighter than it needs to be, never a reason to call it unsafe.
        setInk(safeInk(subject, matrix, img))
        // A screen target is a pixel question, so its own size joins the sweep. A
        // print target's limit is physical; the sweep answers the conditions instead.
        // Below the sampling floor there is nothing to measure -- a clean render
        // decodes there and would report a reassuring pass, which is the whole trap.
        const pitch = modulePitch(output, modules)
        const sweep = await checkScannable(
          svg,
          spec.content.text,
          modules,
          output.kind === 'screen' && pitch >= MIN_PX_PER_MODULE ? pitch : undefined,
        )
        if (live) setOptical(sweep)
      } catch {
        if (live) {
          setIntegrity(null)
          setInk(null)
          setOptical(null)
        }
      } finally {
        if (live) setChecking(false)
      }
    }, 400)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [svg, subject, matrix, img, modules, spec.content.text, output])

  // Verification is keyed on the design *minus* the logo scale: the scale is what it
  // solves for, so resizing must not throw the answer away and start over.
  const key = useMemo(() => (subject ? designKey(subject) : null), [subject])
  const subjectRef = useRef(subject)
  useEffect(() => {
    subjectRef.current = subject
  }, [subject])

  useEffect(() => {
    const current = subjectRef.current
    if (!key || !matrix || !current || !current.logo) {
      setSafety({ status: 'idle', estimated: null, verified: null, unstable: false, key: null })
      return
    }
    let live = true
    const controller = new AbortController()
    setSafety({ status: 'verifying', estimated: null, verified: null, unstable: false, key: null })

    // Longer than the audit's debounce: this one costs about a second, and running it
    // mid-drag would be a second of work thrown away on every frame.
    const id = setTimeout(async () => {
      const design = subjectRef.current
      if (!design || !design.logo) return
      try {
        const estimated = await heuristicMaxScale(design, matrix, img)
        if (!live) return
        setSafety({ status: 'verifying', estimated, verified: null, unstable: false, key: null })
        if (estimated === null) {
          setSafety({ status: 'verified', estimated: null, verified: null, unstable: false, key })
          return
        }
        const { scale, unavailable, unstable } = await verifiedMaxScale(
          design, matrix, img, estimated, { signal: controller.signal },
        )
        if (!live) return
        setSafety({
          status: unavailable ? 'unverifiable' : 'verified',
          estimated,
          verified: scale,
          unstable,
          key,
        })
      } catch {
        if (live) {
          setSafety({
            status: 'unverifiable', estimated: null, verified: null, unstable: false, key,
          })
        }
      }
    }, 900)

    return () => {
      live = false
      controller.abort()
      clearTimeout(id)
    }
  }, [key, matrix, img, setSafety])

  const fresh = safety.key !== null && safety.key === key
  const pending = checking && !integrity
  // Prefer the decoder's number. Fall back to the estimate only while the decoder has
  // not answered, and say which one is being offered.
  const verified = fresh && safety.status === 'verified' ? safety.verified : null
  const estimated = safety.estimated ?? integrity?.estimatedSafeScale ?? null
  const target = verified ?? estimated
  const oversized = Boolean(spec.logo && target !== null && spec.logo.scale > target + 0.005)
  const fixable = spec.logo && target !== null && (oversized || (integrity && !integrity.intact))
    ? target
    : null

  const fit = fitVerdict(output, modules, optical)

  return (
    <div className="mt-3 w-full max-w-[540px]">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Pill tone={pending ? 'pending' : (integrity?.grade ?? 'pending')}>
          {pending ? 'Checking…' : (integrity?.message ?? 'Checking…')}
        </Pill>

        {integrity && (
          <Pill tone={fit.tone} title={fit.title}>
            {fit.label}
          </Pill>
        )}

        {spec.logo && <SafetyPill safety={safety} fresh={fresh} />}

        {fixable !== null && (
          <button
            type="button"
            onClick={() => patchLogo({ scale: fixable })}
            title={
              verified !== null
                ? 'Confirmed by decoding the design under the production profile.'
                : 'The model’s estimate. The decoder has not confirmed it yet.'
            }
            className="rounded-full border border-ink bg-ink px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-85"
          >
            Shrink logo to {Math.round(fixable * 100)}%
            {verified === null && <span className="opacity-70"> (estimate)</span>}
          </button>
        )}

        {integrity && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-panel"
            aria-expanded={open}
          >
            {open ? 'Hide numbers' : 'Numbers'}
          </button>
        )}
      </div>

      {ink?.message && (
        <p className="mx-auto mt-2 max-w-[480px] rounded-md border border-line bg-panel px-2.5 py-1.5 text-left text-[11px] leading-snug text-muted">
          <span className="font-medium text-ink">Logo file</span> · {ink.message}
        </p>
      )}

      {open && integrity && (
        <div className="mt-3 space-y-4 rounded-lg border border-line bg-white p-3 text-left">
          <div>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
              Data integrity · exact, from the design
            </h3>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-ink">Finder patterns a scanner can lock onto</span>
                <span
                  className={`tabular-nums ${integrity.brokenFinders ? 'font-semibold text-red-700' : 'text-muted'}`}
                  title="Checked by the 1:1:3:1:1 run through each centre — the way a decoder finds them. A restyled finder that keeps that profile is fine."
                >
                  {3 - integrity.brokenFinders}/3
                </span>
              </div>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-ink">Grid modules obscured</span>
                <span
                  className={`tabular-nums ${integrity.gridFlips ? 'text-amber-700' : 'text-muted'}`}
                  title="Timing and alignment patterns: nothing corrects them, but a scanner locks the grid from the finder patterns, so losing them is survivable. Measured: destroying every one still decodes."
                >
                  {integrity.gridFlips}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-ink">Format information</span>
                <span
                  className={`tabular-nums ${integrity.formatOk ? 'text-muted' : 'font-semibold text-red-700'}`}
                  title="15 bits, written twice in different corners, each a BCH codeword good for 3 wrong bits. A decoder reads whichever copy comes back cleaner, so damage here is only fatal when both copies are past the budget."
                >
                  {integrity.formatErrors[0]}, {integrity.formatErrors[1]} wrong of 15
                </span>
              </div>
              {integrity.versionErrors && (
                <div className="flex items-baseline justify-between text-[11px]">
                  <span className="text-ink">Version information</span>
                  <span
                    className={`tabular-nums ${integrity.versionOk ? 'text-muted' : 'font-semibold text-red-700'}`}
                    title="18 bits, also written twice, also BCH-protected for 3 wrong bits per copy."
                  >
                    {integrity.versionErrors[0]}, {integrity.versionErrors[1]} wrong of 18
                  </span>
                </div>
              )}
              {integrity.blocks.map((b) => (
                <BlockBar
                  key={b.index}
                  used={b.corrupted}
                  of={b.correctable}
                  worst={b.index === integrity.worstBlock}
                />
              ))}
              <p className="pt-1 text-[11px] leading-snug text-muted">
                Codewords each Reed-Solomon block has spent on repairs. The worst block
                binds — not the average, and not the area the logo covers.
              </p>
              {spec.logo && (
                <div className="space-y-1 pt-1">
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="text-ink">Largest logo — estimated</span>
                    <span className="tabular-nums text-muted" title="The model's answer, from one render. 95.6% agreement with the decoder over the calibration matrix.">
                      {estimated === null ? '—' : `${Math.round(estimated * 100)}%`}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="text-ink">Largest logo — verified</span>
                    <span
                      className={`tabular-nums ${verified === null ? 'text-amber-700' : 'text-emerald-700'}`}
                      title="Confirmed by rendering the design under the production profile and reading it back. This is the number the export path uses."
                    >
                      {!fresh || safety.status === 'verifying'
                        ? 'verifying…'
                        : safety.status === 'unverifiable'
                          ? 'unavailable here'
                          : verified === null
                            ? 'none found'
                            : `${Math.round(verified * 100)}%`}
                    </span>
                  </div>
                  {integrity.logoScale !== null && (
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-muted">Currently</span>
                      <span className="tabular-nums text-muted">
                        {Math.round(integrity.logoScale * 100)}%
                      </span>
                    </div>
                  )}
                  {ink && spec.mode === 'classic' && ink.modulesCovered > 0 && (
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-ink">Modules under the logo</span>
                      <span
                        className={`tabular-nums ${ink.removable ? 'text-amber-700' : 'text-muted'}`}
                        title={
                          ink.background
                            ? `${ink.modulesBackground} of them sit on flat ${ink.background} rather than on artwork. A logo with an alpha channel only covers its ink, so those modules would go back to the code.`
                            : 'Every one of these is covered by artwork; there is no flat field to key out.'
                        }
                      >
                        {ink.modulesCovered}
                        {ink.background ? `, ${ink.modulesBackground} on background` : ''}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
              Optical legibility · measured
            </h3>
            <ul className="space-y-1">
              {(optical?.conditions ?? []).map((c) => (
                <li key={c.label} className="flex items-baseline justify-between text-[11px]">
                  <span className={c.ok === false ? 'font-medium text-red-700' : 'text-ink'}>
                    {c.ok === null ? '–' : c.ok ? '✓' : '✕'} {c.label}
                  </span>
                  <span className="tabular-nums text-muted">{c.pxPerModule} px/module</span>
                </li>
              ))}
            </ul>
            <p className="pt-2 text-[11px] leading-snug text-muted">
              Pixels per module, not pixels: the same 180px render is generous for a
              small code and hopeless for a dense one. Nothing below 2 px/module is
              tested — a clean render decodes there and a phone camera never will.
              {optical?.minWidthMm ? ` This design needs ≥ ${optical.minWidthMm} mm in print.` : ''}
            </p>
          </div>

          {integrity.intact && (
            <p className="text-[11px] leading-snug text-muted">
              Margin is measured with a global threshold where a real decoder binarises
              locally, so the last codeword or two of headroom is not a promise. Scan
              the export with a phone before it goes to print.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
