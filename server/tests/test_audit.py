"""The data-integrity audit has to be exactly right, so it is checked three ways.

The block table against python-qrcode's own copy; the codeword placement walk by
reading a real payload back out of a real matrix; and the audit itself against the
decoder, on designs built to sit either side of the line.

The first two are what make the report a *measurement* rather than a heuristic: if
either were wrong the numbers would still look plausible, which is precisely the
failure mode the old "logo covers 31%" warning had.
"""
import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qrcode.base import rs_blocks  # noqa: E402
from qrcode.constants import (  # noqa: E402
    ERROR_CORRECT_H,
    ERROR_CORRECT_L,
    ERROR_CORRECT_M,
    ERROR_CORRECT_Q,
)

from inscode.audit import (  # noqa: E402
    RASTER_SCALE,
    audit,
    audit_samples,
    audit_svg,
    estimate_black_point,
    heuristic_max_scale,
    read_centres,
)
from inscode.blocks import (  # noqa: E402
    EC_LEVELS,
    block_plan,
    data_modules,
    module_codewords,
    placement_order,
)
from inscode.encode import encode, matrix_for, matrix_from_encoded  # noqa: E402
from inscode.geometry import (  # noqa: E402
    FUNCTION_BCH_CORRECTS,
    GRID_KINDS,
    dark_module,
    format_info_copies,
    reserved_cells,
    structural_cells,
    symbol_size,
    grid_kinds,
    version_info_copies,
)
from inscode.render import build_svg  # noqa: E402
from inscode.spec import FINDER_SHAPES, MODULE_SHAPES, QRSpec  # noqa: E402

LIB_EC = {"L": ERROR_CORRECT_L, "M": ERROR_CORRECT_M, "Q": ERROR_CORRECT_Q, "H": ERROR_CORRECT_H}
#: The payload every test in this file encodes. One place, so a rebrand is one edit.
TEXT = "https://insdash.ch"

LOGO = "data:image/png;base64," + base64.b64encode(
    (Path(__file__).resolve().parents[2] / "assets" / "test-logo.png").read_bytes()
).decode()

#: Byte mode only: an alphanumeric payload packs 2 characters into 11 bits, which the
#: little reader below deliberately does not implement -- it is testing the placement
#: walk, not segment decoding.
PAYLOADS = ["https://insdash.ch", "hello world", "x" * 120, "a/b?c=d&e=f", "z" * 700]

MASKS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
    lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
]


def spec_with(scale: float, **logo) -> QRSpec:
    return QRSpec.model_validate(
        {"content": {"text": TEXT}, "logo": {"src": LOGO, "scale": scale, **logo}}
    )


def damaging(cells, text: str = TEXT) -> QRSpec:
    """A design identical to the plain code except that `cells` read inverted.

    Every module is flipped deliberately rather than covered, so a test can name the
    exact set of modules it is asking about -- no logo geometry, no guessing which of
    them a plate happened to reach.
    """
    import io as _io

    from PIL import Image

    matrix = matrix_for(QRSpec.model_validate({"content": {"text": text}}))
    scale = 12
    overlay = Image.new("RGBA", (matrix.size * scale,) * 2, (0, 0, 0, 0))
    px = overlay.load()
    for r, c in cells:
        fill = (255, 255, 255, 255) if matrix.get(r, c) else (0, 0, 0, 255)
        for y in range(r * scale, (r + 1) * scale):
            for x in range(c * scale, (c + 1) * scale):
                px[x, y] = fill
    buf = _io.BytesIO()
    overlay.save(buf, "PNG")
    return QRSpec.model_validate({
        "content": {"text": text},
        "logo": {
            "src": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
            "scale": 1.0,
            "plate": {"enabled": False},
        },
    })


def decodes(spec: QRSpec, text: str = TEXT, px: int = 900) -> bool:
    """Does zxing read it? The arbiter for anything the audit calls survivable."""
    import io as _io

    import zxingcpp
    from PIL import Image

    from inscode.raster import render as rasterise

    data, _ = rasterise(build_svg(spec), "png", px=px, matte="#ffffff")
    img = Image.open(_io.BytesIO(data)).convert("RGB")
    return any(r.text == text for r in zxingcpp.read_barcodes(img))


