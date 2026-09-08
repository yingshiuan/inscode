"""The decoder is the ground truth. This is how we ask it, systematically.

Everything in `inscode.audit` is a model of what a decoder can recover. Models drift
from reality quietly -- three times now this project has shipped a rule that sounded
right and contradicted a phone. So the rules are no longer allowed to be asserted:
they are calibrated against, and validated by, a matrix of real decode results.

The unit is a `Case` -- a design plus a known pattern of damage -- probed under one or
more `Profile`s and read by one or more `Decoder`s. `probe()` returns a `Row` carrying
both the heuristic's view of the damage and what the decoders actually did with it, so
any question of the form "does feature X predict decodability" can be answered from
the committed dataset rather than by re-running the sweep.

Two deliberate choices:

  * **The production verdict is the *degraded* decode, not the clean one.** A perfect
    vector rasterisation decodes at 1.35 px/module, which no camera will ever manage.
    Calibrating against a clean render would bake in exactly the optimism this exists
    to remove. The clean result is recorded too, as a diagnostic.
  * **Profiles and decoders are lists, not constants.** zxing-cpp is not zxing-wasm is
    not the iPhone, and the finding that started this was an iPhone reading a code
    this tool called dead. Nothing here should have to be rewritten to add a second
    opinion.

Regenerate the dataset deliberately -- it takes minutes, and normal test runs read the
committed file instead:

    .venv/bin/python server/tests/harness.py --write
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inscode.audit import (  # noqa: E402
    audit_samples,
    estimate_black_point,
    sample_modules,
)
from inscode.encode import Matrix, encode, matrix_for, matrix_from_encoded  # noqa: E402
from inscode.geometry import alignment_cells, grid_kinds  # noqa: E402
from inscode.oracle import (  # noqa: E402
    CLEAN,
    EXTRA_PROFILES,
    PRODUCTION,
    Decoder,
    Profile,
    ZXingCpp,
    default_decoders,
    present,
)
from inscode.render import build_svg  # noqa: E402
from inscode.spec import QRSpec  # noqa: E402

DATA = Path(__file__).parent / "data" / "decoder-matrix.json"
#: Payload stems, longest first. A version-1 symbol at level H holds seven bytes, so a
#: URL cannot be the base for every cell of the sweep; the shorter stem takes over
#: exactly where the URL stops fitting.
TEXT_BASES = ("https://insdash.ch/", "qr")


# The profiles and decoders live in inscode.oracle, so the matrix this sweep builds
# and the safety decision the product makes are the same measurement, not two that
# happen to look alike.
DEFAULT_DECODERS: list[Decoder] = default_decoders()


# ------------------------------------------------------------------------ cases


@dataclass(frozen=True)
class LogoCase:
    """A synthetic logo: a shape, a tone, a size and a place to put it."""

    shape: str  # square | circle | rounded
    tone: str  # dark | mid
    scale: float
    x: float = 0.5
    y: float = 0.5
    plate: bool = True

    @property
    def label(self) -> str:
        return f"{self.shape}-{self.tone}{'' if self.plate else '-noplate'}"


@dataclass(frozen=True)
class Case:
    """One probe: a payload at a version and EC level, damaged in a known way.

    Exactly one of `logo` and `damage` is the source of damage. `damage` names the
    modules to invert outright, which is how the structural cases say precisely what
    they mean instead of hoping a logo lands on the right place.
    """

    label: str
    version: int
    ec_level: str
    logo: LogoCase | None = None
    #: Modules to invert, as (row, col). Used by the structural regression cases.
    damage: tuple[tuple[int, int], ...] = ()
    group: str = "sweep"


# --------------------------------------------------------------------- payloads

_PAYLOAD_CACHE: dict[tuple[int, str], str] = {}


def payload_for(version: int, ec_level: str) -> str:
    """A payload that encodes to exactly `version` at `ec_level`.

    The sweep is over versions, but the encoder chooses the version from the data, so
    the data has to be chosen from the version. Binary search on length.
    """
    key = (version, ec_level)
    if key in _PAYLOAD_CACHE:
        return _PAYLOAD_CACHE[key]

    for base in TEXT_BASES:
        def version_of(n: int, base: str = base) -> int:
            try:
                return encode(base + "x" * n, ec_level).version
            except ValueError:
                return 41  # past version 40; the search only needs "bigger than target"

        if version_of(0) > version:
            continue  # this stem alone already overflows the target version

        lo, hi = 0, 2200
        while lo < hi:
            mid = (lo + hi) // 2
            if version_of(mid) < version:
                lo = mid + 1
            else:
                hi = mid
        if version_of(lo) == version:
            _PAYLOAD_CACHE[key] = base + "x" * lo
            return _PAYLOAD_CACHE[key]

    raise ValueError(f"no payload lands on version {version} at level {ec_level}")


# ----------------------------------------------------------------- construction

TONES = {"dark": (17, 17, 17, 255), "mid": (138, 111, 74, 255)}


def _logo_png(shape: str, tone: str, px: int = 240) -> str:
    """A synthetic logo as a data URI. Shape and tone are the two things that change
    how much damage a given area actually does."""
    from PIL import ImageDraw

    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    fill = TONES[tone]
    if shape == "circle":
        draw.ellipse((0, 0, px - 1, px - 1), fill=fill)
    elif shape == "rounded":
        draw.rounded_rectangle((0, 0, px - 1, px - 1), radius=px // 5, fill=fill)
    else:
        draw.rectangle((0, 0, px - 1, px - 1), fill=fill)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _damage_png(matrix: Matrix, cells: Iterable[tuple[int, int]], px_per_module: int = 12) -> str:
    """An overlay that inverts exactly `cells` and touches nothing else.

    Structural questions need the damage named, not approximated by where a logo
    happened to fall.
    """
    from PIL import ImageDraw  # noqa: F401  (kept symmetrical with _logo_png)

    img = Image.new("RGBA", (matrix.size * px_per_module,) * 2, (0, 0, 0, 0))
    pixels = img.load()
    for r, c in cells:
        fill = (255, 255, 255, 255) if matrix.get(r, c) else (0, 0, 0, 255)
        for y in range(r * px_per_module, (r + 1) * px_per_module):
            for x in range(c * px_per_module, (c + 1) * px_per_module):
                pixels[x, y] = fill
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def spec_for(case: Case) -> QRSpec:
    """The design this case describes."""
    text = payload_for(case.version, case.ec_level)
    spec: dict = {"content": {"text": text, "ecLevel": case.ec_level}}

    if case.damage:
        matrix = matrix_from_encoded(encode(text, case.ec_level))
        spec["logo"] = {
            "src": _damage_png(matrix, case.damage),
            "scale": 1.0,
            "plate": {"enabled": False},
        }
    elif case.logo is not None:
        spec["logo"] = {
            "src": _logo_png(case.logo.shape, case.logo.tone),
            "scale": case.logo.scale,
            "x": case.logo.x,
            "y": case.logo.y,
            "plate": {"enabled": case.logo.plate},
        }
    return QRSpec.model_validate(spec)


# -------------------------------------------------------------------------- row


@dataclass
class Row:
    """One probe's result: the case, the heuristic's view, and what decoders did.

    Every field is either part of the case (so it can be reproduced) or a feature the
    heuristic could key on (so a threshold can be calibrated against real outcomes).
    """

    label: str
    group: str
    version: int
    ec_level: str
    modules: int  # symbol width, quiet zone excluded

    # -- the damage, as the case describes it
    logo_shape: str | None
    logo_tone: str | None
    logo_scale: float | None
    logo_x: float | None
    logo_y: float | None
    logo_plate: bool | None
    explicit_damage: int  # count of deliberately inverted modules

    # -- the damage, as measured from the rendered design
    modules_flipped: int
    #: Stable digest of the exact set of wrong modules, so two rows can be compared
    #: without carrying 30k booleans each.
    damage_digest: int
    grid_flips: int
    grid_kinds: dict[str, int]
    finder_profiles: list[bool]
    #: The centre-run check on its own, so a tolerance can be re-swept from the file.
    finder_runs_ok: list[bool]
    finder_ring_damage: list[int]
    broken_finders: int
    format_errors: list[int]
    format_ok: bool
    version_errors: list[int] | None
    version_ok: bool
    blocks_corrupted: list[int]
    correctable_per_block: int
    headroom: int
    contrast_spread: int
    black_point: int

    # -- the heuristic's verdict, for scoring against the decoders
    heuristic_intact: bool
    heuristic_grade: str

    # -- what actually happened
    decodes: dict[str, bool]  # "profile/decoder" -> read the right payload
    production_profile: str
    production_ok: bool
    clean_ok: bool
    decoders: list[str]


def _digest(flipped: Iterable[tuple[int, int]]) -> int:
    h = 0
    for r, c in sorted(flipped):
        h = (h * 31 + r * 256 + c) & 0xFFFFFFFF
    return h


def _flipped_cells(lums: list[int], matrix: Matrix, black: int) -> list[tuple[int, int]]:
    size = matrix.size
    return [
        (r, c)
        for r in range(size)
        for c in range(size)
        if (lums[r * size + c] < black) != matrix.get(r, c)
    ]


def probe(
    case: Case,
    profiles: list[Profile] | None = None,
    decoders: list[Decoder] | None = None,
    *,
    production: Profile = PRODUCTION,
) -> Row:
    """Render one case, measure the damage, and ask every decoder to read it."""
    profiles = profiles if profiles is not None else [production, CLEAN]
    decoders = decoders if decoders is not None else DEFAULT_DECODERS

    spec = spec_for(case)
    matrix = matrix_for(spec)
    svg = build_svg(spec)
    text = spec.content.text

    lums = sample_modules(svg, matrix.size, spec.canvas.quiet_zone)
    black, _ = estimate_black_point(lums)
    report = audit_samples(lums, matrix, case.ec_level)
    flipped = _flipped_cells(lums, matrix, black)

    total_modules = matrix.size + 2 * spec.canvas.quiet_zone
    decodes: dict[str, bool] = {}
    for profile in profiles:
        image = present(svg, total_modules, profile)
        for decoder in decoders:
            decodes[f"{profile.name}/{decoder.name}"] = text in decoder.read(image)

    production_key = f"{production.name}/{decoders[0].name}"
    clean_key = f"{CLEAN.name}/{decoders[0].name}"

    return Row(
        label=case.label,
        group=case.group,
        version=matrix.version,
        ec_level=case.ec_level,
        modules=matrix.size,
        logo_shape=case.logo.shape if case.logo else None,
        logo_tone=case.logo.tone if case.logo else None,
        logo_scale=case.logo.scale if case.logo else None,
        logo_x=case.logo.x if case.logo else None,
        logo_y=case.logo.y if case.logo else None,
        logo_plate=case.logo.plate if case.logo else None,
        explicit_damage=len(case.damage),
        modules_flipped=report.modules_flipped,
        damage_digest=_digest(flipped),
        grid_flips=report.grid_flips,
        grid_kinds=dict(report.grid_kinds),
        finder_profiles=list(report.finders_ok),
        finder_runs_ok=list(report.finder_runs_ok),
        finder_ring_damage=list(report.finder_ring_damage),
        broken_finders=report.broken_finders,
        format_errors=list(report.format_errors),
        format_ok=report.format_ok,
        version_errors=list(report.version_errors) if report.version_errors else None,
        version_ok=report.version_ok,
        blocks_corrupted=[b.corrupted for b in report.blocks],
        correctable_per_block=report.blocks[0].correctable,
        headroom=report.headroom,
        contrast_spread=report.contrast_spread,
        black_point=report.black_point,
        heuristic_intact=report.intact,
        heuristic_grade=report.grade,
        decodes=decodes,
        production_profile=production.name,
        production_ok=decodes[production_key],
        clean_ok=decodes.get(clean_key, False),
        decoders=[f"{d.name} {d.version}" for d in decoders],
    )


# -------------------------------------------------------------------- the sweep

SWEEP_VERSIONS = (1, 3, 7, 13, 20)
SWEEP_EC = ("L", "M", "Q", "H")
#: Geometry and tone both change how much damage a given *area* actually does -- a
#: mid-tone plate leaves roughly half the modules under it reading correctly.
SWEEP_SHAPES = (("square", "dark"), ("circle", "dark"), ("circle", "mid"))
SWEEP_POSITIONS = ((0.5, 0.5), (0.32, 0.32), (0.5, 0.27))
SWEEP_SCALES = tuple(round(0.10 + 0.05 * i, 2) for i in range(11))  # 0.10 .. 0.60


def sweep_cases() -> list[Case]:
    """The logo grid: versions x EC x shape/tone x position x size."""
    cases = []
    for version in SWEEP_VERSIONS:
        for ec in SWEEP_EC:
            for shape, tone in SWEEP_SHAPES:
                for x, y in SWEEP_POSITIONS:
                    for scale in SWEEP_SCALES:
                        logo = LogoCase(shape, tone, scale, x, y)
                        cases.append(Case(
                            label=f"v{version}{ec}-{logo.label}-{x}x{y}-{scale}",
                            version=version, ec_level=ec, logo=logo, group="sweep",
                        ))
    return cases


def baseline_cases() -> list[Case]:
    """Undamaged symbols, one per version and level.

    Without these there is no way to tell a design failing from the *profile* being
    unfair -- if a bare version-20 code cannot survive the blur, nothing measured at
    version 20 means anything.
    """
    return [
        Case(label=f"v{v}{ec}-bare", version=v, ec_level=ec, group="baseline")
        for v in SWEEP_VERSIONS
        for ec in SWEEP_EC
    ]


def noplate_cases() -> list[Case]:
    """A smaller grid without the clearing plate, so the logo sits on live modules.

    This is where a mid-tone logo differs most from a dark one, and therefore where a
    global binariser differs most from a local one.
    """
    cases = []
    for version in (3, 13):
        for ec in ("M", "H"):
            for shape, tone in SWEEP_SHAPES:
                for scale in SWEEP_SCALES:
                    logo = LogoCase(shape, tone, scale, 0.5, 0.5, plate=False)
                    cases.append(Case(
                        label=f"v{version}{ec}-{logo.label}-{scale}",
                        version=version, ec_level=ec, logo=logo, group="noplate",
                    ))
    return cases


def structural_cases() -> list[Case]:
    """Damage named module by module, so the answer is about that structure alone.

    Each family is swept by degree rather than probed once: a single point tells you
    nothing about where the threshold is, and the thresholds are the whole point.
    """
    cases = []
    for version, ec in ((3, "H"), (13, "H")):
        text = payload_for(version, ec)
        matrix = matrix_from_encoded(encode(text, ec))
        kinds = grid_kinds(version)
        timing = sorted(k for k, v in kinds.items() if v == "timing")
        separators = sorted(k for k, v in kinds.items() if v == "separator")
        alignment = sorted(alignment_cells(version))
        grid = sorted(set(timing) | set(alignment))

        from inscode.geometry import format_info_copies

        fmt_a, fmt_b = format_info_copies(version)
        fmt_row8 = sorted(c for c in (fmt_a | fmt_b) if c[0] == 8)

        families = {
            "timing": timing,
            "separator": separators,
            "alignment": alignment,
            "grid": grid,
            "format": fmt_row8,
        }
        for name, cells in families.items():
            steps = max(1, len(cells) // 8)
            for n in range(steps, len(cells) + 1, steps):
                cases.append(Case(
                    label=f"v{version}{ec}-{name}-{n}",
                    version=version, ec_level=ec,
                    damage=tuple(cells[:n]), group=f"structural/{name}",
                ))
        del matrix
    return cases


def all_cases() -> list[Case]:
    return baseline_cases() + sweep_cases() + noplate_cases() + structural_cases()


def _probe_one(case: Case) -> dict | str:
    """Pool worker. Returns the row, or a message -- a case that cannot be built is
    worth seeing rather than silently missing from the dataset."""
    try:
        return asdict(probe(case))
    except Exception as exc:
        return f"!! {case.label}: {exc}"


def generate(
    cases: list[Case] | None = None, *, jobs: int | None = None, progress: bool = True
) -> dict:
    """Probe every case. Rendering and decoding are CPU-bound and independent, so this
    fans out across processes -- the difference between half an hour and a few minutes,
    which is the difference between regenerating the dataset and not bothering."""
    from concurrent.futures import ProcessPoolExecutor

    cases = cases if cases is not None else all_cases()
    jobs = jobs or (os.cpu_count() or 4)
    rows: list[dict] = []

    with ProcessPoolExecutor(max_workers=jobs) as pool:
        for i, result in enumerate(pool.map(_probe_one, cases, chunksize=8)):
            if progress and i % 200 == 0:
                print(f"  {i}/{len(cases)}", file=sys.stderr, flush=True)
            if isinstance(result, str):
                print(f"  {result}", file=sys.stderr)
            else:
                rows.append(result)

    return {
        "production": asdict(PRODUCTION),
        "clean": asdict(CLEAN),
        "decoders": [f"{d.name} {d.version}" for d in DEFAULT_DECODERS],
        "rows": rows,
    }


def load() -> dict:
    if not DATA.exists():
        raise FileNotFoundError(
            f"{DATA} is missing. Regenerate it with:\n"
            f"    .venv/bin/python server/tests/harness.py --write"
        )
    return json.loads(DATA.read_text())


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--write" not in argv:
        print(__doc__)
        return 0
    jobs = None
    for i, arg in enumerate(argv):
        if arg == "--jobs" and i + 1 < len(argv):
            jobs = int(argv[i + 1])
    DATA.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    data = generate(jobs=jobs)
    DATA.write_text(json.dumps(data, separators=(",", ":")))
    rows = data["rows"]
    passed = sum(r["production_ok"] for r in rows)
    print(f"wrote {len(rows)} rows -> {DATA} in {time.time() - started:.0f}s")
    print(f"  production profile {data['production']['name']}: {passed} pass, "
          f"{len(rows) - passed} fail")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
