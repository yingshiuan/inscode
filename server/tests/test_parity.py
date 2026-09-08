"""The TypeScript and Python renderers must agree.

The browser renders the live preview and instant exports; the API renders
authoritative output and batches. Two renderers means they can drift, so this
holds them to the same fixtures: identical SVG, identical encode decisions, and a
raster that still decodes to the right payload at print-small sizes.

Regenerate the TypeScript side with:
    cd web && npx vite-node scripts/render-fixtures.ts
"""
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inscode.encode import encode, matrix_from_encoded  # noqa: E402
from inscode.spec import Encoded, QRSpec  # noqa: E402
from inscode.svg import render_svg  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
TS = FIXTURES / "ts"
NAMES = sorted(p.stem for p in FIXTURES.glob("*.json"))


def load(name: str) -> QRSpec:
    return QRSpec.model_validate(json.loads((FIXTURES / f"{name}.json").read_text()))


def ts_encoded(name: str) -> Encoded:
    return Encoded.model_validate(json.loads((TS / f"{name}.encoded.json").read_text()))


def render(name: str) -> str:
    """Render from the encode result the browser shipped -- the hybrid path."""
    spec = load(name)
    spec.encoded = ts_encoded(name)
    return render_svg(spec, matrix_from_encoded(spec.encoded), logo_aspect=1.0)


@pytest.mark.parametrize("name", NAMES)
def test_svg_matches_typescript(name):
    """Byte-identical SVG. Anything else means the two renderers have diverged."""
    expected = (TS / f"{name}.svg").read_text()
    actual = render(name)
    if actual != expected:
        for i, (a, b) in enumerate(zip(actual, expected)):
            if a != b:
                lo = max(0, i - 60)
                pytest.fail(
                    f"{name}: diverges at char {i}\n"
                    f"  python: …{actual[lo:i + 60]}\n"
                    f"  ts    : …{expected[lo:i + 60]}"
                )
        pytest.fail(f"{name}: length differs — python {len(actual)}, ts {len(expected)}")


@pytest.mark.parametrize("name", NAMES)
def test_python_encode_is_deterministic(name):
    """Pinning the mask makes Python's own encode reproducible."""
    spec = load(name)
    a = encode(spec.content.text, spec.content.ec_level)
    b = encode(spec.content.text, spec.content.ec_level, mask_pattern=a.mask_pattern)
    assert (b.version, b.mask_pattern, b.size, b.bits) == (a.version, a.mask_pattern, a.size, a.bits)


def test_cross_library_encode_can_differ(capsys):
    """Why `QRSpec.encoded` carries the full matrix and not just version + mask.

    node-qrcode and python-qrcode disagree in two independent ways:

      * mask selection -- each runs its own penalty scoring;
      * segmentation -- each splits a payload into byte/alphanumeric/numeric runs
        differently, which changes the data bitstream even at the same version and
        mask.

    Both produce valid, scannable codes. They just look different, and in a design
    tool the preview must match the export exactly. The second difference is the
    reason pinning the mask alone is not enough and `encoded.bits` is authoritative.
    """
    mask_only, bit_level = [], []
    for name in NAMES:
        spec = load(name)
        ts = ts_encoded(name)
        auto = encode(spec.content.text, spec.content.ec_level)
        if (auto.version, auto.mask_pattern) != (ts.version, ts.mask_pattern):
            mask_only.append(f"{name}: python v{auto.version}/m{auto.mask_pattern}"
                             f" vs ts v{ts.version}/m{ts.mask_pattern}")
        pinned = encode(spec.content.text, spec.content.ec_level, mask_pattern=ts.mask_pattern)
        if pinned.bits != ts.bits:
            bit_level.append(name)

    with capsys.disabled():
        print("\n  cross-library encode differences (expected; neutralised by spec.encoded.bits)")
        print(f"    different auto mask/version : {len(mask_only)}/{len(NAMES)}")
        for d in mask_only:
            print(f"      {d}")
        print(f"    different bits even when pinned: {len(bit_level)}/{len(NAMES)}")
        for d in bit_level:
            print(f"      {d} (segmentation differs)")


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("px", [800, 400, 200])
def test_renders_decode(name, px):
    """The only test that really matters: does the thing still scan?

    200px stands in for a small print run or a code read across a room -- the case
    that breaks first when a logo grows or the quiet zone shrinks. Rasterised through
    the same code path the API serves, so a rasteriser regression shows up here.
    """
    import zxingcpp
    from PIL import Image

    from inscode.raster import render as rasterise

    spec = load(name)
    data, _ = rasterise(render(name), "png", px=px, matte="#ffffff")
    img = Image.open(io.BytesIO(data)).convert("RGB")
    results = zxingcpp.read_barcodes(img)
    assert any(r.text == spec.content.text for r in results), f"{name} did not decode at {px}px"


