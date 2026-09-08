import { useQrStore } from '../../store/useQrStore'
import { FINDER_SHAPES, MARK_SHAPES, MODULE_SHAPES } from '../../qr/spec'
import type { RenderResult } from '../../qr/useRender'
import { Field, Section, SegmentedControl, Slider, Toggle } from '../ui'
import { ColorField } from '../ColorField'
import { FinderIcon, MarkIcon, ShapeIcon } from '../shapeIcons'
import { ExportSize } from './ExportSize'

/**
 * `withExport` is false only on narrow screens, where the export size lives in its
 * own tab rather than at the bottom of a panel nobody scrolls that far down.
 */
export function Inspector({ render, withExport = true }: { render: RenderResult; withExport?: boolean }) {
  const spec = useQrStore((s) => s.spec)
  const { patch, patchLogo, patchPlate, begin, end } = useQrStore()

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {spec.mode === 'classic' ? (
        <Section title="Modules">
          <Field label="Shape">
            <SegmentedControl
              columns={6}
              value={spec.modules.shape}
              onChange={(v) => patch('modules', { shape: v })}
              options={MODULE_SHAPES.map((s) => ({ value: s, label: ShapeIcon[s], title: s }))}
            />
          </Field>
          <Field label="Gap" hint={`${Math.round(spec.modules.gap * 100)}%`}>
            <Slider
              min={0}
              max={0.4}
              step={0.01}
              value={spec.modules.gap}
              onChange={(v) => patch('modules', { gap: v })}
              onCommitStart={begin}
              onCommitEnd={end}
            />
          </Field>
        </Section>
      ) : (
        <Section title="Marks">
          <Field label="Shape">
            <SegmentedControl
              columns={3}
              value={spec.art.mark}
              onChange={(v) => patch('art', { mark: v })}
              options={MARK_SHAPES.map((s) => ({ value: s, label: MarkIcon[s], title: s }))}
            />
          </Field>
          <Field label="Mark size" hint={`${Math.round(spec.art.markSize * 100)}%`}>
            <Slider
              min={0.2}
              max={1}
              step={0.02}
              value={spec.art.markSize}
              onChange={(v) => patch('art', { markSize: v })}
              onCommitStart={begin}
              onCommitEnd={end}
            />
          </Field>
          <Toggle
            label="Loose grid"
            hint="Draw the timing and alignment patterns as marks too. Prettier, and noticeably less robust."
            checked={spec.art.loose}
            onChange={(v) => patch('art', { loose: v })}
          />
          <Toggle
            label="Keep corners clear"
            hint="Shrink the artwork until it stops touching the three finder patterns."
            checked={spec.art.clearFinders}
            onChange={(v) => patch('art', { clearFinders: v })}
          />
        </Section>
      )}

      <Section title="Colour">
        <Field label="Foreground">
          <ColorField
            value={spec.modules.color}
            onChange={(v) => patch('modules', { color: v ?? '#000000' })}
            onCommitStart={begin}
            onCommitEnd={end}
          />
        </Field>
        <Field label="Background">
          <ColorField
            allowTransparent
            value={spec.canvas.bg}
            onChange={(v) => patch('canvas', { bg: v })}
            onCommitStart={begin}
            onCommitEnd={end}
          />
        </Field>
      </Section>

      <Section title="Finder patterns">
        <Field label="Shape">
          <SegmentedControl
            columns={3}
            value={spec.finders.shape}
            onChange={(v) => patch('finders', { shape: v })}
            options={FINDER_SHAPES.map((s) => ({ value: s, label: FinderIcon[s], title: s }))}
          />
        </Field>
        <Field label="Colour">
          <ColorField
            value={spec.finders.color ?? spec.modules.color}
            onChange={(v) => patch('finders', { color: v })}
            onCommitStart={begin}
            onCommitEnd={end}
          />
        </Field>
        <p className="text-[11px] leading-snug text-muted">
          These three corners are what a scanner locks onto first. They stay solid in every
          style — breaking them into loose dots is the main reason decorative codes fail to read.
        </p>
      </Section>

      {spec.logo && spec.mode === 'classic' && (
        <Section title="Logo plate">
          <Toggle
            label="Clear plate"
            hint="Cuts the modules out behind the logo so it never sits on live data."
            checked={spec.logo.plate.enabled}
            onChange={(v) => patchPlate({ enabled: v })}
          />
          {spec.logo.plate.enabled && (
            <>
              <Field label="Padding" hint={`${spec.logo.plate.pad.toFixed(1)} modules`}>
                <Slider
                  min={0}
                  max={3}
                  step={0.1}
                  value={spec.logo.plate.pad}
                  onChange={(v) => patchPlate({ pad: v })}
                  onCommitStart={begin}
                  onCommitEnd={end}
                />
              </Field>
              <Field label="Corner radius" hint={`${Math.round(spec.logo.plate.radius * 200)}%`}>
                <Slider
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={spec.logo.plate.radius}
                  onChange={(v) => patchPlate({ radius: v })}
                  onCommitStart={begin}
                  onCommitEnd={end}
                />
              </Field>
              <Field label="Plate colour">
                <ColorField
                  allowTransparent
                  value={spec.logo.plate.color}
                  onChange={(v) => patchPlate({ color: v })}
                  onCommitStart={begin}
                  onCommitEnd={end}
                />
              </Field>
            </>
          )}
          <Field label="Rotation" hint={`${Math.round(spec.logo.rotation)}°`}>
            <Slider
              min={-180}
              max={180}
              step={1}
              value={spec.logo.rotation}
              onChange={(v) => patchLogo({ rotation: v })}
              onCommitStart={begin}
              onCommitEnd={end}
            />
          </Field>
        </Section>
      )}

      <Section title="Canvas">
        <Field label="Quiet zone" hint={`${spec.canvas.quietZone} modules`}>
          <Slider
            min={0}
            max={8}
            step={1}
            value={spec.canvas.quietZone}
            onChange={(v) => patch('canvas', { quietZone: v })}
            onCommitStart={begin}
            onCommitEnd={end}
          />
        </Field>
        {spec.canvas.quietZone < 4 && (
          <p className="text-[11px] leading-snug text-amber-700">
            The spec asks for 4 modules of clear margin. Below that, scanners get unreliable
            against busy backgrounds.
          </p>
        )}
      </Section>

      {withExport && (
        <ExportSize
          spec={spec}
          svg={render.svg}
          modules={render.matrix ? render.matrix.size + 2 * spec.canvas.quietZone : 0}
        />
      )}
    </div>
  )
}
