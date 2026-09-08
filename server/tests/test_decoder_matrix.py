"""The heuristic is scored against real decode results, not against the spec.

`harness.py` sweeps a matrix of damaged designs past a real decoder and commits the
answers to `data/decoder-matrix.json`. This reads that file. Nothing here renders or
decodes anything, so it runs in milliseconds; regenerating the matrix is a separate,
deliberate act:

    .venv/bin/python server/tests/harness.py --write

Two kinds of test live here:

  * **The regression matrix** -- the handful of cases that have each, at some point,
    been got wrong. Every one asserts the decoder's answer as well as the model's, so
    a case cannot quietly become a statement about our own assumptions.
  * **Agreement metrics** -- false passes above all. A false pass is the product
    telling somebody a logo is safe when their phone cannot read the result. The
    thresholds here are ratchets: they record where the model is today and refuse to
    let it get worse.
"""
import sys
from collections import defaultdict
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).parent))

import harness  # noqa: E402
from inscode.audit import audit, heuristic_max_scale, verified_max_scale  # noqa: E402
from inscode.encode import encode, matrix_from_encoded  # noqa: E402
from inscode.geometry import (  # noqa: E402
    alignment_cells,
    format_info_copies,
    grid_kinds,
)
from inscode.oracle import PRODUCTION, decoder_oracle  # noqa: E402


@pytest.fixture(scope="module")
def matrix():
    return harness.load()


@pytest.fixture(scope="module")
def rows(matrix):
    return matrix["rows"]


# --------------------------------------------------------------- the five cases

def _grid_cells(version: int, *, clear_of_finders: bool = False):
    """Timing and alignment modules. `clear_of_finders` drops the handful that fall in
    a finder's detection ring -- (6,7) and (7,6) and their mirrors are classified as
    timing by `grid_kinds` but are really separator, and the finder check owns them."""
    from inscode.audit import finder_rings

    kinds = grid_kinds(version)
    cells = set(k for k, v in kinds.items() if v == "timing") | alignment_cells(version)
    if clear_of_finders:
        cells -= set().union(*finder_rings(version * 4 + 17))
    return tuple(sorted(cells))


def _separator_cells(version: int, count: int | None = None):
    cells = sorted(k for k, v in grid_kinds(version).items() if v == "separator")
    return tuple(cells[:count] if count else cells)


def _format_cells(version: int):
    a, b = format_info_copies(version)
    return tuple(sorted(c for c in (a | b) if c[0] == 8))


def _over_budget_cells(version: int, ec: str, codewords: int = 28):
    """One module in each of the first `codewords` codewords.

    Corrupting a codeword takes one wrong module, so this is the cheapest way to blow
    the Reed-Solomon budget without touching a function pattern -- which is the point:
    the case has to isolate "too much data destroyed" from everything else.
    """
    from inscode.blocks import module_codewords

    first: dict[int, tuple[int, int]] = {}
    for cell, codeword in sorted(module_codewords(version, ec).items()):
        first.setdefault(codeword, cell)
    return tuple(first[c] for c in sorted(first)[:codewords])


#: Every case this project has, at some point, got wrong. `decoder` is what zxing
#: actually does -- the ground truth. `model` is what the heuristic must say. Where
#: they differ the divergence is deliberate and the note says why; a case is never
#: allowed to quietly become a statement about our own assumptions.
REGRESSIONS = [
    dict(
        label="grid wrecked, clear of the finders",
        cells=lambda: _grid_cells(3, clear_of_finders=True),
        decoder=True, model=True,
        note="timing and alignment carry no error correction and are barely read; "
             "a decoder locks the grid from the finder patterns instead",
    ),
    dict(
        label="grid wrecked, 55 modules including the finder rings",
        cells=lambda: _grid_cells(3),
        decoder=True, model=False,
        note="four of the 55 sit in a finder's detection ring, where the model is "
             "deliberately strict: one wrong ring module decodes 4 times in 64 across "
             "the matrix, so it is not a risk worth passing. A known, priced false fail",
    ),
    dict(
        label="12 separator modules wrecked",
        cells=lambda: _separator_cells(3, 12),
        decoder=False, model=False,
        note="the 7x7 patterns are untouched; the corners are still unfindable",
    ),
    dict(
        label="format information wrecked",
        cells=lambda: _format_cells(3),
        decoder=False, model=False,
        note="both BCH copies past budget, so the mask cannot be identified",
    ),
    dict(
        label="blocks over the correction budget",
        cells=lambda: _over_budget_cells(3, "H"),
        decoder=False, model=False,
        note="finders, grid and format all clean; simply too much data destroyed",
    ),
]