# --------------------------------------------------------------------------- table


@pytest.mark.parametrize("version", range(1, 41))
def test_block_table_matches_python_qrcode(version):
    """Our copy of ISO Table 9 against the one inside python-qrcode.

    Neither library exposes this as public API, so the table is embedded in
    blocks.py (and again in blocks.ts). This is the pin that keeps it honest.
    """
    for level in EC_LEVELS:
        theirs = rs_blocks(version, LIB_EC[level])
        ours = block_plan(version, level).blocks
        assert [(b.total_count, b.data_count) for b in theirs] == [
            (b.data_codewords + b.ec_codewords, b.data_codewords) for b in ours
        ], f"v{version} {level}"


@pytest.mark.parametrize("version", range(1, 41))
def test_codeword_budget_comes_out_of_the_geometry(version):
    """Total codewords and remainder bits are not a second table -- they fall out of
    `reserved_cells`, which the TypeScript geometry test already pins for all 40
    versions. One source of truth for which modules carry data."""
    available = data_modules(version)
    for level in EC_LEVELS:
        plan = block_plan(version, level)
        assert plan.total_codewords * 8 + plan.remainder_bits == available
        assert plan.total_codewords == sum(
            b.data_codewords + b.ec_codewords for b in plan.blocks
        )
        assert len(plan.owners) == plan.total_codewords


def test_remainder_bits_match_the_standard():
    """ISO/IEC 18004 Table 1's remainder-bit column, derived rather than transcribed."""
    expected = {1: 0, 2: 7, 7: 0, 14: 3, 21: 4, 28: 3, 35: 0, 40: 0}
    for version, bits in expected.items():
        assert block_plan(version, "H").remainder_bits == bits, f"v{version}"


# ----------------------------------------------------------------------- placement


@pytest.mark.parametrize("version", range(1, 41))
def test_placement_covers_every_data_module_once(version):
    order = placement_order(version)
    assert len(order) == data_modules(version)
    assert len(set(order)) == len(order), "a module was written twice"
    assert not (set(order) & reserved_cells(version)), "the walk stepped on a function pattern"


@pytest.mark.parametrize("version", range(1, 41))
def test_module_codewords_skips_the_remainder(version):
    plan = block_plan(version, "H")
    assert len(module_codewords(version, "H")) == plan.total_codewords * 8


@pytest.mark.parametrize("text", PAYLOADS)
@pytest.mark.parametrize("level", EC_LEVELS)
def test_payload_reads_back_out_of_a_real_matrix(text, level):
    """The proof that the walk, the interleaving and the block sizes are all right.

    Read the modules in placement order, undo the mask, de-interleave into blocks,
    concatenate the blocks' data codewords and parse the byte-mode header. If any of
    those three were wrong the payload would come back as noise -- as it does if you
    perturb the walk by a single column.
    """
    enc = encode(text, level)
    matrix = matrix_from_encoded(enc)
    plan = block_plan(enc.version, level)
    masked = MASKS[enc.mask_pattern]

    bits = "".join(
        "1" if (matrix.get(r, c) != masked(r, c)) else "0"
        for r, c in placement_order(enc.version)
    )
    codewords = [int(bits[i * 8:i * 8 + 8], 2) for i in range(plan.total_codewords)]

    per_block: dict[int, list[int]] = {b.index: [] for b in plan.blocks}
    for i in range(sum(b.data_codewords for b in plan.blocks)):
        per_block[plan.owners[i]].append(codewords[i])
    message = "".join(f"{x:08b}" for b in plan.blocks for x in per_block[b.index])

    assert message[:4] == "0100", "expected byte mode"
    count_bits = 8 if enc.version <= 9 else 16
    length = int(message[4:4 + count_bits], 2)
    body = message[4 + count_bits:]
    decoded = bytes(int(body[i * 8:i * 8 + 8], 2) for i in range(length))
    assert decoded.decode("utf-8") == text


# --------------------------------------------------------------------------- audit


