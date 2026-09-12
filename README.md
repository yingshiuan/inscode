# inscode

A browser design tool for logo-embedded QR codes, plus a stateless Python render API.

Puts a logo on a QR code and tells you the truth about it: how large the logo can be
before the payload stops being recoverable, whether the finished thing is legible at
the size you are actually printing, and — at the moment of export — whether a real
decoder can read that exact file. Nothing is written that has not been read back.

Grown from `python/qr_logo.py`, which is kept as the reference implementation.

<pre>
┌──────────────────────────────────────────┐
│ ▣ inscode        [Undo][Redo]  [Export ▾]│
├────────┬───────────────────────┬─────────┤
│ CONTENT│                       │ STYLE   │
│ Logo   │      ┌─────────┐      │ ▪ ● ✚ ◆ │
│ [drop] │      │ ▪ ◍LOGO │      │ ██  ░░  │
│ Mode   │      └─────────┘      │ ○  □  ◉ │
│        │   drag logo to move   │─────────│
│        │  ● Data intact — 3    │ EXPORT  │
│        │    codewords spare    │ 40 mm   │
│        │  ● At 40 mm: 1.08 mm  │ ──○───  │
│        │    per module         │    ▪    │
│        │                       │ actual  │
└────────┴───────────────────────┴─────────┘
</pre>

## Running it

Two processes. The web tool works on its own; the API adds print-resolution
rendering and batches.

```bash
# Web tool -> http://localhost:5173
cd web && npm install && npm run dev

# Render API -> http://127.0.0.1:8000  (optional)
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
cd server && ../.venv/bin/uvicorn app:app --reload
```

Vite proxies `/api` to the backend, so no configuration is needed when both run.

## What it does

- **Two modes.** *Centre logo* puts artwork on a cleared plate; *full bleed* fills
  the code with artwork and turns the modules into small marks drawn over it.
- **Drag to place.** Move and resize the logo anywhere, with snapping to the centre
  lines. Not just dead centre.
- **Six module shapes**, adjustable gap, three finder shapes, independent colours,
  and a real transparent background.
- **Live scannability, on two axes.** *Is the data still recoverable* is modelled from
  the design, per Reed-Solomon block; *can a scanner resolve it* is measured by
  decoding the design blurred, faded and rotated. When the logo is too big the badge
  offers a size that fits — an estimate while you drag, replaced by a decoder-verified
  number a moment after you stop.
- **It tells you when the logo *file* is the problem.** A mark flattened onto an
  opaque background covers modules over its whole bounding box, not just where its
  ink is — which costs real logo size and looks like nothing at all in the preview.
- **Answered at the size you are actually making.** Set the finished width in
  millimetres or pixels under *Export*, and the code appears there at that size,
  life-size, shrinking under the slider as you drag it. The preview is a 560px box
  whatever the design is, which is the real reason a green badge gets believed.
- **PNG, JPG, SVG** up to 4096px, all from the same drawing.
- **Nothing exports unread.** Clicking a format decodes that exact file first and
  refuses if it cannot be read, offering the size that would work instead.
- **Batch**: one design, many links, returned as a ZIP.

## How it fits together

```
mirrored     spec · encode · geometry · shapes · sampler · blocks · audit · logoInk · validate · oracle
             renderSvg.ts / svg.py        build.ts / render.py

web only     fitFinders · layout · output · exportGuard · useRender
API only     raster · cli
```

Two renderers, one contract. The browser needs to redraw at 60fps while you drag,
which rules out a network round-trip; the API needs to run without a browser. So the
drawing logic exists in both languages, and three things keep them honest:

**1. `QRSpec` is the contract, and the browser ships its own encode result.**

The real risk was never the drawing — it was the *encoding*. `qrcode` (JS) and
`qrcode` (Python) run their own segment optimisation and their own mask-penalty
scoring, so the same URL legitimately produces a different matrix on each side. Both
scan. They look different, which is fatal for a design tool.