def test_transparent_plate_really_punches_a_hole():
    """A transparent plate is the one case that genuinely needs <mask> support.

    cairosvg silently ignores masks, which produced an export that did not match the
    preview. This pins the rasteriser to one that implements them.
    """
    from PIL import Image

    from inscode.raster import render as rasterise

    spec = load("logo-transparent")
    spec.encoded = ts_encoded("logo-transparent")
    svg = render_svg(spec, matrix_from_encoded(spec.encoded), logo_aspect=1.0)
    assert 'mask="url(#qr-plate)"' in svg, "expected a mask for a transparent plate"

    data, _ = rasterise(svg, "png", px=600)
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    # Just inside the plate, clear of the logo art: must be fully transparent.
    size = spec.encoded.size + 2 * spec.canvas.quiet_zone
    scale = 600 / size
    pad = spec.logo.plate.pad
    probe = int((size / 2 - (spec.logo.scale * spec.encoded.size / 2 + pad) + 0.35) * scale)
    assert img.getpixel((probe, 300))[3] == 0, (
        "plate did not punch through — the rasteriser is ignoring <mask>"
    )


def test_block_plans_match_typescript():
    """The audit's integer half has to be *identical* across the two languages.

    The renderers are held to byte-identical SVG; the scannability audit is held to
    more than that. Its measured half samples each side's own rasteriser and can only
    agree on verdicts -- but the block plan, the codeword interleaving and the
    placement walk are pure arithmetic over (version, EC level), with no image in
    them. A single differing entry there means one side is charging damage to the
    wrong Reed-Solomon block, which would show up as a plausible number rather than
    as a crash. So all 160 combinations are compared, not a sample.

    Regenerate with: cd web && npm run fixtures
    """
    from inscode.blocks import EC_LEVELS, block_plan, placement_order  # noqa: PLC0415

    expected = json.loads((TS / "blocks.json").read_text())

    def fold(xs) -> int:
        h = 0
        for x in xs:
            h = (h * 31 + x) & 0xFFFFFFFF
        return h

    mismatches = []
    for version in range(1, 41):
        walk = fold(r * 256 + c for r, c in placement_order(version))
        for level in EC_LEVELS:
            plan = block_plan(version, level)
            ours = {
                "blocks": len(plan.blocks),
                "ecPerBlock": plan.blocks[0].ec_codewords,
                "correctable": plan.blocks[0].correctable,
                "dataCodewords": [b.data_codewords for b in plan.blocks],
                "totalCodewords": plan.total_codewords,
                "remainderBits": plan.remainder_bits,
                "owners": fold(plan.owners),
                "placement": walk,
            }
            theirs = expected[f"{version}{level}"]
            for key, value in ours.items():
                if theirs[key] != value:
                    mismatches.append(f"v{version}{level}.{key}: python {value} vs ts {theirs[key]}")

    assert not mismatches, "audit block plans diverged:\n  " + "\n  ".join(mismatches[:20])


def test_damage_accounting_matches_typescript():
    """Given the same measured modules, both sides must charge the same blocks.

    The audit's measured half samples each side's own rasteriser, so the *pixels* may
    legitimately differ -- resvg and a browser canvas antialias differently and always
    will. What may not differ is the arithmetic on top: which Reed-Solomon block a
    flipped module belongs to, whether it lands on an unprotected function pattern,
    and what that costs. So the pixels are taken out of it, a synthetic symbol is
    damaged in a fixed pattern, and the accounting is compared exactly.

    Regenerate with: cd web && npm run fixtures
    """
    from inscode.audit import audit_samples  # noqa: PLC0415
    from inscode.blocks import EC_LEVELS  # noqa: PLC0415

    expected = json.loads((TS / "audit-damage.json").read_text())
    versions = sorted({int(k[:-1]) for k in expected})

    class Synthetic:
        """A made-up symbol. The accounting does not care whether the bits spell
        anything, and a real payload would drag encoder segmentation into a test that
        is not about encoding."""

        def __init__(self, version: int):
            self.version = version
            self.size = version * 4 + 17

        def get(self, r: int, c: int) -> bool:
            return (r * 7 + c * 13) % 3 == 0

    mismatches = []
    for version in versions:
        m = Synthetic(version)
        # Every eleventh module reads as the opposite of what it should.
        lums = [
            0 if m.get(r, c) != ((r * 31 + c) % 11 == 0) else 255
            for r in range(m.size)
            for c in range(m.size)
        ]
        for level in EC_LEVELS:
            a = audit_samples(lums, m, level)
            ours = {
                "blackPoint": a.black_point,
                "contrastSpread": a.contrast_spread,
                "gridFlips": a.grid_flips,
                "gridKinds": dict(a.grid_kinds),
                "formatErrors": list(a.format_errors),
                "formatOk": a.format_ok,
                "versionErrors": list(a.version_errors) if a.version_errors else None,
                "versionOk": a.version_ok,
                "findersOk": list(a.finders_ok),
                "finderRunsOk": list(a.finder_runs_ok),
                "finderRingDamage": list(a.finder_ring_damage),
                "brokenFinders": a.broken_finders,
                "modulesFlipped": a.modules_flipped,
                "worstBlock": a.worst.index,
                "headroom": a.headroom,
                "grade": a.grade,
                "corrupted": [b.corrupted for b in a.blocks],
            }
            theirs = expected[f"{version}{level}"]
            for key, value in ours.items():
                if theirs[key] != value:
                    mismatches.append(f"v{version}{level}.{key}: python {value} vs ts {theirs[key]}")

    assert not mismatches, "audit damage accounting diverged:\n  " + "\n  ".join(mismatches[:20])
