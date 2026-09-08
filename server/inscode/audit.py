"""Is the information still recoverable? -- answered from the design, not by decoding.

A decode result is one boolean covering two independent failures, which is why the
old message had to say "shrink the logo or raise the contrast": it genuinely could
not tell which. This module answers only the first question, exactly:

    Is enough of every Reed-Solomon block intact for a decoder to repair the rest?

`validate.py` still answers the second -- can a real scanner resolve it -- because
that one is optical and only a sweep can answer it.

Three things make this precise where "the logo covers 31%" is not:

  * Per block, not global. 30% is level H's *average*; Reed-Solomon repairs per
    block and interleaving spreads a centred logo over the blocks unevenly. The
    binding constraint is the worst block, never the mean.
  * Structural modules have no error correction at all. Finders, timing, alignment
    and format info are read before any repair happens, so one wrong module there
    is fatal however healthy the blocks look. Area percentage cannot see this.
  * A covered module is only an error if it *binarizes* wrong. Counting coverage
    calls a code dead that scans fine, because under a mid-tone plate roughly half
    the modules still read correctly. So the modules are measured from the rendered
    design rather than assumed.

Mirrors web/src/qr/audit.ts -- change both together. The integer half (blocks.py)
is identical in both by construction; the measured half samples each side's own
rasteriser, so the two agree on verdicts rather than on luminance.
"""
import io
from dataclasses import dataclass, field, replace
from typing import Callable

from PIL import Image

from .blocks import BlockPlan, block_plan, module_codewords
from .encode import Matrix, matrix_for
from .geometry import (
    FUNCTION_BCH_CORRECTS,
    finder_boxes,
    format_info_copies,
    grid_kinds,
    version_info_copies,
)
from .raster import render as rasterise
from .render import build_svg
from .spec import QRSpec

#: Pixels per module when sampling. Odd, so every module has a true centre pixel.
RASTER_SCALE = 9
#: Sample the middle third of each module -- the part a scanner reads, and the part
#: two different rasterisers agree on. Module edges are all antialiasing.
CENTRE = 3
#: Buckets in the luminance histogram, as in zxing's GlobalHistogramBinarizer.
BUCKETS = 32

#: The run a decoder scans for through the centre of a finder -- the 1:1:3:1:1 ratio
#: of ISO/IEC 18004 s6.3.3 -- widened by one module each side, because the finder has
#: to be *isolated* for the ratio to match. A dark module against the outer ring
#: merges the runs and the scan stops finding it, which is why separator damage kills
#: a code while timing and alignment damage does not. Checked against zxing over 21
#: degrees of separator damage, this agrees on 20 and errs one step early on the last.
FINDER_PROFILE = (False, True, False, True, True, True, False, True, False)

#: Wrong modules tolerated in a finder's surrounding ring -- the 9x9 detection area
#: minus the 7x7 pattern itself, i.e. the separator and the quiet-zone edge.
#:
#: Zero, and that is measured rather than cautious. Swept over the calibration matrix
#: (2215 rows, zxing-cpp, "phone" profile), holding everything else constant:
#:
#:     tolerance   false pass    false fail   agreement
#:             0    33 (1.5%)    65 (2.9%)       95.6%
#:             1    48 (2.2%)    47 (2.1%)       95.7%
#:             2    52 (2.3%)    15 (0.7%)       97.0%
#:             5   108 (4.9%)    12 (0.5%)       94.6%
#:
#: Tolerance 2 has the best raw agreement. Zero is chosen anyway, because a false pass
#: is the product telling somebody a logo is safe when their phone cannot read the
#: result, and a false fail only costs them a slightly smaller logo -- which
#: `verified_max_scale`'s upward probe wins back where the decoder allows it.
#:
#: Before this check existed the model scored 114 false passes (5.1%); 76 of them were
#: a logo pushed toward a corner, with the centre-run profile passing every time.
FINDER_RING_TOLERANCE = 0