So a spec carries an optional `encoded` block holding the matrix the browser already
computed, and the server draws those bits rather than re-deriving them. Same for
`art.cells`, the per-module sampling decisions. Both are optional, so
`POST /api/render` still works from curl with nothing but `content`.

The fixture suite measures how much this matters — today, **1 of 19 fixtures disagrees
on the auto-selected mask, and 1 differs at bit level even with the mask pinned** (the
payload gets segmented differently). The exact count moves with the payload; that it is
never zero is the point. Pinning the mask is *not* sufficient — the `bits` field is what
carries the guarantee.

**2. Both sides render SVG; raster comes from the SVG.**

The original drew with PIL at 4× and downsampled. Emitting SVG instead means Python
gains vector export, the supersampling disappears, and PNG is a rasterisation of the
SVG rather than a second drawing that resembles it.

**3. The tests hold the two to each other.**

`server/tests/test_parity.py` renders every fixture through both and asserts
byte-identical SVG, then decodes the raster at 800 / 400 / 200px. `web` has a test
that checks the geometry port against node-qrcode's own function-pattern table for
all 40 versions.

```bash
cd web && npm test          # geometry + block table vs node-qrcode; export policy
.venv/bin/python -m pytest server/tests -q   # parity, decode, audit, decoder matrix
cd web && npm run fixtures  # regenerate the TS reference after a renderer change
.venv/bin/python server/tests/harness.py --write   # regenerate the decoder matrix (~45s)
```

## API

Stateless. Nothing is written to disk, nothing is stored, and request logging
excludes payload text and logo bytes.

| Endpoint | |
|---|---|
| `POST /api/render` | `{spec, format, px, matte, verify}` → image bytes; verifies with a decoder by default and refuses (422) what it cannot read |
| `POST /api/batch` | `{template, items[], format, px}` → ZIP (max 200) |
| `POST /api/validate` | `{spec, output?}` → `{integrity, optical, fit, logo}` — block audit (both `estimatedSafeScale` and decoder-verified `verifiedSafeScale`), stress sweep, the verdict at your finished size, and an advisory on the logo file itself |
| `GET /api/health` | |

```bash
curl -X POST localhost:8000/api/render -H 'Content-Type: application/json' \
  -d '{"spec":{"content":{"text":"https://insdash.ch"},"modules":{"shape":"circle"}},
       "format":"png","px":1024}' -o qr.png
```

## CLI

`server/inscode/cli.py` keeps the original script's interface, on the shared core:

```bash
cd server
python -m inscode.cli "https://insdash.ch" logo.png out.png
python -m inscode.cli "https://insdash.ch" logo.png art.png --art --mark cross --check
python -m inscode.cli "https://insdash.ch" logo.png off.png --x 0.3 --y 0.7 --check
python -m inscode.cli "https://insdash.ch" logo.png card.png --check --print-mm 22
```

`--check` reports both axes and exits non-zero if the result is fragile. Add
`--print-mm` or `--screen-px` to have it answer at the size you are actually making:

```
fail: At 14 mm: 0.38 mm per module is under the 0.5 mm floor — print at least 19 mm wide

data integrity (modelled from the design)
  finder patterns readable : 3/3  (by the 1:1:3:1:1 run through each centre)
  grid modules wrong       : 0    (timing/alignment — uncorrected, but survivable)
  format information       : 0 and 0 wrong of 15    (BCH corrects 3 per copy, either copy will do)
  block 0:  8/11 correctable used  [########...]
  block 1:  8/11 correctable used  [########...]
  logo scale, now            : 0.30
    estimated safe (model)   : 0.37
    verified safe (decoder)  : 0.35

optical legibility (measured)
  ok   large          8.0 px/module
  ok   screen         4.0 px/module
  ok   small print    2.5 px/module
  ok   soft focus     4.0 px/module
  ok   low contrast   4.0 px/module
  ok   rotated 12°    4.0 px/module
  print at least 19 mm wide

at the size you asked for (14 mm)
  FAIL 0.38 mm per module is under the 0.5 mm floor — print at least 19 mm wide
```

