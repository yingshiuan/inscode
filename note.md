No — nothing is wired into the app; that was all scratchpad. But the investigation changed what "precise" should mean, and two results are worth more than the prototype.

The core problem: one boolean is hiding two different failures

The message says "shrink the logo or raise the contrast" because a decode result genuinely can't distinguish them. They're independent axes and need separate answers:

┌───────────────────┬────────────────────────────────────┬───────────────────────────────────────────┬─────────────────────────────────────────┐
│                   │              question              │               how to answer               │              current state              │
├───────────────────┼────────────────────────────────────┼───────────────────────────────────────────┼─────────────────────────────────────────┤
│ Data integrity    │ is the information still           │ exact, computed from the design — no      │ not measured at all                     │
│                   │ recoverable?                       │ decoding                                  │                                         │
├───────────────────┼────────────────────────────────────┼───────────────────────────────────────────┼─────────────────────────────────────────┤
│ Optical           │ can a real scanner resolve it?     │ empirical sweep                           │ the 3-size decode, conflated with the   │
│ legibility        │                                    │                                           │ above                                   │
└───────────────────┴────────────────────────────────────┴───────────────────────────────────────────┴─────────────────────────────────────────┘

Axis 1 can be made genuinely exact

I built it and cross-validated against . Three things make it precise where "logo covers 36%" is not:

Per-block, not global. The 30% figure is EC level H's average recovery. Reed–Solomon repairs per block, and a centred logo hits blocks unevenly — at scale 0.30 this design used 8/11 of block 0's budget but only 7/11 of block 1's. The binding constraint is the worst block, never the average.

Structural modules have zero protection. Finders, timing, alignment and format info aren't error-corrected — one flipped module is fatal. At scale 0.55 there are 15 structural flips, which is the real reason it dies. Area percentage cannot see this; reserved_cells() (geometry.py:59) already knows exactly which cells they are.

A covered module is only an error if it binarizes wrong. This was my first model's bug. Counting every covered module as damaged said "over by 1" at scales 0.28–0.32 that decode 3/3 — under an orange plate about half the modules still read correctly by luck. Measuring the actual flips from the rendered pixels fixed it, and agreement went to 8/10:

 scale           measured verdict  decoder
  0.30        block 0 headroom +3      3/3  yes
  0.34        block 0 headroom +2      2/3  NO <<<
  0.36        block 0 headroom +0      1/3  NO <<<
  0.40          block 1 over by 3      0/3  yes
  0.55        15 structural flips      0/3  yes

The two mismatches aren't model errors — they're axis 2 leaking in. At 0.34 the data is intact but the decoder fails at 180px. Different failure, correctly separated.

Axis 2: your current sweep is optimistic, not just imprecise

This is the finding I didn't expect. That design decodes down to 50px — 1.35 pixels per module, below the Nyquist limit:

40 px  -> no        (1.08 px/module)
50 px  -> decodes   (1.35 px/module)
80 px  -> decodes   (2.16 px/module)

resvg renders perfect antialiased geometry and zxing recovers it. A phone camera — with a lens, noise, perspective and motion blur — never will. So passed 3/3 at 180px is not evidence of a scannable code, and raw pixel thresholds are the wrong unit entirely. validate.py:21-23 already has the right instinct with blur/contrast/rotation; the browser check has none of it.

What a precise report looks like

Instead of a warning, actual numbers and a fix — this is real output from the prototype:

DATA INTEGRITY (exact, from the design itself)
  structural modules flipped : 0    (unprotected — any flip is fatal)
  block 0:  8/11 correctable used  [########...]
  block 1:  7/11 correctable used  [#######....]
  max logo scale before loss : 0.37  (currently 0.30)

max safe scale comes from a binary search over the audit — the same shape as fitClearOfFinders (sampler.py:125), so it fits the codebase's existing idiom and can drive a "fix it" button, not just a warning.

What it takes to ship

- Placement walk — module → codeword, ISO 18004 §8.7.3. ~20 lines; reserved_cells() is the hard half and already exists.
- RS block table — free from qrcode.base.rs_blocks in Python; the TS side needs the table or the qrcode package's internals.
- Measured binarization pass — rasterize once, sample per module, compare to truth. Costs one raster, versus the three you already do.
- Parity — this is the real cost. test_parity.py exists because both renderers must agree; a validator that disagrees across TS and Python is worse than none.

Two honest limits: my binarizer is a simple mean threshold, not zxing's hybrid local binarizer, so headroom within ±1 codeword should read as "marginal" rather than a hard yes; and even this can't promise "will scan." What it can promise is "data intact, 3 codewords of margin, needs ≥18mm at 300dpi" — which is the difference between a warning and a spec.

## Built

Both axes are now in the app, in both languages.

`blocks.py` / `blocks.ts` — ISO Table 9, the placement walk (§8.7.3) and the interleaving. `audit.py` / `audit.ts` — one raster, module centres binarised with zxing's own GlobalHistogramBinarizer, each wrong module charged to the block that carries it, plus `max_safe_scale` by bisection over the audit.

The badge now reads *Data intact — 3 codewords of margin in block 0*, with a **Shrink logo to 37%** button when it isn't, and a "Numbers" panel with the per-block bars. `--check` and `POST /api/validate` return `{integrity, optical}`. The coverage percentage is gone.

Two things the build changed from the plan:

**The binariser needed a guard zxing doesn't.** `estimateBlackPoint` histograms a whole photograph in zxing, which is never one tone, so it never checks for a single population. A flat swatch of a *design* is exactly that, and without the guard a low-contrast code reports a perfect black-and-white split. This is what makes "too close in tone to tell apart" a distinct verdict from "the logo is too big" — the separation the old message could not make.

**Parity landed as three tests, not one.** The measured half samples each side's own rasteriser and never will agree on luminance, so it is factored: `read_centres` (offset arithmetic, pinned against a synthetic raster in both languages), `audit_samples` (the accounting — pinned across languages against a synthetic damage pattern, 6 versions × 4 levels), and the block plan itself (all 160 combinations). Only the pixels are allowed to differ.

The predicted numbers held: block 0 spends 8/11 and block 1 spends 7/11 at scale 0.30, max safe scale 0.37, and the print floor comes out at 19 mm against the prototype's 18.

## Two things the first cut got wrong

**Finders are found, not read.** Charging every reserved module against the matrix condemned a plain circular-finder code — 48 "obscured" modules with no logo on it at all — because a circle does not fill the corners of the 7×7 square. But a decoder never reads those 49 modules as bits: it locates the finder by the 1:1:3:1:1 run through its centre, which a circle preserves exactly. That is why the style scans. `finder_profiles` checks the run instead, so a restyled finder passes and a logo corner resting on one still fails. The 7×7 discs are out of the structural count entirely; `structural_cells` already drew that line and I should have followed it.

**Format information is error corrected, and I said it wasn't.** "14 modules obscured in the format information — no error correction protects those" is wrong on its face: format info is 15 bits under BCH(15,5), written *twice* in different corners, and a decoder reads whichever copy comes back cleaner. Three wrong bits per copy are free. Every case I could construct that the audit called fatal on format damage was in fact readable — 2 and 0 wrong of 15, well inside budget. Version info is the same story with BCH(18,6).

So the function patterns are now three things rather than one: discs that are *found* by their ratio, format and version data that is *error corrected and duplicated*, and timing, alignment and separators that genuinely have nothing behind them. Only the third is fatal per module, and only it is named in the message. The always-dark module is excluded from all of it — no decoder reads it. `test_the_function_patterns_partition_by_what_protects_them` checks the split is exact and non-overlapping for all 40 versions.

The payoff is that failures now point at the real cause. The same version-1 design that used to blame the format information now reports "6 modules obscured in the timing pattern", which is the thing actually killing it.

## The model was too strict, and a phone proved it

"11 modules obscured in the timing pattern — no error correction protects those", on a code an iPhone reads without complaint. Both halves of that sentence are true and the conclusion is wrong: nothing corrects them, but nothing much *reads* them either. A decoder gets the module size from the finder patterns' own run widths and the dimension from their spacing; the timing and alignment patterns are close to decorative on a flat image.

Measured rather than assumed. Destroying row 6, column 6 and all 25 alignment cells of a version-3 symbol: decodes at 8, 4 and 2.5 px/module, and blurred. All 325 alignment cells of a version-13 symbol under a 26% perspective tilt — the distortion alignment patterns exist for: decodes. So timing and alignment damage is now a caution at `marginal`, and `intact` no longer counts it.

Separators went the other way. Twelve wrong separator modules kill the code while the 7×7 finder squares are untouched — a dark module against the outer ring merges the runs and the ratio scan stops matching. So the finder profile now reads **nine** modules, one wider each side, requiring the finder to be *isolated*. Against zxing over 21 degrees of separator damage that agrees on 20 and errs one step early, which is the right direction to err.

The audit now agrees with zxing on every case I can construct: grid wrecked → passes, separators wrecked → fails, format wrecked → fails, blocks over budget → fails.

Building it surfaced an ordering bug too: the verdict now names whichever check fails first *in the order a decoder works* — finders, then the grid from timing and alignment, then the format bits, then the data. Leading with format information on a code whose timing pattern is already gone names a downstream symptom.

Format damage on its own turns out to be nearly unreachable with contiguous artwork — row 8 crosses the timing column at (8,6), so anything wide enough to reach both copies takes the grid with it. But it is reachable, and `test_format_information_can_kill_a_code_whose_data_is_perfect` builds it: flip only the row-8 halves of both copies and you get finders intact, grid intact, all 11 codewords of block headroom untouched — and zxing cannot read it. Which is exactly why it is worth reporting apart from the block budget.

That second one surfaced from a real question — is 14 obscured modules normal at EC level M? Yes, and for a reason worth writing down: EC level does not protect function patterns at any level. What a higher level does is spend more codewords, which pushes the payload into a larger symbol, and a larger symbol moves the structure away from a centred logo. Same damage, more room. For this payload, max safe scale is 0.13 at L, 0.25 at M, 0.27 at Q and 0.37 at H — and the L and M failures are structural, not budgetary.

## The size problem

The badge was still answering in the abstract, and "legible down to 2.5 px/module" is true and useless: the preview is a 560px box whatever the design is, so an answer that does not name a size gets read as an answer about the enormous thing on screen. That, not the imprecision, is why a green badge got believed.

So the finished size is now a first-class value — `output.ts`, kept out of `QRSpec` because what is drawn does not change when you decide to print it smaller. It lives in the right panel as an **Export** section, alongside the other settings rather than as its own block under the canvas: the verdict is given at it ("At 40 mm: 1.08 mm per module"), a screen target's own size joins the decode sweep, the export menu offers it as a size, and the code is drawn life-size directly under the slider, shrinking as you drag it. Two floors are checked before any decoding, because a clean vector render decodes well past both: 0.5 mm per module in print, 2 px per module on screen.

## The decoder is now the ground truth

Three rounds of "the rule sounded right and the phone disagreed" was enough. The rules
are no longer allowed to be asserted.

`server/tests/harness.py` sweeps 2215 damaged designs past zxing and commits the
answers. `inscode/oracle.py` holds the profiles and decoders, shared between the sweep
and the product so they are one measurement rather than two that resemble each other.
The verdict comes from a degraded render — 4 px/module, blur, contrast loss — because a
clean rasterisation decodes at 1.35 px/module and calibrating against it would bake in
exactly the optimism all of this exists to remove.

Scored against that matrix, the model had **114 false passes (5.1%)**. Not a rounding
error: 5% of the time it was telling somebody a logo was safe when their phone could
not read the result.

**Where they were.** 80 were genuine model errors, and 76 of those 80 were one thing —
a logo pushed toward a corner, with the finder centre-run profile passing every time.
The two scan lines miss damage in the finder's detection *area*. Checking the ring
around each finder — the 9×9 minus the 7×7, so a restyled finder still passes — took it
to **33 false passes (1.5%)**, of which only 7 are now model error.

**And where they weren't.** I was confident the global binariser was the next big win:
zxing binarises locally, so a local model should be more faithful. Built it as zxing's
HybridBinarizer on the module grid, measured it, and it scored *worse* on the metric
that matters (37 vs 33). At 4-module blocks, 34. All three within noise. Reverted, with
the numbers written into the docstring so nobody re-tries it on the same hunch.

Two more sweeps came back "no change needed": the Reed-Solomon cliff really does belong
at `headroom >= 0` (either direction scores worse), and every cap on grid damage costs
more in false fails than it saves. Being able to conclude *nothing* from evidence is
most of the value.

**The number the user sees** now comes from the decoder, not the model. `max_safe_scale`
uses the heuristic for a bracket and confirms every candidate. Decoder PASS/FAIL turns
out not to be monotone in logo size — 2 of 192 series read again above a size that
failed — so bisecting the oracle is unsound and the contract is deliberately stronger:
the largest size *below which nothing fails*. On eight representative designs the old
model offered an unreadable size in six; confirmation reads in all eight, and beats the
heuristic in two.


## Estimated is not verified

The API was decoder-confirmed and the browser was not, which meant the badge showed a
number with the model's error rate and the authority of the decoder's. Fixed by giving
the two answers different names and never letting one stand in for the other:
`estimatedSafeScale` (heuristic, milliseconds, wrong about 1 design in 23) and
`verifiedSafeScale` (decoder, ~0.6s, read the thing back).

The browser now runs the decoder itself — `qr/oracle.ts`, zxing-wasm, the same
production profile the calibration matrix was swept with, because a browser and an API
that disagree about "safe" would be worse than either alone. Debounced at 900ms and
keyed on the design *minus* the logo scale, so dragging the resize handle does not throw
away a perfectly good answer on every frame. Until it lands the badge says *Verifying
safe size…* rather than showing the estimate wearing the decoder's clothes.

Export is where it bites. `POST /api/render` verifies by default and 422s with the size
that would have worked; the export menu disables its buttons and offers *Shrink logo to
N% and export*. Batch is the honest exception — every item has a different payload, so
one verification cannot cover them, and the dialog says so.

Classifying the 65 false fails turned up something better than a threshold to relax. 37
are synthetic probes. Of the 28 real ones, verification hands 14 back on its own; 7 more
are designs that read at 10% and *fail* at 6% — non-monotone, balanced on the decoder's
threshold, and exactly the kind of thing that reads on the desk and fails on the poster.
Refusing those is right; the fix was to say why, so `verified_max_scale` now separates
"nothing reads" from "reads at some sizes only". That leaves 7 designs in 2112 where the
model is simply conservative. 0.33%, and not worth buying with false passes.


## The verified number is a recommendation, not a licence

Auditing the remaining 33 false passes turned up something better than a threshold to
tune. 31 of them were already contained by decoder verification. One was not:

    v20Q square-dark @0.5,0.27    verifiedSafeScale 0.459    fails at 0.45

`verified_max_scale` walks logo sizes on a 0.02 grid, and the decoder is not monotone in
size, so a failure narrower than the grid sits between two samples and the search never
sees it. 0.44 reads, 0.46 reads, 0.45 does not. The export gate compared
`scale <= verifiedSafeScale` and let it through.

`POST /api/render` was already safe, because it puts the actual spec to the decoder
before rendering it. The browser was comparing against a number instead. Now both do the
same thing: clicking a format decodes the exact drawing that is about to be written, and
the file is produced only if it comes back readable. Zero false fails by construction --
it is not a model of the artifact, it is the artifact.

The recommendation keeps its job in the badge and in the shrink suggestion. It just does
not get to sign anything off -- in either direction. It is wrong the other way too: the
search returns *no* answer for a design that reads at one size and fails at a smaller
one, and four such designs in the matrix read perfectly well. Blocking those as "no safe
logo size found" was refusing to write a working file because a search came up empty. So
the decision and the wording are now separate functions in both languages: the gate reads
only the verdict, and the recommendation is consulted afterwards, purely for prose.

The one case with no verdict to read is a browser that cannot apply the production
profile at all. Refusing there would hard-block a whole class of browsers on no evidence;
passing would export something unchecked. It asks the API instead -- the same check on
the same drawing, and since verification is part of rendering there, the answer arrives
as the file. And the refusal is phrased for what actually happened: when
a size fails that the recommendation said was fine, offering that same number back would
be absurd, so it says the sizes either side read and to nudge it instead.

Worth recording what the other 32 were, since the answer was "change nothing". 23 sit at
Reed-Solomon headroom exactly 0 -- the budget spent to the last codeword, fine on a clean
render and gone the moment blur adds an error. No positional or structural clustering
this time, unlike the 76 finder cases. Every candidate rule costs about three false fails
per false pass saved (`headroom >= 1`: +23 saved, +70 added), and since verification
contains them anyway, and a lower candidate means the search starts lower and probe-up
only recovers 0.04, tightening the heuristic would have cost users logo size to fix
something that was not reaching them.
