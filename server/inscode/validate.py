"""Can a real scanner resolve this? -- the optical half of the question.

`audit.py` answers the other half exactly, from the design itself: is the data still
recoverable. That is a property of the drawing and needs no decoding. This is the
part that genuinely cannot be computed, only swept: lenses, noise, print gain and
motion blur all live here, and the only honest tool is to degrade the image in the
ways a real read degrades it and see what survives.

Two things this deliberately does not do:

  * It does not measure in pixels. 200px is generous for a version-2 code and
    hopeless for a version-20 one -- the ratio a scanner sees is pixels per *module*,
    so that is the unit the sweep is expressed in.
  * It does not reward a decode below the Nyquist limit. resvg draws perfect
    antialiased geometry and zxing will recover a code at 1.35 px/module from it; a
    phone camera never will. Passing at that size is an artefact of the test, not
    evidence about the design, so the sweep does not go there.
"""
import math

import zxingcpp

from .audit import audit
from .encode import matrix_for
from .logoink import logo_ink
from .oracle import PRODUCTION, Profile, decoder_oracle, present
from .render import build_svg
from .sampler import load_image
from .spec import QRSpec

#: The conventional floor for the module size ("X-dimension") of a printed code read
#: by a phone. Below it, scanning depends on the camera and the light rather than on
#: the design, which is not something this report can speak for.
#: Shared with web/src/qr/output.ts -- change both together.
MIN_MODULE_MM = 0.5

#: A screen code needs enough pixels per module for the scanner's sampling grid.
GOOD_PX_PER_MODULE = 4

#: Below this the sampling grid aliases and no design survives -- and, importantly, a
#: clean vector render decodes well past it, so a measured pass down there is an
#: artefact of the test rather than a fact about the design. It is a floor, checked
#: before any decoding, not something the sweep is allowed to argue with.
MIN_PX_PER_MODULE = 2.0

#: The caller's own output size, swept alongside the standard ladder.
AT_YOUR_SIZE = "at your size"

#: The ladder, as `Profile`s -- the same type the production oracle and the calibration
#: harness use, so all three go through one piece of rendering code rather than three
#: that drift apart. Each is a plausible way a real code is read: 4 px/module is a code
#: filling a phone screen at arm's length; 2.5 is a business card; below 2 the sampling
#: grid itself starts to alias and no design survives.
CONDITIONS = [
    Profile("large", 8.0),
    Profile("screen", 4.0),
    Profile("small print", 2.5),
    Profile("soft focus", 4.0, blur=1.6),
    Profile("low contrast", 4.0, contrast=0.45),
    Profile("rotated 12°", 4.0, rotate=12.0),
]


def stress(svg: str, expected: str, modules: int, at_px_per_module: float | None = None) -> dict:
    """Sweep a design across the conditions above. `modules` includes the quiet zone.

    `at_px_per_module` adds the caller's own output size to the sweep, which is the
    only condition they actually care about -- the ladder exists to say how much room
    there is either side of it.
    """
    ladder = list(CONDITIONS)
    if at_px_per_module and at_px_per_module > 0:
        ladder.insert(0, Profile(AT_YOUR_SIZE, float(at_px_per_module)))

    results = []
    for profile in ladder:
        px = max(32, round(modules * profile.px_per_module))
        try:
            ok = any(
                h.text == expected
                for h in zxingcpp.read_barcodes(present(svg, modules, profile))
            )
        except Exception:
            ok = False
        results.append({
            "condition": profile.name,
            "pxPerModule": profile.px_per_module,
            "size": px,
            "ok": ok,
        })

    passed = sum(r["ok"] for r in results)
    score = passed / len(results)
    clean = [r for r in results if r["ok"] and r["condition"] in ("large", "screen", "small print")]
    smallest = min((r["pxPerModule"] for r in clean), default=None)
    degraded_ok = all(
        r["ok"] for r in results if r["condition"] in ("soft focus", "low contrast", "rotated 12°")
    )
    at_size = next((r for r in results if r["condition"] == AT_YOUR_SIZE), None)

    # Only quote a print size for a design that survived the degraded conditions. A
    # code that needs a perfect render is not one to hand somebody a millimetre
    # figure for -- saying so is more use than a number that implies confidence.
    min_width_mm = math.ceil(modules * MIN_MODULE_MM) if degraded_ok and smallest else None

    if score == 1:
        grade, message = "ok", "Scans under every condition tested"
    elif score >= 0.6:
        failed = ", ".join(r["condition"] for r in results if not r["ok"])
        grade, message = "risky", f"Fails when: {failed}"
    elif passed:
        grade, message = "fragile", "Only scans in ideal conditions"
    else:
        grade, message = "fail", "Does not scan at any size tested"

    return {
        "grade": grade,
        "score": round(score, 3),
        "passed": passed,
        "total": len(results),
        "message": message,
        "minPxPerModule": smallest,
        "minWidthMm": min_width_mm,
        "degradedOk": degraded_ok,
        "atYourSize": at_size,
        "conditions": results,
    }


