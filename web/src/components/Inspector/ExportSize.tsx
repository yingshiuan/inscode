import type { QRSpec } from '../../qr/spec'
import {
  describeOutput,
  GOOD_PX_PER_MODULE,
  MIN_MODULE_MM,
  MIN_PX_PER_MODULE,
  MM_RANGE,
  modulePitch,
  mmToPx,
  outputCssPx,
  outputCssWidth,
  PRINT_DPI,
  PX_RANGE,
  recommendedMm,
  recommendedPx,
  type Output,
} from '../../qr/output'
import { useQrStore } from '../../store/useQrStore'
import { Field, Section, SegmentedControl, Slider } from '../ui'

/**
 * How big this code will actually be — and the code at that size, under the slider.
 *
 * The preview is a 560px box whatever the design is, so a code destined for a 15mm
 * sticker looks exactly as crisp on screen as one going on a poster. That is the real
 * reason a green badge gets believed: it is read as a statement about the thing on
 * screen, which is always enormous. The swatch is the same drawing at the size that
 * will exist, and it shrinks under the slider as you drag it.
 *
 * It lives here rather than with the design controls above because it is not part of
 * the design — the drawing does not change when you decide to print it smaller. It is
 * what the export is for, which is why the export menu offers it as a size too.
 */

/** Beyond this the swatch stops being life-size and says so. */
const SWATCH_MAX_PX = 224

function Readout({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-muted">{label}</span>
      <span className={`tabular-nums ${alarm ? 'font-semibold text-red-700' : 'text-ink'}`}>
        {value}
      </span>
    </div>
  )
}

export function ExportSize({
  spec,
  svg,
  modules,
}: {
  spec: QRSpec
  svg: string
  modules: number
}) {
  const output = useQrStore((s) => s.output)
  const setOutput = useQrStore((s) => s.setOutput)

  const print = output.kind === 'print'
  const pitch = modulePitch(output, modules)
  const range = print ? MM_RANGE : PX_RANGE
  const value = print ? output.mm : output.px
  const floor = print ? MIN_MODULE_MM : MIN_PX_PER_MODULE
  const wanted = modules ? (print ? recommendedMm(modules) : recommendedPx(modules)) : 0

  const trueCssPx = outputCssPx(output)
  const lifeSize = trueCssPx <= SWATCH_MAX_PX

  const setKind = (kind: Output['kind']) =>
    setOutput(
      kind === 'print'
        ? { kind: 'print', mm: Math.max(recommendedMm(modules || 40) * 2, MM_RANGE.min) }
        : { kind: 'screen', px: Math.max(recommendedPx(modules || 40), 256) },
    )

  return (
    <Section title="Export">
      <Field label="Destination">
        <SegmentedControl
          columns={2}
          value={output.kind}
          onChange={setKind}
          options={[
            { value: 'print', label: 'Print', title: 'Finished width in millimetres' },
            { value: 'screen', label: 'Screen', title: 'Finished width in pixels' },
          ]}
        />
      </Field>

      <Field label="Final size" hint={describeOutput(output)}>
        <Slider
          min={range.min}
          max={range.max}
          step={print ? 1 : 8}
          value={value}
          onChange={(v) => setOutput(print ? { kind: 'print', mm: v } : { kind: 'screen', px: v })}
        />
      </Field>

      <div className="space-y-1">
        <Readout
          label="Module size"
          value={print ? `${pitch.toFixed(2)} mm` : `${pitch.toFixed(1)} px`}
          alarm={Boolean(modules) && pitch < floor}
        />
        <Readout
          label={print ? 'Floor for a phone camera' : 'Sampling floor'}
          value={print ? `${MIN_MODULE_MM} mm` : `${MIN_PX_PER_MODULE} px`}
        />
        {Boolean(wanted) && (
          <Readout
            label={print ? 'Comfortable width' : `${GOOD_PX_PER_MODULE} px per module`}
            value={`${wanted}${print ? ' mm' : ' px'}`}
          />
        )}
        {print && <Readout label={`Export at ${PRINT_DPI} dpi`} value={`${mmToPx(output.mm)} px`} />}
      </div>

      <figure className="m-0">
        <div
          className={`grid min-h-[96px] place-items-center overflow-hidden rounded border border-line p-2 ${
            spec.canvas.bg === null ? 'checker' : ''
          }`}
        >
          <div
            className="[&>svg]:block [&>svg]:h-full [&>svg]:w-full"
            style={
              lifeSize
                ? { width: outputCssWidth(output), height: outputCssWidth(output) }
                : { width: SWATCH_MAX_PX, height: SWATCH_MAX_PX }
            }
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
        <figcaption
          className="mt-1.5 text-[11px] leading-snug text-muted"
          title="CSS defines a millimetre as 96/25.4 pixels, so this is exact on a display at nominal resolution and close on most others."
        >
          {lifeSize
            ? `Actual size${print ? ', approximately — a screen is not a ruler' : ''}.`
            : `Actual size is larger than this panel — shown at ${Math.round(
                (SWATCH_MAX_PX / trueCssPx) * 100,
              )}%.`}
        </figcaption>
      </figure>
    </Section>
  )
}