def test_read_centres_reads_centres_and_ignores_edges():
    """The offset arithmetic, pinned against a synthetic raster.

    Off by one here and the audit reports confident numbers about the wrong modules,
    which is the one failure mode that would not announce itself. The TypeScript side
    runs the same test in audit.test.ts, where it matters more still -- everything
    above that function needs a browser and cannot be tested at all.
    """
    size, quiet_zone = 21, 4

    class Raster:
        """Every module's middle third carries its value; the ring around it carries
        the opposite, which is what a module edge looks like once antialiased. The
        quiet zone is garbage throughout."""

        def __getitem__(self, xy):
            x, y = xy
            c, x_in = divmod(x, RASTER_SCALE)
            r, y_in = divmod(y, RASTER_SCALE)
            r, c = r - quiet_zone, c - quiet_zone
            if not (0 <= r < size and 0 <= c < size):
                return (255, 255, 255)
            grey = (r * size + c) % 200
            centre = 3 <= x_in < 6 and 3 <= y_in < 6
            v = grey if centre else 255 - grey
            return (v, v, v)

    wanted = [(r * size + c) % 200 for r in range(size) for c in range(size)]
    assert read_centres(Raster(), size, quiet_zone) == wanted


def test_a_plain_code_is_undamaged():
    spec = QRSpec.model_validate({"content": {"text": TEXT}})
    report = audit(spec)
    assert report.modules_flipped == 0
    assert report.grade == "ok"
    assert report.headroom == report.blocks[0].correctable


def test_low_contrast_is_reported_as_contrast_not_as_size():
    """The failure the old message could not name. Nothing is covered here, so a
    coverage percentage sees a perfect code; the histogram cannot split it."""
    spec = QRSpec.model_validate(
        {"content": {"text": TEXT}, "modules": {"color": "#f2f2f2"}}
    )
    report = audit(spec, with_max_scale=False)
    assert not report.contrast_ok
    assert report.contrast_spread == 0
    assert "tone" in report.message


def test_flat_image_has_no_black_point():
    assert estimate_black_point([200] * 500) == (128, 0)
    assert estimate_black_point([0] * 250 + [255] * 250)[1] > 0


@pytest.mark.parametrize("module_shape", MODULE_SHAPES)
@pytest.mark.parametrize("finder_shape", FINDER_SHAPES)
def test_every_style_the_tool_offers_audits_clean(module_shape, finder_shape):
    """No style is damage. This is the regression that made the criterion right.

    Judging the finder patterns module-by-module against the matrix condemned the
    circular finder -- 48 "obscured" modules on a code with no logo on it at all --
    because a circle does not fill the corners of the 7x7 square. But a decoder never
    reads those 49 modules as bits: it *locates* the finder by the 1:1:3:1:1 run
    through its centre, which a circle preserves exactly. Which is why the style
    scans, and why `finder_profiles` is the test rather than a diff.
    """
    spec = QRSpec.model_validate({
        "content": {"text": TEXT},
        "modules": {"shape": module_shape},
        "finders": {"shape": finder_shape},
    })
    report = audit(spec, with_max_scale=False)
    assert report.finders_ok == (True, True, True)
    assert report.grid_flips == 0
    assert report.grade == "ok", report.message


def test_a_logo_on_a_finder_breaks_the_pattern_a_scanner_looks_for():
    """Area says this logo is small, and it spends almost none of the block budget.
    It is still fatal: the top-left finder no longer reads as 1:1:3:1:1, so there is
    nothing for a scanner to lock onto."""
    spec = spec_with(0.2, x=0.12, y=0.12)
    report = audit(spec, with_max_scale=False)
    assert report.finders_ok[0] is False
    assert report.broken_finders == 1
    assert not report.intact
    assert "locate" in report.message


def test_a_circular_finder_still_has_the_profile():
    """The positive half of the same point, at the level of the check itself."""
    from inscode.audit import binarize, finder_profiles, sample_modules

    spec = QRSpec.model_validate({
        "content": {"text": TEXT}, "finders": {"shape": "circle"},
    })
    matrix = matrix_for(spec)
    lums = sample_modules(build_svg(spec), matrix.size, spec.canvas.quiet_zone)
    dark, _, _ = binarize(lums, matrix.size)
    assert finder_profiles(dark, matrix.size) == (True, True, True)