@pytest.mark.parametrize("case", REGRESSIONS, ids=lambda c: c["label"])
def test_regression_matrix(case):
    """The named cases, asserted against the decoder rather than against a rule."""
    cells = case["cells"]()
    row = harness.probe(harness.Case(
        label=case["label"], version=3, ec_level="H", damage=cells, group="regression",
    ))
    assert row.clean_ok is case["decoder"], (
        f"{case['label']}: decoder disagreed -- the ground truth moved, not the model"
    )
    assert row.heuristic_intact is case["model"], f"{case['label']}: {case['note']}"


def test_regression_logo_touching_finder():
    """Small logo, almost no block damage, dead code: the finder is unfindable."""
    logo = harness.LogoCase("square", "dark", scale=0.2, x=0.12, y=0.12)
    row = harness.probe(harness.Case("logo on finder", 3, "H", logo=logo, group="regression"))
    assert row.broken_finders > 0
    assert row.heuristic_intact is False
    assert row.clean_ok is False


def test_the_over_budget_case_really_only_touches_data():
    """The blocks case is only about blocks if it leaves everything else alone."""
    row = harness.probe(harness.Case(
        "over budget", 3, "H", damage=_over_budget_cells(3, "H"), group="regression",
    ))
    assert row.broken_finders == 0
    assert row.grid_flips == 0
    assert row.format_ok and row.version_ok
    assert row.headroom < 0


def test_the_grid_case_really_is_55_modules():
    """The number in the regression table should mean something."""
    assert len(_grid_cells(3)) == 55
    assert len(_grid_cells(3, clear_of_finders=True)) == 51


# ------------------------------------------------------------------- agreement

#: Ratchets. Today's numbers, so the model cannot silently regress -- and so that a
#: calibration change has to show its work by moving them down. Set just above the
#: measured rate, never far above.
#:
#:   before the finder ring check   5.1% false pass, 0.5% false fail
#:   after                          1.5% false pass, 2.9% false fail
#:
#: The trade was taken deliberately: a false pass is a code somebody's phone cannot
#: read, a false fail is a slightly smaller logo. The false-fail figure is the next
#: thing to bring down, and the binariser is where most of it lives.
MAX_FALSE_PASS_RATE = 0.02
MAX_FALSE_FAIL_RATE = 0.035


def _score(rows, verdict=lambda r: r["heuristic_intact"], truth=lambda r: r["production_ok"]):
    false_pass = [r for r in rows if verdict(r) and not truth(r)]
    false_fail = [r for r in rows if not verdict(r) and truth(r)]
    return false_pass, false_fail


def test_heuristic_agreement_does_not_regress(rows):
    false_pass, false_fail = _score(rows)
    fp = len(false_pass) / len(rows)
    ff = len(false_fail) / len(rows)
    assert fp <= MAX_FALSE_PASS_RATE, (
        f"false passes rose to {fp:.1%} ({len(false_pass)}/{len(rows)}). "
        "The model is calling designs safe that the decoder cannot read."
    )
    assert ff <= MAX_FALSE_FAIL_RATE, f"false fails rose to {ff:.1%}"