## Two questions, not one

"Does it scan?" is two independent questions, and a decode result cannot separate
them. That is why the badge used to say *shrink the logo **or** raise the contrast* —
it genuinely did not know which.

### Is the data still recoverable?

Modelled from the design, without decoding anything. `blocks.py` / `blocks.ts` walk the
codeword placement of ISO/IEC 18004 §8.7.3 to map every module to the Reed-Solomon
block it carries — that part is exact integer arithmetic. `audit.py` / `audit.ts`
rasterise once, binarise each module centre, and charge each wrong module to its block
— that part is a measurement, and measurements are wrong sometimes. Three things it
gets right that "the logo covers 31%, level H recovers 30%" does not:

- **The worst block binds, not the average.** 30% is a mean over blocks. Interleaving
  spreads a contiguous logo across every block but not evenly — the same design at 24%
  spends 7 of block 0's 11 correctable codewords and 6 of block 1's. Which way the
  split falls depends on the payload's own bits, so the report gives you the blocks
  rather than a percentage.
- **Function patterns are not covered by the block budget at all.** Finders, format
  info, timing and alignment are read before any Reed-Solomon repair happens, so the
  blocks can look healthy while the code is dead. Area cannot see this — and, as the
  next section covers, neither can one rule for all four of them.
- **A covered module is only an error if it binarises wrong.** Under a mid-tone
  plate roughly half of them still read correctly, so counting coverage condemns
  designs that scan perfectly well.

It also inverts: a binary search over the audit gives the largest logo the model
believes the data survives. That number is an **estimate**, not a guarantee — see
*Estimated, verified, exported* below, which is the difference between the badge while
you drag and the number the export path will act on.

### The function patterns are four different things

Treating them as one — "reserved cells, any wrong module is fatal" — is wrong four
different ways. Three of them condemn designs that read perfectly well; the fourth
passes designs that do not:

- **Finder discs are *found*, not read.** A decoder locates each one by the 1:1:3:1:1
  run through its centre, never as 49 bits. Diffing them module by module condemned a
  plain circular-finder code, with no logo on it at all, as "48 modules obscured" —
  because a circle does not fill the corners of the 7×7 square. `finder_profiles`
  checks the run instead, so a restyled finder passes and a logo corner resting on one
  still fails.
- **Format and version information carry their own error correction.** 15 bits under
  BCH(15,5) and 18 under BCH(18,6), each written *twice* in different corners. Both
  correct up to three wrong bits and a decoder reads whichever copy comes back
  cleaner, so damage is fatal only when both copies are past budget. Counting it as
  unprotected produced "14 modules obscured in the format information — no error
  correction protects those" on codes that were entirely fine.
- **Timing and alignment are uncorrected but survivable.** Nothing repairs them — and
  nothing much reads them either. A decoder derives the module size from the finder
  patterns' own run widths and the dimension from their spacing, so on a flat image the
  timing and alignment patterns are close to decorative. Measured against zxing:
  destroying row 6, column 6 *and* every alignment cell of a version-3 symbol still
  decodes at every size tested, blurred included; so does wiping all 325 alignment
  cells of a version-13 symbol under a 26% perspective tilt. Calling that fatal
  contradicts the phone in the user's hand, so it is reported as a caution and the
  payload verdict stands.
- **Separator damage is finder damage.** A dark module against a finder's outer ring
  merges the runs and the ratio scan stops matching — twelve of them kill a code whose
  7×7 squares are untouched. That is why the profile scan reads *nine* modules, one
  wider than the finder on each side: the finder has to be isolated. Checked against
  zxing over 21 degrees of separator damage, it agrees on 20 and errs one step early.

The always-dark module is excluded from all of this: no decoder reads it.

The one-line verdict names whichever of these fails **first in the order a decoder
works** — locate the finders, read the format bits, unmask, read the data — so a
downstream symptom never leads. Grid damage is reported last, because it is a caution
rather than a cause of death.