#: How to name each kind of grid damage. Which one it is changes what to do.
KIND_NAMES = {
    "alignment": "alignment pattern",
    "timing": "timing pattern",
    "separator": "finder separator",
}
#: A design with a headroom this thin is reported as marginal rather than safe: the
#: binariser here is a global threshold, where a real decoder's is local, so the
#: last codeword or two of margin is not something to promise.
THIN_MARGIN = 1


@dataclass(frozen=True)
class BlockDamage:
    index: int
    data_codewords: int
    ec_codewords: int
    correctable: int
    #: Codewords holding at least one wrong module. The unit Reed-Solomon spends.
    corrupted: int

    @property
    def headroom(self) -> int:
        return self.correctable - self.corrupted


@dataclass(frozen=True)
class Audit:
    version: int
    ec_level: str
    #: False when the histogram has too little dynamic range to binarise at all --
    #: a contrast failure, which no amount of shrinking the logo will fix.
    contrast_ok: bool
    black_point: int
    #: Luminance between the two histogram peaks. The contrast the design actually has.
    contrast_spread: int
    #: Wrong modules in the timing and alignment patterns and the finder separators.
    #: Nothing corrects these -- but nothing much reads them either: a decoder locks
    #: the grid from the finder patterns, and destroying every one of these still
    #: decodes. Reported as a caution, not a cause of death. See `geometry.grid_kinds`.
    grid_flips: int
    modules_flipped: int
    #: Those flips broken down by what was hit, so the message can name it.
    grid_kinds: dict[str, int] = field(default_factory=dict)
    #: Wrong modules in each of the two copies of the format information. Each copy is
    #: a BCH(15,5) codeword that survives up to FUNCTION_BCH_CORRECTS of them, and a
    #: decoder reads whichever copy comes back cleaner.
    format_errors: tuple[int, int] = (0, 0)
    #: The same for version information, or None on versions 1-6, which carry none.
    version_errors: tuple[int, int] | None = None
    #: Whether each of the three finders can still be found: its centre run reads
    #: 1:1:3:1:1 *and* the ring around it is clear. Not a module-by-module diff of the
    #: 7x7 -- that would condemn a circular finder, which scans perfectly well.
    finders_ok: tuple[bool, bool, bool] = (True, True, True)
    #: Wrong modules in each finder's surrounding ring. Separated from `finders_ok` so
    #: a report can say how close to the edge a design is, not just which side of it,
    #: and so the tolerance can be re-calibrated from a recorded matrix without
    #: re-rendering every case.
    finder_ring_damage: tuple[int, int, int] = (0, 0, 0)
    #: The centre-run check alone, before the ring is taken into account. Kept apart
    #: from `finders_ok` for the same reason: a combined verdict cannot be replayed.
    finder_runs_ok: tuple[bool, bool, bool] = (True, True, True)
    blocks: tuple[BlockDamage, ...] = field(default=())
    #: The model's estimate of the largest logo scale whose data stays recoverable.
    #: Fast, and wrong 4.4% of the time against the calibration matrix -- never
    #: present it as a verified answer. None when there is no logo, or when even the
    #: smallest one does not fix the design.
    estimated_safe_scale: float | None = None
    #: The same question put to a real decoder. None means *not verified*, which is
    #: not the same as unsafe -- it is the absence of an answer, and the export path
    #: treats it as such.
    verified_safe_scale: float | None = None
    logo_scale: float | None = None

    @property
    def worst(self) -> BlockDamage:
        return min(self.blocks, key=lambda b: (b.headroom, b.index))

    @property
    def headroom(self) -> int:
        """Codewords of damage the design could still absorb, in its worst block."""
        return self.worst.headroom if self.blocks else 0

    @property
    def broken_finders(self) -> int:
        return sum(1 for ok in self.finders_ok if not ok)

    @property
    def format_ok(self) -> bool:
        return min(self.format_errors) <= FUNCTION_BCH_CORRECTS

    @property
    def version_ok(self) -> bool:
        return self.version_errors is None or min(self.version_errors) <= FUNCTION_BCH_CORRECTS

    @property
    def intact(self) -> bool:
        # Grid damage is deliberately absent: it is measurably survivable, and a
        # verdict that calls it fatal contradicts the phone in the user's hand.
        return (
            self.contrast_ok
            and self.broken_finders == 0
            and self.format_ok
            and self.version_ok
            and self.headroom >= 0
        )

    @property
    def grade(self) -> str:
        if not self.intact:
            return "fail"
        if self.grid_flips or self.headroom <= THIN_MARGIN:
            return "marginal"
        return "ok"

    @property
    def message(self) -> str:
        if not self.contrast_ok:
            return "Modules and background are too close in tone to tell apart"
        if self.broken_finders:
            n = self.broken_finders
            return (f"{n} of 3 finder patterns no longer reads — "
                    "a scanner cannot locate the code")
        if not self.format_ok:
            return ("Both copies of the format information are damaged — a scanner "
                    "cannot tell which mask or error correction level was used")
        if not self.version_ok:
            return ("Both copies of the version information are damaged — a scanner "
                    "cannot tell how large the symbol is")
        w = self.worst
        if w.headroom < 0:
            over = -w.headroom
            return (f"Data lost: block {w.index} is {over} codeword{'' if over == 1 else 's'} "
                    "past what it can repair")
        if w.headroom <= THIN_MARGIN:
            n = w.headroom
            return (f"Data intact, but block {w.index} has only {n} "
                    f"codeword{'' if n == 1 else 's'} of margin")
        if self.grid_flips:
            n = self.grid_flips
            ranked = sorted(self.grid_kinds.items(), key=lambda kv: (-kv[1], kv[0]))
            names = [KIND_NAMES[k] for k, _ in ranked]
            where = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
            return (f"Data intact — {n} module{'s' if n > 1 else ''} of the {where} "
                    "obscured, which scanners usually tolerate")
        return f"Data intact — {w.headroom} codewords of margin in block {w.index}"

    def as_dict(self) -> dict:
        return {
            "grade": self.grade,
            "message": self.message,
            "intact": self.intact,
            "version": self.version,
            "ecLevel": self.ec_level,
            "contrastOk": self.contrast_ok,
            "contrastSpread": self.contrast_spread,
            "blackPoint": self.black_point,
            "gridFlips": self.grid_flips,
            "gridKinds": dict(self.grid_kinds),
            "formatErrors": list(self.format_errors),
            "formatOk": self.format_ok,
            "versionErrors": list(self.version_errors) if self.version_errors else None,
            "versionOk": self.version_ok,
            "functionBchCorrects": FUNCTION_BCH_CORRECTS,
            "findersOk": list(self.finders_ok),
            "brokenFinders": self.broken_finders,
            "finderRingDamage": list(self.finder_ring_damage),
            "finderRunsOk": list(self.finder_runs_ok),
            "modulesFlipped": self.modules_flipped,
            "headroom": self.headroom,
            "worstBlock": self.worst.index if self.blocks else None,
            "blocks": [
                {"index": b.index, "dataCodewords": b.data_codewords,
                 "ecCodewords": b.ec_codewords, "correctable": b.correctable,
                 "corrupted": b.corrupted, "headroom": b.headroom}
                for b in self.blocks
            ],
            "estimatedSafeScale": self.estimated_safe_scale,
            "verifiedSafeScale": self.verified_safe_scale,
            "logoScale": self.logo_scale,
        }