def test_false_passes_are_reported_by_cause(rows, capsys):
    """Not an assertion -- a standing readout of where the model is wrong, so the next
    calibration step is chosen from evidence rather than intuition."""
    false_pass, false_fail = _score(rows)
    hard = [r for r in false_pass if not r["clean_ok"]]
    soft = [r for r in false_pass if r["clean_ok"]]

    def bucket(rs, key):
        counts = defaultdict(int)
        for r in rs:
            counts[key(r)] += 1
        return dict(sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[:6])

    with capsys.disabled():
        print(f"\n  decoder matrix: {len(rows)} rows, {harness.load()['decoders']}")
        print(f"    agreement    {1 - (len(false_pass) + len(false_fail)) / len(rows):.1%}")
        print(f"    false passes {len(false_pass)} "
              f"({len(hard)} the model gets wrong, {len(soft)} optics-limited)")
        where = bucket(hard, lambda r: f"{r['logo_x']},{r['logo_y']}")
        print(f"      by position {where}")
        print(f"      by grid flips {bucket(hard, lambda r: r['grid_flips'] and '>0' or '0')}")
        print(f"    false fails  {len(false_fail)} {bucket(false_fail, lambda r: r['heuristic_grade'])}")


def test_the_production_profile_is_not_unfair(rows):
    """Every undamaged symbol must survive the profile, or it is measuring the profile
    rather than the design."""
    bare = [r for r in rows if r["modules_flipped"] == 0]
    assert bare, "expected some undamaged rows in the matrix"
    assert all(r["production_ok"] for r in bare), (
        "the production profile fails codes with no damage at all"
    )


# ---------------------------------------------------------------- monotonicity

def _series(rows):
    out = defaultdict(list)
    for r in rows:
        if r["logo_scale"] is None:
            continue
        out[(r["version"], r["ec_level"], r["logo_shape"], r["logo_tone"],
             r["logo_x"], r["logo_y"], r["logo_plate"])].append(r)
    return out


def _monotone(flags: list[bool]) -> bool:
    first_fail = next((i for i, ok in enumerate(flags) if not ok), len(flags))
    return not any(flags[first_fail:])


def test_the_heuristic_is_monotone_so_bisection_is_valid(rows):
    """`heuristic_max_scale` bisects, which is only sound if the predicate is monotone
    in scale. Measured, not assumed."""
    broken = [
        key for key, rs in _series(rows).items()
        if not _monotone([r["heuristic_intact"] for r in sorted(rs, key=lambda r: r["logo_scale"])])
    ]
    assert not broken, f"{len(broken)} series are non-monotone; bisection is unsound there"


def test_the_decoder_is_not_monotone_so_the_answer_needs_a_guard(rows):
    """The reason `verified_max_scale` verifies points *below* its answer.

    A handful of series read again at a size above one that failed. Handing back the
    top of an island would be a trap: told "safe up to 35%", nobody expects 30% to
    fail. This pins the phenomenon so the guard is never mistaken for dead weight.
    """
    series = _series(rows)
    broken = [
        key for key, rs in series.items()
        if not _monotone([r["production_ok"] for r in sorted(rs, key=lambda r: r["logo_scale"])])
    ]
    assert broken, (
        "the decoder now looks monotone over the whole matrix. If that holds up, the "
        "guard in verified_max_scale could be relaxed -- but check a wider sweep first."
    )
    assert len(broken) / len(series) < 0.1, "non-monotonicity is widespread; bisection is wrong"


# ------------------------------------------------------- the confirmed contract