def fit(output: dict, modules: int, optical: dict) -> dict:
    """How the design fares at the size it is actually being made.

    Without this the report answers in the abstract, and an abstract answer is read as
    a verdict about whatever the reader is looking at -- which, in a design tool, is a
    preview several hundred pixels wide whatever the code is.
    """
    kind = output.get("kind")
    if kind == "print":
        mm = float(output["mm"])
        pitch = mm / modules if modules else 0.0
        if pitch < MIN_MODULE_MM:
            ok, message = False, (
                f"{pitch:.2f} mm per module is under the {MIN_MODULE_MM} mm floor — "
                f"print at least {math.ceil(modules * MIN_MODULE_MM)} mm wide"
            )
        elif not optical["degradedOk"]:
            ok, message = False, f"large enough, but {optical['message'].lower()}"
        else:
            ok, message = True, f"{pitch:.2f} mm per module, above the {MIN_MODULE_MM} mm floor"
        return {"kind": "print", "size": mm, "unit": "mm", "pitch": round(pitch, 3),
                "ok": ok, "message": message}

    px = float(output["px"])
    pitch = px / modules if modules else 0.0
    at_size = optical.get("atYourSize")
    if pitch < MIN_PX_PER_MODULE:
        need = math.ceil(modules * MIN_PX_PER_MODULE)
        return {"kind": "screen", "size": px, "unit": "px", "pitch": round(pitch, 2), "ok": False,
                "message": (f"{pitch:.1f} px per module is below the {MIN_PX_PER_MODULE:g} px "
                            f"sampling floor — needs at least {need} px")}
    if at_size is not None and not at_size["ok"]:
        ok, message = False, f"{pitch:.1f} px per module does not decode"
    elif not optical["degradedOk"]:
        ok, message = False, f"decodes, but {optical['message'].lower()}"
    else:
        ok, message = True, f"{pitch:.1f} px per module, decodes"
    return {"kind": "screen", "size": px, "unit": "px", "pitch": round(pitch, 2),
            "ok": ok, "message": message}


def report(spec: QRSpec, output: dict | None = None) -> dict:
    """Both axes for one design, side by side.

    They are kept separate because they are independent, and one verdict cannot
    carry them: a design can be perfectly recoverable and still too small to read,
    or plainly legible with its payload already destroyed. The combined grade is
    just the worse of the two, and integrity leads -- if the data is gone, how well
    a scanner resolves the drawing is beside the point.

    `integrity.verifiedSafeScale` here is decoder-confirmed: every size it reports has
    been rendered under the production profile and read back. `estimatedSafeScale` sits
    beside it as the model's own answer, which is faster and measurably not the same
    thing -- 95.6% agreement over the calibration matrix.
    """
    matrix = matrix_for(spec)
    modules = matrix.size + 2 * spec.canvas.quiet_zone
    # This is the authoritative path -- an API call or a CLI check, not a live preview
    # -- so the largest-logo number is confirmed by a real decoder rather than left as
    # the model's own estimate. The browser keeps the fast heuristic for dragging.
    integrity = audit(spec, oracle=decoder_oracle(PRODUCTION))
    at_px = None
    if output and output.get("kind") == "screen" and modules:
        # A screen target is a pixel question, so its own size joins the sweep. A print
        # target's limit is physical; the conditions answer it instead. Below the
        # sampling floor there is nothing to measure -- a clean render decodes there
        # and would report a reassuring pass, which is the whole trap.
        pitch = float(output["px"]) / modules
        at_px = pitch if pitch >= MIN_PX_PER_MODULE else None
    optical = stress(build_svg(spec), spec.content.text, modules, at_px)
    fitted = fit(output, modules, optical) if output else None
    ink = _logo_ink(spec, matrix)

    if not integrity.intact:
        grade, message = "fail", integrity.message
    elif fitted is not None and not fitted["ok"]:
        grade, message = "fail", f"At {fitted['size']:g} {fitted['unit']}: {fitted['message']}"
    elif optical["grade"] in ("fail", "fragile"):
        grade, message = optical["grade"], optical["message"]
    elif integrity.grade == "marginal" or optical["grade"] == "risky":
        grade = "risky"
        message = integrity.message if integrity.grade == "marginal" else optical["message"]
    else:
        grade, message = "ok", "Data intact and legible under every condition tested"

    return {
        "grade": grade,
        "message": message,
        "integrity": integrity.as_dict(),
        "optical": optical,
        "fit": fitted,
        "logo": ink.as_dict() if ink else None,
        "modules": modules,
    }


def _logo_ink(spec: QRSpec, matrix):
    """The artwork profile, or None if there is no logo or it will not decode.

    Never allowed to fail the report: this is an advisory about the *file*, and a
    logo the renderer has already drawn is not going to be refused a verdict because
    it could not be profiled a second time.
    """
    if spec.logo is None:
        return None
    try:
        return logo_ink(spec, matrix, load_image(spec.logo.src))
    except Exception:
        return None