def test_grid_damage_is_a_caution_not_a_death_sentence():
    """The report that started this: "11 modules obscured in the timing pattern -- no
    error correction protects those" on a code an iPhone reads without complaint.

    Nothing does correct them. But nothing much reads them either: a decoder derives
    the module size and the symbol dimension from the three finder patterns, so the
    timing and alignment patterns are close to decorative on a flat, undistorted image.
    Measured against zxing, destroying every one of them still decodes -- so this is a
    caution, and the payload verdict stands.
    """
    from inscode.audit import finder_rings
    from inscode.geometry import alignment_cells, grid_kinds

    matrix = matrix_for(QRSpec.model_validate({"content": {"text": TEXT}}))
    kinds = grid_kinds(matrix.version)
    # Clear of the finder rings: `grid_kinds` labels (6,7) and its mirrors "timing"
    # because they sit on row or column 6, but they are separator modules and the
    # finder check owns them. This test is about the grid proper.
    ruin = sorted(
        (set(k for k, v in kinds.items() if v == "timing") | alignment_cells(matrix.version))
        - set().union(*finder_rings(matrix.size))
    )
    spec = damaging(ruin)
    report = audit(spec, with_max_scale=False)

    assert report.grid_flips == len(ruin) > 50, "the whole grid should be wrecked"
    assert report.broken_finders == 0, "and the corners left alone"
    assert report.intact, "the payload is untouched, so the data is still recoverable"
    assert report.grade == "marginal", "worth saying, not worth failing over"
    assert "usually tolerate" in report.message
    assert decodes(spec), "zxing is the arbiter here, and it reads this fine"


def test_separator_damage_is_finder_damage():
    """Where the line actually falls. Twelve wrong separator modules do not touch the
    7x7 at all, and they kill the code -- a dark module against the outer ring merges
    the runs and the ratio scan stops matching. Caught by the widened finder profile
    rather than by counting grid flips, which is why the profile reads nine modules."""
    from inscode.geometry import grid_kinds

    matrix = matrix_for(QRSpec.model_validate({"content": {"text": TEXT}}))
    seps = sorted(k for k, v in grid_kinds(matrix.version).items() if v == "separator")[:12]
    spec = damaging(seps)
    report = audit(spec, with_max_scale=False)

    assert report.broken_finders > 0, "the finders are unfindable, though untouched"
    assert not report.intact and "locate" in report.message
    assert not decodes(spec)


def test_damage_is_charged_per_block_and_the_worst_one_binds():
    """Interleaving spreads a contiguous logo over every block, but not evenly -- which
    is the whole reason the report is per block rather than a percentage.

    The mechanism is asserted at every size; the unevenness only has to show up
    somewhere, because whether a given size splits the blocks 8/7 or 8/8 depends on
    the payload's own bits.
    """
    uneven = False
    for scale in [round(0.20 + 0.02 * i, 2) for i in range(11)]:
        report = audit(spec_with(scale), with_max_scale=False)
        corrupted = [b.corrupted for b in report.blocks]
        assert report.headroom == min(
            b.correctable - b.corrupted for b in report.blocks
        ), f"the worst block must bind, at scale {scale}"
        uneven = uneven or len(set(corrupted)) > 1

    assert sum(corrupted) > 0, "the largest logo should damage something"
    assert uneven, "a centred logo should hit the blocks unevenly at some size"


def test_the_estimated_scale_is_the_edge_of_the_models_cliff():
    """Either side of the returned scale the verdict must flip. This is the number
    the UI offers as a fix, so being off by a hair either way is a real bug."""
    spec = spec_with(0.5)
    edge = heuristic_max_scale(spec)
    assert edge is not None and 0.1 < edge < 0.9

    matrix = matrix_for(spec)
    for scale, want in ((edge, True), (edge + 0.02, False)):
        probe = spec.model_copy(deep=True)
        probe.logo.scale = scale
        assert audit_svg(build_svg(probe), probe, matrix).intact is want, f"at {scale}"


def test_no_logo_has_no_scale_to_report():
    spec = QRSpec.model_validate({"content": {"text": TEXT}})
    assert audit(spec).estimated_safe_scale is None
    assert audit(spec).verified_safe_scale is None
    assert heuristic_max_scale(spec) is None