@pytest.mark.parametrize("ec_level", ["L", "M", "Q", "H"])
def test_confirmed_scale_is_never_a_false_pass(ec_level):
    """The one promise the product makes: a size it offers, a decoder can read.

    Not a statistical claim -- a structural one. `verified_max_scale` returns only scales
    it has actually put past the oracle, so this checks the contract holds end to end
    rather than trusting the construction.
    """
    oracle = decoder_oracle(PRODUCTION)
    logo = harness.LogoCase("circle", "dark", scale=0.45)
    spec = harness.spec_for(harness.Case("confirm", 3, ec_level, logo=logo))

    confirmed = verified_max_scale(spec, oracle).scale
    if confirmed is None:
        return  # refusing to answer is always safe

    probe = spec.model_copy(deep=True)
    probe.logo.scale = confirmed
    assert oracle(probe), f"offered {confirmed} at {ec_level}, decoder cannot read it"


def test_confirmation_only_ever_shrinks_the_heuristic_answer():
    """The heuristic proposes and the decoder disposes; the decoder is allowed to be
    more generous by a step or two, never wildly so."""
    oracle = decoder_oracle(PRODUCTION)
    logo = harness.LogoCase("circle", "dark", scale=0.45)
    for ec_level in ("L", "M", "Q", "H"):
        spec = harness.spec_for(harness.Case("confirm", 3, ec_level, logo=logo))
        heuristic = heuristic_max_scale(spec)
        confirmed = verified_max_scale(spec, oracle).scale
        if confirmed is None or heuristic is None:
            continue
        assert confirmed <= heuristic + 0.05, (
            f"{ec_level}: confirmation returned {confirmed} above heuristic {heuristic}"
        )


def test_audit_without_an_oracle_reports_no_verified_answer():
    """The preview path: the model's estimate, and an explicit absence where the
    decoder's answer would go. Never the estimate wearing the decoder's label."""
    logo = harness.LogoCase("circle", "dark", scale=0.30)
    spec = harness.spec_for(harness.Case("preview", 3, "H", logo=logo))
    report = audit(spec)
    assert report.estimated_safe_scale == heuristic_max_scale(spec)
    assert report.verified_safe_scale is None


# ------------------------------------------------------------------ calibration

def _replay(rows, *, ring_tol=0, headroom_floor=0, grid_limit=None):
    """Re-derive the verdict from recorded features, so a threshold can be swept
    without re-rendering 2215 designs."""
    false_pass = false_fail = 0
    for r in rows:
        finders = all(
            ok and damage <= ring_tol
            for ok, damage in zip(r["finder_runs_ok"], r["finder_ring_damage"])
        )
        grid_ok = grid_limit is None or r["grid_flips"] <= grid_limit
        intact = (
            r["contrast_spread"] > 0 and finders and grid_ok
            and r["format_ok"] and r["version_ok"] and r["headroom"] >= headroom_floor
        )
        if intact and not r["production_ok"]:
            false_pass += 1
        elif not intact and r["production_ok"]:
            false_fail += 1
    return false_pass, false_fail


def test_replay_reproduces_the_live_verdict(rows):
    """The sweeps below are only worth anything if the replay is the real thing."""
    live_fp = sum(1 for r in rows if r["heuristic_intact"] and not r["production_ok"])
    live_fn = sum(1 for r in rows if not r["heuristic_intact"] and r["production_ok"])
    assert _replay(rows) == (live_fp, live_fn)


def test_the_finder_ring_tolerance_is_the_calibrated_one(rows):
    """Zero, chosen because false passes matter more than false fails. Tolerance 2
    scores better overall; it is not what this is optimising for."""
    from inscode.audit import FINDER_RING_TOLERANCE

    assert FINDER_RING_TOLERANCE == 0
    strict, _ = _replay(rows, ring_tol=0)
    for looser in (1, 2, 3):
        assert _replay(rows, ring_tol=looser)[0] >= strict, (
            f"tolerance {looser} would let through fewer false passes than 0; recalibrate"
        )


