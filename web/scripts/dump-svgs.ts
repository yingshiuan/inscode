/**
 * Render a spread of specs to SVG so the Python side can rasterise and decode them.
 * This is the end-to-end scannability check the whole tool rests on.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSpec, type QRSpec } from '../src/qr/spec';
import { matrixFor } from '../src/qr/encode';
import { decideCells } from '../src/qr/sampler';
import { renderSvgString } from '../src/qr/renderSvg';
import { encode } from '../src/qr/encode';

const OUT = process.argv[2] ?? '/tmp/qr-svgs';
mkdirSync(OUT, { recursive: true });

const TEXT = 'https://insdash.ch';
const logoB64 = readFileSync(
  new URL('../../assets/test-logo.png', import.meta.url),
).toString('base64');
const LOGO_SRC = `data:image/png;base64,${logoB64}`;

function spec(patch: (s: QRSpec) => void): QRSpec {
  const s = defaultSpec(TEXT);
  s.encoded = encode(TEXT, s.content.ecLevel);
  patch(s);
  return s;
}

const withLogo = (s: QRSpec, scale: number) => {
  s.logo = {
    src: LOGO_SRC,
    x: 0.5,
    y: 0.5,
    scale,
    rotation: 0,
    plate: { enabled: true, pad: 0.7, radius: 0.18, color: null },
  };
};

const cases: Record<string, QRSpec> = {
  'classic-square': spec(() => {}),
  'classic-circle': spec((s) => {
    s.modules.shape = 'circle';
  }),
  'classic-rounded': spec((s) => {
    s.modules.shape = 'rounded';
  }),
  'classic-connected': spec((s) => {
    s.modules.shape = 'connected';
  }),
  'classic-diamond': spec((s) => {
    s.modules.shape = 'diamond';
  }),
  'classic-cross': spec((s) => {
    s.modules.shape = 'cross';
  }),
  'classic-gap': spec((s) => {
    s.modules.shape = 'circle';
    s.modules.gap = 0.2;
  }),
  'classic-finder-circle': spec((s) => {
    s.modules.shape = 'circle';
    s.finders.shape = 'circle';
  }),
  'classic-finder-rounded': spec((s) => {
    s.finders.shape = 'rounded';
  }),
  'classic-transparent': spec((s) => {
    s.canvas.bg = null;
  }),
  'classic-colour': spec((s) => {
    s.modules.color = '#1a2340';
    s.canvas.bg = '#f5efe6';
    s.finders.color = '#f05a3c';
  }),
  'logo-centre': spec((s) => withLogo(s, 0.22)),
  'logo-big': spec((s) => withLogo(s, 0.3)),
  'logo-offcentre': spec((s) => {
    withLogo(s, 0.22);
    s.logo!.x = 0.32;
    s.logo!.y = 0.68;
  }),
  'logo-transparent': spec((s) => {
    withLogo(s, 0.22);
    s.canvas.bg = null;
  }),
  'logo-no-plate': spec((s) => {
    withLogo(s, 0.2);
    s.logo!.plate.enabled = false;
  }),
  'art-cross': spec((s) => {
    s.mode = 'art';
    s.art.mark = 'cross';
  }),
  'art-dot': spec((s) => {
    s.mode = 'art';
    s.art.mark = 'dot';
  }),
  'art-square': spec((s) => {
    s.mode = 'art';
    s.art.mark = 'square';
  }),
  'art-loose': spec((s) => {
    s.mode = 'art';
    s.art.loose = true;
  }),
  'art-small-marks': spec((s) => {
    s.mode = 'art';
    s.art.markSize = 0.4;
  }),
};

const manifest: Record<string, { text: string; file: string }> = {};
for (const [name, s] of Object.entries(cases)) {
  const matrix = matrixFor(s);
  // No canvas in Node, so art mode runs without luminance: every dark module gets a
  // mark, every light one is left to the background. Marks-only must still decode.
  const cells = s.mode === 'art' ? decideCells(s, matrix, null) : undefined;
  const svg = renderSvgString(s, matrix, {
    cells,
    logoAspect: 1,
    withPixelSize: true,
  });
  const file = join(OUT, `${name}.svg`);
  writeFileSync(file, svg);
  manifest[name] = { text: TEXT, file };
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote ${Object.keys(cases).length} svgs to ${OUT}`);