def test_the_audit_agrees_with_the_decoder_about_where_the_line_is():
    """Cross-validation against zxing. The audit answers a narrower question than the
    decoder -- data recoverable, not "a scanner resolved it at 400px" -- so the two
    are only required to agree on the intact side: anything the audit calls intact
    must decode when rendered large and clean."""
    import io

    import zxingcpp
    from PIL import Image

    from inscode.raster import render as rasterise

    text = TEXT
    for scale in (0.15, 0.25, 0.30, 0.35, 0.45, 0.6):
        spec = spec_with(scale)
        report = audit(spec, with_max_scale=False)
        if not report.intact:
            continue
        data, _ = rasterise(build_svg(spec), "png", px=900, matte="#ffffff")
        img = Image.open(io.BytesIO(data)).convert("RGB")
        assert any(r.text == text for r in zxingcpp.read_barcodes(img)), (
            f"audit called scale {scale} intact but zxing could not read it"
        )


# ------------------------------------------------------------------- what was hit


@pytest.mark.parametrize("version", range(1, 41))
def test_the_function_patterns_partition_by_what_protects_them(version):
    """Three different things, and calling them one thing is what produced "14 modules
    obscured in the format information -- no error correction protects those" on a
    design that was in fact perfectly readable:

      * finder discs, *found* by their ratio rather than read (see finder_profiles);
      * format and version information, each a BCH codeword written twice;
      * timing, alignment and separators, read once with nothing behind them.

    Only the third kind is fatal per module. This is that partition, checked to be
    exact and non-overlapping.
    """
    fmt_a, fmt_b = format_info_copies(version)
    ver = version_info_copies(version)
    parts = [fmt_a, fmt_b, {dark_module(version)}, set(grid_kinds(version))]
    if ver:
        parts += list(ver)

    union = set().union(*parts)
    assert sum(len(p) for p in parts) == len(union), "the parts overlap"
    assert union == structural_cells(version)
    assert set(grid_kinds(version).values()) <= set(GRID_KINDS)


@pytest.mark.parametrize("version", range(1, 41))
def test_format_and_version_information_are_the_right_size(version):
    assert [len(c) for c in format_info_copies(version)] == [15, 15]
    ver = version_info_copies(version)
    assert ver is None if version < 7 else [len(c) for c in ver] == [18, 18]


def test_format_information_is_error_corrected_and_written_twice():
    """The bug this replaced: damage here was reported as fatal, on designs that read
    perfectly well. Each copy is a BCH(15,5) codeword good for three wrong bits, and a
    decoder takes whichever copy comes back cleaner -- so it takes damage to *both* to
    matter, and even then only past the budget.

    Which logo happens to land on the format strips is a property of one symbol's
    bits *and* of the artwork, so the size is searched for rather than pinned:
    hardcoding one meant this stopped testing anything the first time the payload
    changed. The sweep runs well past where any of them land -- a solid mark reaches
    the strips around 0.46 and a hollow one not until 0.52, because a ring puts its
    ink on the perimeter and has to be wider before it covers the same cells.
    """
    for scale in [round(0.20 + 0.02 * i, 2) for i in range(26)]:
        spec = QRSpec.model_validate({
            "content": {"text": TEXT, "ecLevel": "L"},
            "logo": {"src": LOGO, "scale": scale},
        })
        report = audit(spec, with_max_scale=False)
        if report.format_errors[0] > 0:
            break
    else:
        pytest.fail("no logo size reached the format information on this payload")

    assert report.format_ok, "within the BCH budget in at least one copy"
    assert "format information" not in report.message


def test_the_message_names_the_grid_pattern_that_was_hit():
    """Which one it is changes what to do: the timing patterns are at row and column
    6, the alignment patterns are wherever the version puts them. Damage only the
    alignment pattern, and that is what the report should say -- a design that is also
    over its block budget has a bigger problem and is told about that instead."""
    from inscode.geometry import alignment_cells

    report = audit(damaging(alignment_cells(3)), with_max_scale=False)
    assert set(report.grid_kinds) == {"alignment"}
    assert "alignment pattern" in report.message
    assert "timing" not in report.message