def test_the_reed_solomon_cliff_is_where_the_spec_puts_it(rows):
    """`headroom >= 0` is the ISO budget taken literally, and the matrix agrees: moving
    it either way costs more than it saves. Worth pinning, because "just one more
    codeword" is a tempting thing to try."""
    fp, fn = _replay(rows, headroom_floor=0)
    for floor in (-2, -1, 1, 2):
        alt_fp, alt_fn = _replay(rows, headroom_floor=floor)
        assert alt_fp + alt_fn >= fp + fn, (
            f"headroom floor {floor} scores better than 0 ({alt_fp}+{alt_fn} vs {fp}+{fn})"
        )


def test_grid_damage_should_stay_unbounded(rows):
    """Every cap on timing/alignment damage costs more in false fails than it saves in
    false passes -- the measurement behind leaving it out of `intact` entirely."""
    fp, fn = _replay(rows, grid_limit=None)
    for limit in (60, 30, 15, 8, 0):
        capped_fp, capped_fn = _replay(rows, grid_limit=limit)
        saved = fp - capped_fp
        cost = capped_fn - fn
        assert cost > saved, (
            f"a grid cap at {limit} saves {saved} false passes for {cost} false fails; "
            "if that ever inverts, the cap is worth having"
        )


# ------------------------------------------------------------- the export gate

def test_the_render_endpoint_refuses_a_design_it_cannot_read():
    """The export invariant, at the API. A file does not leave here at a size a real
    decoder cannot read -- the 95.6%-accurate model does not get a vote on this."""
    import app as api

    logo = harness.LogoCase("circle", "dark", scale=0.45)
    spec = harness.spec_for(harness.Case("oversized", 3, "H", logo=logo))

    with pytest.raises(api.Unreadable) as caught:
        api._render(api.RenderRequest(spec=spec, format="png", px=512))

    assert caught.value.verified is not None, "expected a size to offer instead"
    assert caught.value.verified < spec.logo.scale
    assert "does not decode" in str(caught.value)


def test_the_render_endpoint_passes_a_design_it_can_read():
    import app as api

    logo = harness.LogoCase("circle", "dark", scale=0.20)
    spec = harness.spec_for(harness.Case("safe", 3, "H", logo=logo))
    data, mime = api._render(api.RenderRequest(spec=spec, format="png", px=512))
    assert mime == "image/png" and len(data) > 0


def test_verification_can_be_turned_off_deliberately():
    """Not every render is an export -- a thumbnail or a mock-up has no scannability
    to protect. It has to be asked for, though; the default is to check."""
    import app as api

    logo = harness.LogoCase("circle", "dark", scale=0.45)
    spec = harness.spec_for(harness.Case("oversized", 3, "H", logo=logo))
    assert api.RenderRequest(spec=spec).verify is True
    data, _ = api._render(api.RenderRequest(spec=spec, format="png", px=512, verify=False))
    assert len(data) > 0


def test_the_report_keeps_the_two_answers_apart():
    """`estimatedSafeScale` and `verifiedSafeScale` are different questions and the
    payload says so. Collapsing them is how a guess starts looking like a guarantee."""
    from inscode.validate import report as full_report

    logo = harness.LogoCase("circle", "dark", scale=0.40)
    spec = harness.spec_for(harness.Case("both", 3, "H", logo=logo))
    integrity = full_report(spec, {"kind": "print", "mm": 40})["integrity"]

    assert integrity["estimatedSafeScale"] is not None
    assert integrity["verifiedSafeScale"] is not None
    assert integrity["verifiedSafeScale"] <= integrity["estimatedSafeScale"] + 0.05


# ------------------------------------------------- the notch the search steps over

#: A design that has, on more than one payload, held a size that fails between two
#: that read. Only the *design* is pinned -- where the notch lands is a property of one
#: symbol's bits, so it moves whenever the payload does. Hardcoding a scale meant the
#: regression quietly stopped testing anything the first time a fixture was edited.
NOTCH_DESIGN = dict(version=20, ec_level="Q", shape="circle", tone="dark", x=0.5, y=0.27)