Error correction level does not enter this axis at all — timing, alignment and format
modules are read before any repair happens, at every level. What a higher level does is
spend more codewords, which pushes the payload into a larger symbol, and a larger
symbol moves the structure further from a centred logo. Same damage, more room.

The integer half must be identical in both languages, and `test_parity.py` checks all
160 version/EC-level combinations plus a synthetic damage pattern. The measured half
samples each side's own rasteriser, so the two agree on verdicts rather than on
luminance — resvg and a browser canvas antialias differently and always will.

### Can a scanner resolve it?

Not computable — only measurable, and only against a size. `validate.py` /
`validate.ts` decode the design at several sizes, blurred, faded and rotated. Three
deliberate choices:

- The sweep is expressed in **pixels per module**, because 180px is generous for a
  small code and hopeless for a dense one.
- Nothing below **2 px/module** is measured. A clean vector render decodes at
  1.35 px/module and a phone camera never will, so a pass down there is an artefact of
  the test. It is a floor, checked before any decoding, not something the sweep is
  allowed to argue with. The same applies to the **0.5 mm** minimum module size in
  print.
- The verdict is given **at the finished size**, never in the abstract. "Legible down
  to 2.5 px/module" is true and useless: an answer that does not name a size gets read
  as an answer about the enormous thing on screen.

## The decoder is the ground truth

The rules above are not asserted. Every one of them is calibrated against, and
validated by, a matrix of real decode results — because three times in a row this
project shipped a rule that sounded right and contradicted a phone.

`server/tests/harness.py` sweeps a grid of damaged designs past a real decoder and
commits the answers to `server/tests/data/decoder-matrix.json`: 2215 rows across 5
versions × 4 EC levels × logo shape, tone, size and position, plus structural damage
families swept by degree. Regenerating takes ~45s and is a deliberate act, so normal
test runs just read the file:

```bash
.venv/bin/python server/tests/harness.py --write     # regenerate, ~45s
.venv/bin/python -m pytest server/tests -q           # reads the committed matrix
```

The verdict is taken from a **degraded** render, never a clean one — a perfect vector
rasterisation decodes at 1.35 px/module and no camera will. The production profile is
4 px/module, blur 1.6, contrast 0.7; every undamaged symbol from version 1 to 20
survives it, so a failure is about the design rather than the profile being unfair.
Profiles and decoders are lists (`inscode/oracle.py`, mirrored in `qr/oracle.ts`), so
JPEG, perspective or a second decoder is a config change rather than a rewrite. One
`Profile` type and one renderer serve all three callers — the production safety verdict,
the legibility ladder in `validate.*`, and the calibration sweep — so a change to how a
code is degraded cannot apply to one of them and not the others.

**What the matrix has settled so far** — 2215 designs, zxing-cpp, production profile:

| change | false pass | false fail | agreement |
|---|---|---|---|
| starting point | 114 (5.1%) | 12 (0.5%) | 94.3% |
| + finder ring check | **33 (1.5%)** | 67 (3.0%) | 95.5% |
| + local binariser | 37 (1.7%) | 60 (2.7%) | 95.6% — *rejected* |

The finder ring was worth it: 76 of the 80 genuine model errors were a logo pushed
toward a corner with the centre-run profile passing every time. The local binariser
was not — zxing binarises locally, so a local model *should* be more faithful, and it
measurably wasn't, so the simpler global threshold stays. Two further sweeps confirmed
the Reed-Solomon cliff belongs exactly at `headroom >= 0` and that capping grid damage
costs more than it saves. All four are pinned as tests, so changing them means moving
a number and showing the work.

Of the 67 remaining false fails, most are synthetic structural probes rather than
designs anyone would draw; 30 are realistic, 1.4% of the logo sweep. Decoder
verification hands about half of those straight back, and of the rest most are designs
that read at one size and fail at a smaller one — correctly refused. Every lever that
would trade the remainder away costs about three false fails per false pass saved,
which is why none has been pulled.