def luminance(r: int, g: int, b: int) -> int:
    """ITU-R BT.601 luma, in integers so the browser computes the same number."""
    return (299 * r + 587 * g + 114 * b) // 1000


def read_centres(pixel, size: int, quiet_zone: int) -> list[int]:
    """Module-centre luminance from a raster of RASTER_SCALE pixels per module.

    `pixel[x, y]` is an (r, g, b) accessor. Split out from the rastering so the offset
    arithmetic -- the part that silently reports nonsense if it is off by one -- can be
    tested against a synthetic image in both languages.
    """
    off = (RASTER_SCALE - CENTRE) // 2
    out = []
    for r in range(size):
        y0 = (r + quiet_zone) * RASTER_SCALE + off
        for c in range(size):
            x0 = (c + quiet_zone) * RASTER_SCALE + off
            acc = 0
            for y in range(y0, y0 + CENTRE):
                for x in range(x0, x0 + CENTRE):
                    acc += luminance(*pixel[x, y])
            out.append(acc // (CENTRE * CENTRE))
    return out


def sample_modules(svg: str, size: int, quiet_zone: int) -> list[int]:
    """Luminance at the centre of every module of the rendered design, row-major."""
    total = size + 2 * quiet_zone
    data, _ = rasterise(svg, "png", px=total * RASTER_SCALE, matte="#ffffff")
    return read_centres(Image.open(io.BytesIO(data)).convert("RGB").load(), size, quiet_zone)


def estimate_black_point(values: list[int]) -> tuple[int, int]:
    """Threshold between the light and dark module populations, plus their separation.

    zxing's GlobalHistogramBinarizer, run over the module centres rather than the
    whole image: it is the algorithm a real decoder uses to decide what counts as
    dark, so a design it cannot split is one a decoder cannot read. A separation of
    0 is returned when the two peaks are too close to be two peaks.
    """
    buckets = [0] * BUCKETS
    for v in values:
        buckets[v >> 3] += 1

    first = max_count = 0
    for x, n in enumerate(buckets):
        if n > buckets[first]:
            first = x
        max_count = max(max_count, n)

    second, second_score = 0, 0
    for x, n in enumerate(buckets):
        d = x - first
        score = n * d * d
        if score > second_score:
            second, second_score = x, score

    lo, hi = (first, second) if first < second else (second, first)
    if second_score == 0 or hi - lo <= BUCKETS // 16:
        # One population, or two too close to call apart. zxing does not need the
        # first guard -- it histograms a whole photograph, which is never one tone --
        # but a flat swatch of a design is exactly that, and it must not read as a
        # perfect black-and-white split.
        return 128, 0

    # The emptiest bucket between the peaks, biased away from the darker one.
    valley, best = hi - 1, -1
    for x in range(hi - 1, lo, -1):
        from_lo = x - lo
        score = from_lo * from_lo * (hi - x) * (max_count - buckets[x])
        if score > best:
            valley, best = x, score
    return valley << 3, (hi - lo) << 3


def finder_rings(size: int) -> list[set[tuple[int, int]]]:
    """The ring a decoder needs clear around each finder, in-symbol cells only.

    The detection area is 9x9 -- the 7x7 pattern, its one-module separator, and the
    quiet-zone edge beyond that. This is that area *minus* the pattern itself, because
    the pattern is checked by its run profile instead: the renderer restyles those 49
    modules on purpose, and a circular finder that differs from the matrix in 16 of
    them still scans. The ring is the part that simply has to be empty.
    """
    rings = []
    for r0, c0 in finder_boxes(size):
        cr, cc = r0 + 3, c0 + 3
        area = {(r, c) for r in range(cr - 4, cr + 5) for c in range(cc - 4, cc + 5)}
        disc = {(r, c) for r in range(r0, r0 + 7) for c in range(c0, c0 + 7)}
        rings.append({
            (r, c) for r, c in area - disc if 0 <= r < size and 0 <= c < size
        })
    return rings


def binarize(lums: list[int], size: int) -> tuple[list[bool], int, int]:
    """Per-module dark/light, plus the black point and the contrast spread.

    One threshold for the whole symbol, and that is a measured choice rather than a
    simplification. zxing binarises *locally*, so a local model should be the more
    faithful one -- it was tried, in the shape of zxing's HybridBinarizer on the module
    grid, and it did not pay:

        binariser                     false pass    false fail   agreement
        global histogram              33 (1.5%)     65 (2.9%)       95.6%
        local, 8-module blocks        37 (1.7%)     60 (2.7%)       95.6%
        local, 4-module blocks        34 (1.5%)     63 (2.8%)       95.6%

    All three within noise of each other, and the local variants slightly *worse* on
    the metric that matters. So the extra machinery bought nothing, and this stays
    global: simpler, already parity-tested across both languages, and marginally the
    best on false passes. Where the model is actually wrong is elsewhere -- the
    calibration matrix says finder rings, and that is where the work went.
    """
    black, spread = estimate_black_point(lums)
    return [lum < black for lum in lums], black, spread


def finder_profiles(dark: list[bool], size: int) -> tuple[bool, bool, bool]:
    """Whether each finder still scans, by the criterion a decoder actually uses.

    A finder is not read as 49 bits -- it is *found*, by scanning for the 1:1:3:1:1
    run of dark and light through its centre, isolated from whatever is around it.
    Comparing it module for module against the matrix is the wrong test twice over: it
    condemns a circular finder, which preserves the run exactly and scans perfectly
    well, and it misses separator damage, which does not touch the 7x7 at all but
    merges the outer run into its surroundings and stops the scan matching.

    The run is read one module wider than the finder on each side. Outside the symbol
    that module is the quiet zone, taken to be light -- a design whose artwork spills
    past the code edge into it is the one case this does not see.
    """
    def at(r: int, c: int) -> bool:
        if 0 <= r < size and 0 <= c < size:
            return dark[r * size + c]
        return False  # quiet zone

    out = []
    for r0, c0 in finder_boxes(size):
        cr, cc = r0 + 3, c0 + 3
        across = tuple(at(cr, cc + i) for i in range(-4, 5))
        down = tuple(at(cr + i, cc) for i in range(-4, 5))
        out.append(across == FINDER_PROFILE and down == FINDER_PROFILE)
    return tuple(out)  # type: ignore[return-value]


def audit_samples(lums: list[int], matrix: Matrix, ec_level: str) -> Audit:
    """Charge measured module errors to the Reed-Solomon blocks that carry them.

    Pure integer accounting over sampled luminances: no image, no rasteriser. This is
    the half of the measurement that *must* be identical in both languages, and
    test_parity.py holds it to that against a synthetic damage pattern -- the pixels
    two rasterisers produce may differ, but what a flipped module costs may not.
    """
    size = matrix.size
    dark, black, spread = binarize(lums, size)

    ec = ec_level
    plan: BlockPlan = block_plan(matrix.version, ec)
    owners = plan.owners
    codeword_at = module_codewords(matrix.version, ec)
    # Finder discs are excluded: the renderer restyles them on purpose, and their
    # correctness is the profile check below, not a module-by-module diff. Format and
    # version info are excluded too -- they carry their own error correction, and are
    # counted per copy afterwards rather than charged as fatal damage.
    grid = grid_kinds(matrix.version)
    rings = finder_rings(size)
    # Ring cells are the finders' business, not the grid's: a wrong module there stops
    # the corner being found at all, which no amount of "usually tolerated" covers.
    ring_cells = set().union(*rings)

    grid_flips = 0
    kind_counts: dict[str, int] = {}
    flipped = 0
    hit: set[int] = set()
    for r in range(size):
        for c in range(size):
            if dark[r * size + c] == matrix.get(r, c):
                continue
            flipped += 1
            kind = None if (r, c) in ring_cells else grid.get((r, c))
            if kind is not None:
                grid_flips += 1
                kind_counts[kind] = kind_counts.get(kind, 0) + 1
            else:
                cw = codeword_at.get((r, c))
                if cw is not None:  # remainder and finder modules carry nothing
                    hit.add(cw)

    corrupted = [0] * len(plan.blocks)
    for cw in hit:
        corrupted[owners[cw]] += 1

    def wrong(cells) -> int:
        return sum(1 for r, c in cells if dark[r * size + c] != matrix.get(r, c))

    fmt_a, fmt_b = format_info_copies(matrix.version)
    ver = version_info_copies(matrix.version)

    ring_damage = tuple(wrong(ring) for ring in rings)
    runs_ok = finder_profiles(dark, size)
    finders_ok = tuple(
        ok and damage <= FINDER_RING_TOLERANCE
        for ok, damage in zip(runs_ok, ring_damage)
    )

    return Audit(
        version=matrix.version,
        ec_level=ec,
        contrast_ok=spread > 0,
        black_point=black,
        contrast_spread=spread,
        grid_flips=grid_flips,
        modules_flipped=flipped,
        grid_kinds=kind_counts,
        format_errors=(wrong(fmt_a), wrong(fmt_b)),
        version_errors=(wrong(ver[0]), wrong(ver[1])) if ver else None,
        finders_ok=finders_ok,  # type: ignore[arg-type]
        finder_ring_damage=ring_damage,  # type: ignore[arg-type]
        finder_runs_ok=runs_ok,
        blocks=tuple(
            BlockDamage(b.index, b.data_codewords, b.ec_codewords, b.correctable, corrupted[b.index])
            for b in plan.blocks
        ),
    )


def audit_svg(svg: str, spec: QRSpec, matrix: Matrix) -> Audit:
    """Audit a design that has already been drawn. Costs one raster."""
    lums = sample_modules(svg, matrix.size, spec.canvas.quiet_zone)
    return replace(
        audit_samples(lums, matrix, spec.content.ec_level),
        logo_scale=spec.logo.scale if spec.logo else None,
    )


#: Binary-search steps for the heuristic bracket. Each one costs a raster, and seven
#: of them resolve the answer to under a percent -- finer than the number is reported.
SEARCH_STEPS = 7
#: Below this a logo is a speck; if the data is still lost there, size is not the problem.
MIN_SCALE = 0.02

#: Step the decoder confirmation walks in. Coarser than the heuristic's resolution on
#: purpose: every step is a render and a decode, and the answer is reported as a
#: percentage anyway.
CONFIRM_STEP = 0.02
#: Scales below the answer that must also decode before it is offered. Decoder
#: PASS/FAIL is *not* monotone in logo size -- measured over 192 series, 2 of them read
#: again above a size that failed -- so "largest size that works" is not a safe promise
#: on its own. "Largest size below which nothing fails" is, and this is what buys it.
CONFIRM_GUARD = 3
#: Steps above the heuristic's answer worth trying. The heuristic is slightly
#: pessimistic at the Reed-Solomon cliff, and recovering that costs two decodes.
CONFIRM_PROBE_UP = 2
#: Ceiling on oracle calls, so confirmation cannot run away on a pathological design.
CONFIRM_BUDGET = 22


def _scaled(spec: QRSpec, scale: float) -> QRSpec:
    """The same design at a different logo size, with derived work cleared."""
    probe = spec.model_copy(deep=True)
    # The browser's art-mode sampling belongs to the scale it was taken at.
    probe.art.cells = None
    probe.logo.scale = scale  # type: ignore[union-attr]
    return probe


def heuristic_max_scale(
    spec: QRSpec,
    matrix: Matrix | None = None,
    *,
    currently_intact: bool | None = None,
    steps: int = SEARCH_STEPS,
) -> float | None:
    """The model's answer: largest logo scale whose data the audit believes recoverable.

    Bisection is valid here because the audit *is* monotone in scale -- measured over
    192 series of the calibration matrix, 192 of them monotone. Fast enough to run on
    every edit, and wrong often enough that it is a candidate rather than a verdict:
    against the committed decoder matrix it produces false passes, which is why
    `verified_max_scale` exists so this number is never handed out unconfirmed.
    """
    if spec.logo is None:
        return None
    matrix = matrix or matrix_for(spec)
    here = spec.logo.scale

    def intact_at(scale: float) -> bool:
        probe = _scaled(spec, scale)
        return audit_svg(build_svg(probe), probe, matrix).intact

    ok = intact_at(here) if currently_intact is None else currently_intact
    if ok:
        if intact_at(1.0):
            return 1.0  # nothing about the size binds
        lo, hi = here, 1.0
    else:
        if not intact_at(MIN_SCALE):
            return None  # contrast or colour, not size
        lo, hi = MIN_SCALE, here

    for _ in range(steps):
        mid = (lo + hi) / 2
        if intact_at(mid):
            lo = mid
        else:
            hi = mid
    return round(lo, 3)


@dataclass(frozen=True)
class Verification:
    """What a decoder was able to confirm about a design's logo size."""

    #: Largest scale below which nothing fails, or None when there is no such size.
    scale: float | None
    #: Whether *any* probed size read at all. The two Nones are different problems: a
    #: design nothing reads is broken, while a design that reads at some sizes and not
    #: at others is sitting on the decoder's threshold -- which is worth refusing, and
    #: worth refusing for the right stated reason.
    reads_somewhere: bool = False

    @property
    def unstable(self) -> bool:
        return self.scale is None and self.reads_somewhere


def verified_max_scale(
    spec: QRSpec,
    oracle: "Callable[[QRSpec], bool]",
    matrix: Matrix | None = None,
    *,
    candidate: float | None = None,
    currently_intact: bool | None = None,
    steps: int = SEARCH_STEPS,
    step: float = CONFIRM_STEP,
    guard: int = CONFIRM_GUARD,
    probe_up: int = CONFIRM_PROBE_UP,
    budget: int = CONFIRM_BUDGET,
) -> Verification:
    """Largest logo scale a real decoder confirms, or None if it cannot confirm one.

    The model only proposes: `heuristic_max_scale` finds the bracket cheaply, and the
    oracle decides. Nothing is returned that has not itself been rendered under the
    production profile and read back.

    The contract is deliberately stronger than "the largest size that reads". Decoder
    PASS/FAIL is not monotone in logo size -- measured over 192 series, 2 of them read
    again above a size that failed -- so the top of an isolated island of success would
    be a trap: a user told "safe up to 35%" will reasonably assume 30% is safe too. So
    the answer is the largest size *below which nothing fails*, checked at `guard`
    sampled points underneath it.

    A `scale` of None means unverified, not unsafe. The caller has to decide what to do
    with the absence of an answer; silently substituting the estimate is not one of the
    options. `reads_somewhere` separates the two ways of arriving there.
    """
    if candidate is None:
        candidate = heuristic_max_scale(
            spec, matrix, currently_intact=currently_intact, steps=steps
        )
    if candidate is None or spec.logo is None:
        return Verification(None)

    seen: dict[float, bool] = {}
    calls = 0

    def reads(scale: float) -> bool:
        nonlocal calls
        key = round(scale, 4)
        if key not in seen:
            if calls >= budget:
                return False  # out of budget: refuse rather than guess
            calls += 1
            seen[key] = oracle(_scaled(spec, key))
        return seen[key]

    def anywhere() -> bool:
        return any(seen.values())

    def safe_below(scale: float) -> bool:
        """Nothing between MIN_SCALE and `scale` may fail, or the number is a trap."""
        span = scale - MIN_SCALE
        if span <= 0:
            return True
        return all(
            reads(MIN_SCALE + span * (i + 1) / (guard + 1)) for i in range(guard)
        )

    # The heuristic is a little pessimistic at the Reed-Solomon cliff, so look up a
    # couple of steps before walking down.
    start = min(1.0, candidate + probe_up * step)
    scale = start
    while scale >= MIN_SCALE and calls < budget:
        if reads(scale) and safe_below(scale):
            return Verification(round(scale, 3), True)
        scale = round(scale - step, 4)

    # Nothing satisfied "reads here, and at every sampled size below". If some sizes
    # read anyway, the design is not dead -- it is balanced on the decoder's threshold,
    # reading at one size and failing a smaller one. Measured on the calibration
    # matrix, that is what most of these are, and it is not a size to hand anybody.
    return Verification(None, anywhere())


def audit(
    spec: QRSpec,
    *,
    with_max_scale: bool = True,
    oracle: "Callable[[QRSpec], bool] | None" = None,
) -> Audit:
    """The full data-integrity report for a design.

    Two answers to the size question, never conflated. `estimated_safe_scale` is the
    model's, and is what a live preview can afford. `verified_safe_scale` is a real
    decoder's, and is what anything the user is about to print has to use; it stays
    None unless an `oracle` is supplied.
    """
    matrix = matrix_for(spec)
    report = audit_svg(build_svg(spec), spec, matrix)
    if not with_max_scale or spec.logo is None:
        return report

    estimated = heuristic_max_scale(spec, matrix, currently_intact=report.intact)
    verified = (
        verified_max_scale(spec, oracle, matrix, candidate=estimated).scale
        if oracle is not None
        else None
    )
    return replace(report, estimated_safe_scale=estimated, verified_safe_scale=verified)