#: The band to sweep, and the step. Finer than `CONFIRM_STEP` (0.02) on purpose: a
#: notch narrower than the search grid is exactly what this is looking for.
NOTCH_BAND = [round(0.30 + 0.01 * i, 2) for i in range(26)]


def _notch_spec(scale: float):
    logo = harness.LogoCase(
        NOTCH_DESIGN["shape"], NOTCH_DESIGN["tone"], scale,
        NOTCH_DESIGN["x"], NOTCH_DESIGN["y"],
    )
    return harness.spec_for(
        harness.Case("notch", NOTCH_DESIGN["version"], NOTCH_DESIGN["ec_level"], logo=logo)
    )


@pytest.fixture(scope="module")
def notch_sweep():
    """Every size in the band, and whether the decoder reads it."""
    from inscode.oracle import PRODUCTION, reads

    return {scale: reads(_notch_spec(scale), PRODUCTION) for scale in NOTCH_BAND}


@pytest.fixture(scope="module")
def notch(notch_sweep):
    """A size that fails with a reading size either side of it, if one exists."""
    for i in range(1, len(NOTCH_BAND) - 1):
        lo, here, hi = NOTCH_BAND[i - 1], NOTCH_BAND[i], NOTCH_BAND[i + 1]
        if not notch_sweep[here] and notch_sweep[lo] and notch_sweep[hi]:
            return here
    return None


def test_export_permission_tracks_the_artifact_across_the_whole_band(notch_sweep):
    """The invariant, swept at a finer grain than the verification search uses.

    This is the test that cannot go stale: whatever the payload, at every size in the
    band, a file is written exactly when that file reads. Any notch anywhere in the
    band is caught by it whether or not one happens to exist today.
    """
    import app as api

    for scale, readable in notch_sweep.items():
        try:
            api._render(api.RenderRequest(spec=_notch_spec(scale), format="png", px=512))
            exported = True
        except api.Unreadable:
            exported = False
        assert exported is readable, (
            f"at {scale}: artifact {'reads' if readable else 'fails'}, "
            f"export {'allowed' if exported else 'refused'}"
        )


def test_the_verified_scale_can_sit_above_a_size_that_fails(notch, notch_sweep):
    """The premise behind the exact check: the recommendation is not a safe ceiling.

    `verified_max_scale` walks sizes on a 0.02 grid, so a failure narrower than that
    grid hides between two samples and the search reports a number above it.
    """
    from inscode.oracle import PRODUCTION, decoder_oracle

    if notch is None:
        pytest.skip(
            "no notch in the band for this payload -- the invariant above still holds, "
            "but there is no live example of the recommendation overshooting today"
        )
    oracle = decoder_oracle(PRODUCTION)
    spec = _notch_spec(notch)
    verified = verified_max_scale(spec, oracle, candidate=heuristic_max_scale(spec)).scale

    assert verified is not None and verified > notch, (
        f"notch at {notch}; expected the sampled search to report above it, got {verified}"
    )
    assert not notch_sweep[notch], "the notch must be a failing size"
    assert notch_sweep[round(notch - 0.01, 2)] and notch_sweep[round(notch + 0.01, 2)], (
        "and the sizes either side of it must read, or it is just the boundary"
    )


def test_export_refuses_the_notch_that_the_verified_scale_would_have_allowed(notch):
    """The fix. `scale <= verifiedSafeScale` holds at the notch and must not be
    enough: the export path puts the exact artifact to the decoder, and it does not
    read."""
    import app as api

    if notch is None:
        pytest.skip("no notch in the band for this payload")
    with pytest.raises(api.Unreadable):
        api._render(api.RenderRequest(spec=_notch_spec(notch), format="png", px=512))