**The heuristic proposes; the decoder disposes.** `heuristic_max_scale` finds a bracket
fast; `verified_max_scale` hands every candidate to a real decoder and returns only a
size it has actually seen read. Decoder PASS/FAIL is *not* monotone in logo size — 2 of 192
series read again above a size that failed — so the answer is the largest size *below
which nothing fails*, verified at sampled points underneath. Measured on eight
representative designs, the old model offered a size the decoder could not read in six
of them; confirmation reads in all eight, and is *larger* than the heuristic in two.

Costs ~0.6s, so it runs on the export and API path while the preview keeps the
unconfirmed heuristic for dragging.

## Estimated, verified, exported

Two answers to "how big can this logo be", and the product never lets one wear the
other's clothes.

| | `estimatedSafeScale` | `verifiedSafeScale` |
|---|---|---|
| source | the heuristic model, one render | a real decoder, ~20 renders and reads |
| cost | milliseconds | ~0.6s |
| accuracy | **33 false passes, 67 false fails, 95.5% agreement** over 2215 designs | it read the thing back |
| used for | the live badge while dragging | the badge, and the *Shrink logo to N%* button |

Neither authorizes an export. That is a third thing, below.

The heuristic is **not precise and not decoder-equivalent.** It is a fast approximation
that is wrong about 1 design in 23, and 33 of those errors are in the dangerous
direction — calling a design safe that a decoder cannot read. It exists to keep the
preview responsive, and to give the verification a bracket to start from.

```
user interaction → fast heuristic → estimated safe size
                                          │ debounce 900ms
                                          ▼
                                   decoder oracle → verified safe size → export
```

While verification is outstanding the badge says *Verifying safe size…* rather than
showing the estimate as though it were confirmed. Verification is keyed on the design
*minus* the logo scale, so resizing does not throw the answer away; anything else
changing does. The export buttons are not held on it — clicking one runs its own check,
which is both faster and stricter than waiting for a recommendation.

**The export invariant: nothing is written unless that exact artifact read back.**

Not "unless its size is within the verified maximum" — that is a weaker claim, and a
false one. `verified_max_scale` samples logo sizes on a 0.02 grid and the decoder is
not monotone in size, so a failure narrower than the grid hides between two passing
samples. The matrix has held one on every payload tried so far — most recently a
version-20 Q design that verifies to **0.466** and does not read at **0.44**, while
0.43 and 0.45 both do. `scale <= verifiedSafeScale` would have exported it. Where the
notch lands is a property of one symbol's bits, so `test_decoder_matrix.py` sweeps for
it rather than pinning a number.

It is equally wrong in the other direction: the search returns *no* answer for a design
that reads at one size and fails at a smaller one, and such designs read perfectly
well. So it cannot be a veto either — refusing to write a working file
because a search came up empty is still a bug.

So `verifiedSafeScale` stays where it is useful — the badge, and the *Shrink logo to
N%* suggestion — and authorization comes from putting the exact drawing through the
production decoder at the moment of export. In both languages the decision and the
wording are separate functions: the gate is one line that reads only the decoder's
verdict, and the recommendation is consulted afterwards, purely to phrase the refusal.

`POST /api/render` verifies by default and returns 422 with the size that would work
(`verify: false` opts out for thumbnails and mock-ups); clicking a format in the browser
does the same before writing the file. Where a design reads at one size and fails at a
smaller one, both refuse and say so, because a code balanced on the decoder's threshold
is not one to hand anybody.

A browser that cannot apply the production profile — no canvas filters — cannot reach a
verdict on its own. Rather than hard-blocking on no evidence, it asks the API, which
runs the identical check on the identical drawing and hands back the file with it; a
422 there is a real decoder result standing in for the missing one. Only when neither
can answer is the export refused for want of a verdict.

Batch generation is the deliberate exception: every item carries a different payload
and so damages the logo differently, and verifying 200 of them would take minutes. The
dialog says so.

## The logo file is a variable too

Everything above treats the logo as a shape at a size. It is also a *file*, and how
it was exported changes the answer more than anything about how it looks.

Same artwork, same size, same payload, only the file changing — largest logo the
production decoder still reads:

| logo file | largest safe scale |
|---|---|
| colour, alpha preserved | **0.72** |
| the same artwork forced to pure black-and-white, alpha kept | 0.64 |
| colour, alpha flattened onto white | **0.48** |
| black-and-white, flattened onto white | **0.48** |
| flattened onto black | 0.42 |

Opacity is the dominant term, by about three to one. Tone is not free — sweeping the
foreground from black through mid grey to white, and through saturated red, blue and
yellow, moves `estimatedSafeScale` between 0.645 and 0.754 — but flattening the same
artwork costs 0.24 on its own. And once it is flattened the tone stops mattering at
all: the colour and the black-and-white versions land on the same 0.48, because by
then the background is doing most of the damage.

The mechanism is simply area. A logo with an alpha channel damages only the modules
its ink covers; a flattened one damages every module in its bounding rectangle. So
the sparser the mark the more it costs — this fixture is a 25%-ink ring and loses
0.24, where the 79%-ink disc it replaced lost only 0.06. Which is exactly backwards
from how the files arrive: one-colour and line-art marks are the sparsest *and* the
ones usually shipped flat, as JPEG or with a white background baked in.

The trap is that it is invisible. A white background on a white canvas looks like
nothing at all, and the design just quietly gets a smaller safe logo with no reason
given. So `logoink.py` / `logoInk.ts` profiles the artwork and says so: what share of
it is a flat opaque field, and how many of the modules the logo covers land on that
field rather than on ink — the ones a transparent export hands straight back.

Two guards keep it from giving advice that would damage a logo. A background is only
claimed when the border agrees with itself, so a photograph and a two-tone mark
running to the edge of its box are both left alone; and full-bleed art mode is never
warned about, because opaque is the point there. When a plate is enabled the note
changes rather than disappearing — the plate is already clearing those modules, so
keying the logo out gains nothing until the plate is off too.

`test_logoink.py` checks the promise against the decoder rather than the model:
keying out the colour the warning names has to actually let a larger logo read.

## Things worth knowing

- **Scan your exports with a real phone.** The audit's binariser is a global
  threshold where a real decoder's is local, so the last codeword or two of headroom
  is not a promise — the badge says *marginal* rather than *fine* there. And no
  amount of arithmetic covers print gain, gloss or a bad angle.
- **Export logos with their alpha channel.** A flattened background costs real logo
  size and shows up nowhere in the preview; the badge notes it when it finds one.
- **The finder patterns stay solid in every style.** Breaking those three corners
  into loose dots is the main reason decorative QR codes fail to read.
- **`--loose` / "Loose grid" is genuinely less robust** — it draws the timing and
  alignment patterns as marks too. The audit counts those as grid damage and reports
  it as a caution rather than a failure, because measurement says a decoder locks the
  grid from the finder patterns and survives losing them. Verify the export anyway.
- **cairosvg cannot rasterise this correctly.** It silently ignores `<mask>` and
  `<clip-path>`, which breaks the transparent plate and full-bleed transparency. The
  API uses resvg. If you swap the rasteriser, run the parity tests.
- **PDF export is not wired up.** The rasteriser change dropped cairosvg, which was
  the PDF path. SVG imports cleanly into Illustrator and InDesign in the meantime.

## A note on the rename

This was `qrstudio` until recently. The Python package, the module paths, the window
title and the API title all moved; the one that needed care was the browser's
localStorage key, because that is part of the product's contract with the browser
rather than an internal name — changing it outright would have silently orphaned every
design anyone had saved.

`useQrStore.ts` copies the old key to the new one on first load, once, and leaves the
original in place so a browser that runs an older build still finds its data. The copy
is wrapped in try/catch: private windows and blocked site data throw on access.

## Not included, deliberately

Share links and saved presets need persistence, which is out of scope by choice —
the API stores nothing. Presets live in the browser's local storage. A `QRSpec` is
small enough to pack into a URL hash if that is ever wanted, minus the logo.

## License

MIT — see [LICENSE](LICENSE).