def test_error_correction_level_does_not_protect_the_function_patterns():
    """The question this answers: "is that normal with EC level M?"

    Yes, and raising the level does not fix it *as error correction* -- timing,
    alignment and format modules are read before any repair happens, at every level.
    What a higher level does is spend more codewords, which pushes the payload into a
    larger symbol, and a larger symbol moves the structure further from a centred
    logo. Same damage, more room. So the counts here are identical across levels and
    only the block budgets move.
    """
    size = 29  # version 3

    class Synthetic:
        version, size = 3, 29

        def get(self, r, c):
            return (r * 7 + c * 13) % 3 == 0

    m = Synthetic()
    lums = [
        0 if m.get(r, c) != ((r * 31 + c) % 11 == 0) else 255
        for r in range(size)
        for c in range(size)
    ]
    reports = {level: audit_samples(lums, m, level) for level in EC_LEVELS}

    assert len({r.grid_flips for r in reports.values()}) == 1
    assert len({tuple(sorted(r.grid_kinds.items())) for r in reports.values()}) == 1
    assert len({r.finders_ok for r in reports.values()}) == 1
    assert len({r.format_errors for r in reports.values()}) == 1
    # Only the budget moves. Note it has to be totalled to be monotonic: a higher
    # level buys more blocks as well as more codewords, so version 3 goes 7, 13, 18,
    # 22 correctable in total while the *per-block* figure goes 7, 13, 9, 11. Which is
    # the whole reason this report is per block and not a percentage.
    total = {
        level: sum(b.correctable for b in reports[level].blocks) for level in EC_LEVELS
    }
    assert total["L"] < total["M"] < total["Q"] < total["H"], total
    assert [reports[level].blocks[0].correctable for level in EC_LEVELS] == [7, 13, 9, 11]


# ------------------------------------------------------------------ intended size


def test_the_verdict_is_given_at_the_size_being_produced():
    """A design can be perfect and still too small to read, which a report that only
    answers in the abstract will happily call fine."""
    from inscode.validate import report as full_report

    spec = spec_with(0.30)
    good = full_report(spec, {"kind": "print", "mm": 40})
    tiny = full_report(spec, {"kind": "print", "mm": 14})

    assert good["integrity"]["intact"] and tiny["integrity"]["intact"], "same design"
    assert good["fit"]["ok"] and good["grade"] == "ok"
    assert not tiny["fit"]["ok"] and tiny["grade"] == "fail"
    assert "0.5 mm floor" in tiny["fit"]["message"]


def test_a_screen_size_below_the_sampling_floor_is_not_measured():
    """The trap this exists to avoid: resvg draws perfect geometry and zxing recovers
    a code at 1.7 px/module from it, so *measuring* down there returns a reassuring
    pass about something no camera can read. The floor is checked instead."""
    from inscode.validate import MIN_PX_PER_MODULE, report as full_report

    spec = spec_with(0.30)
    r = full_report(spec, {"kind": "screen", "px": 64})
    assert r["fit"]["pitch"] < MIN_PX_PER_MODULE
    assert not r["fit"]["ok"]
    assert r["optical"]["atYourSize"] is None, "nothing below the floor should be swept"
    assert full_report(spec, {"kind": "screen", "px": 512})["fit"]["ok"]


def test_format_information_can_kill_a_code_whose_data_is_perfect():
    """What "both copies of the format information are damaged" actually means.

    Those 15 bits say which mask was XORed over the symbol and which error correction
    level it uses. A decoder reads them *before* it can unmask anything, so losing them
    is fatal no matter how healthy everything else is -- and the point of reporting it
    apart from the block budget is that it is a different failure with a different fix.

    Damaging only the row-8 halves of both copies leaves the finders, the grid and
    every data module untouched. Reed-Solomon has its full budget, and the code is
    still unreadable.
    """
    from inscode.geometry import format_info_copies

    matrix = matrix_for(QRSpec.model_validate({"content": {"text": TEXT}}))
    a_copy, b_copy = format_info_copies(matrix.version)
    spec = damaging([(r, c) for r, c in a_copy | b_copy if r == 8])
    report = audit(spec, with_max_scale=False)

    assert report.finders_ok == (True, True, True), "the finders were not touched"
    assert report.grid_flips == 0, "the grid was not touched"
    assert report.headroom == report.blocks[0].correctable, "not one data module was touched"
    assert report.format_errors == (8, 8), "both copies past the 3-bit BCH budget"
    assert not report.format_ok and not report.intact
    assert "format information" in report.message
    assert not decodes(spec), "perfect data, perfect grid, unreadable code"