def test_export_allows_the_exact_artifact_either_side_of_the_notch(notch):
    """The other half: an exact check must not become a blanket refusal. Both
    neighbours read, so both export -- including the one *above* the size that
    failed."""
    import app as api

    if notch is None:
        pytest.skip("no notch in the band for this payload")
    for scale in (round(notch - 0.01, 2), round(notch + 0.01, 2)):
        data, mime = api._render(
            api.RenderRequest(spec=_notch_spec(scale), format="png", px=512)
        )
        assert mime == "image/png" and len(data) > 0, f"scale {scale} should export"


def test_export_checks_the_artifact_not_the_recommendation():
    """Stated as an invariant rather than an example: for a sample of designs, whether
    the export path allows a file is exactly whether that file reads. Never the
    heuristic's estimate, and never a comparison against the verified maximum."""
    import app as api

    from inscode.oracle import PRODUCTION, reads

    for scale in (0.10, 0.30, 0.44, 0.45, 0.46, 0.60):
        spec = _notch_spec(scale)
        readable = reads(spec, PRODUCTION)
        try:
            api._render(api.RenderRequest(spec=spec, format="png", px=512))
            exported = True
        except api.Unreadable:
            exported = False
        assert exported is readable, (
            f"at {scale}: decoder says {'reads' if readable else 'fails'}, "
            f"export {'allowed' if exported else 'refused'}"
        )


def test_no_safe_size_found_does_not_block_a_file_that_reads():
    """The other half of the export invariant, and the easier one to get wrong safely.

    `verified_max_scale` returns None for a design that reads at one size and fails at a
    smaller one -- there is no size below which nothing fails, so it has no answer to
    give. That is a fair thing to tell somebody, and a bad reason to refuse to write a
    file that works. Four such designs are in the calibration matrix; this is one.
    """
    import app as api

    from inscode.oracle import PRODUCTION, decoder_oracle, reads

    logo = harness.LogoCase("circle", "mid", 0.10, 0.32, 0.32)
    spec = harness.spec_for(harness.Case("no-safe-size", 1, "M", logo=logo))

    found = verified_max_scale(spec, decoder_oracle(PRODUCTION))
    assert found.scale is None, "expected the search to find no safe size"
    assert found.unstable, "expected it to be the unstable kind, not the dead kind"
    assert reads(spec, PRODUCTION), "expected the artifact itself to read"

    data, mime = api._render(api.RenderRequest(spec=spec, format="png", px=512))
    assert mime == "image/png" and len(data) > 0, (
        "a readable artifact must export, whatever the recommendation could not find"
    )


def test_export_permission_tracks_the_artifact_and_nothing_else():
    """Stated as a property over designs on both sides of every recommendation:
    exported if and only if the exact artifact reads. No recommendation, estimate or
    absence of one may add or remove permission."""
    import app as api

    from inscode.oracle import PRODUCTION, reads

    designs = [
        # (version, ec, shape, tone, x, y, scale)
        (1, "M", "circle", "mid", 0.32, 0.32, 0.10),   # no safe size found, may still read
        (3, "H", "circle", "dark", 0.5, 0.5, 0.30),    # comfortably inside
        (3, "H", "circle", "dark", 0.5, 0.5, 0.60),    # comfortably outside
        (20, "Q", "circle", "dark", 0.5, 0.27, 0.43),  # around the notch band
        (20, "Q", "circle", "dark", 0.5, 0.27, 0.50),
    ]
    for version, ec, shape, tone, x, y, scale in designs:
        logo = harness.LogoCase(shape, tone, scale, x, y)
        spec = harness.spec_for(harness.Case("prop", version, ec, logo=logo))
        readable = reads(spec, PRODUCTION)
        try:
            api._render(api.RenderRequest(spec=spec, format="png", px=512))
            exported = True
        except api.Unreadable:
            exported = False
        assert exported is readable, (
            f"v{version}{ec} {shape}-{tone}@{x},{y} at {scale}: "
            f"artifact {'reads' if readable else 'fails'}, export "
            f"{'allowed' if exported else 'refused'}"
        )
