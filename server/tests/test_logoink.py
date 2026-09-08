"""Does the logo warning fire on the right files, and is its advice true?

The warning tells a user to do something to an asset, so it has to clear two bars
that a purely descriptive number does not:

  * It must not fire on artwork that has no flat background to remove. A photograph
    and a two-tone mark that runs to the edge of its box are both opaque and both
    beyond help; telling their owner to key out a colour is advice that damages the
    logo and gains nothing.
  * When it does fire, keying the colour out must actually recover the modules it
    promises. That one is checked against the decoder rather than the model, because
    the promise is about what a scanner will read.

`profile_pixels` is the half that must be identical in the browser, so it is tested
on synthetic buffers whose bytes both languages can construct from the same
arithmetic. web/src/qr/__tests__/logoInk.test.ts asserts the same literals.
"""
import base64
import io
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inscode.encode import matrix_for  # noqa: E402
from inscode.logoink import (  # noqa: E402
    MIN_BACKGROUND,
    PROFILE_GRID,
    logo_ink,
    profile_pixels,
    sample_axis,
)
from inscode.oracle import PRODUCTION, reads  # noqa: E402
from inscode.sampler import load_image  # noqa: E402
from inscode.spec import QRSpec  # noqa: E402

URL = "https://insdash.ch/some/deep/link?ref=qr"


# --- synthetic buffers, built from arithmetic the browser repeats exactly ---------

def buf(w: int, h: int, fn) -> bytes:
    out = bytearray()
    for y in range(h):
        for x in range(w):
            out.extend(fn(x, y))
    return bytes(out)


def cutout(x, y):
    """A disc of ink on transparency -- what a properly exported logo looks like."""
    inside = (x - 32) ** 2 + (y - 32) ** 2 <= 24 * 24
    return (20, 40, 90, 255) if inside else (0, 0, 0, 0)


def flat_white(x, y):
    return (16, 24, 56, 255) if 12 <= x < 52 and 20 <= y < 44 else (255, 255, 255, 255)


def flat_black(x, y):
    return (240, 240, 240, 255) if 12 <= x < 52 and 20 <= y < 44 else (0, 0, 0, 255)


def photo(x, y):
    return ((x * 7 + y * 3) % 256, (x * 3 + y * 11) % 256, (x * 13 + y * 5) % 256, 255)


def duotone(x, y):
    return (230, 90, 40, 255) if (x + y) % 40 < 20 else (20, 40, 90, 255)


def test_sample_axis_is_centred_and_in_range():
    assert sample_axis(4, 64) == [8, 24, 40, 56]
    assert sample_axis(3, 3) == [0, 1, 2]
    # Never runs off the end, whatever the ratio -- an off-by-one here reads garbage.
    for extent in (1, 7, 64, 512, 4000):
        got = sample_axis(min(PROFILE_GRID, extent), extent)
        assert got[0] >= 0 and got[-1] < extent
        assert got == sorted(got)


@pytest.mark.parametrize(
    "name, fn, opaque, background, share",
    [
        # A cutout has a transparent border, so no background is claimed at all.
        ("cutout", cutout, 0.4377, None, 0.0),
        ("flat white", flat_white, 1.0, (255, 255, 255), 0.7656),
        ("flat black", flat_black, 1.0, (0, 0, 0), 0.7656),
        # Both of these are opaque and neither has a field to key out.
        ("photo", photo, 1.0, None, 0.0),
        ("duotone", duotone, 1.0, None, 0.0),
    ],
)
def test_profile_pixels(name, fn, opaque, background, share):
    """Exact expectations, mirrored literal for literal in logoInk.test.ts."""
    ink = profile_pixels(buf(64, 64, fn), 64, 64)
    assert round(ink.opaque, 4) == opaque
    assert ink.background == background
    assert round(ink.background_share, 4) == share


def test_a_flat_field_below_the_floor_is_not_worth_mentioning():
    """A thin margin around edge-to-edge artwork is not a background to remove."""
    def hairline(x, y):
        return (255, 255, 255, 255) if x < 2 or y < 2 or x > 61 or y > 61 else (30, 60, 120, 255)

    ink = profile_pixels(buf(64, 64, hairline), 64, 64)
    assert ink.background == (255, 255, 255)
    assert ink.background_share < MIN_BACKGROUND


# --- the whole thing, on real files ----------------------------------------------

def uri(im: Image.Image, fmt: str = "PNG") -> str:
    b = io.BytesIO()
    if fmt == "JPEG":
        flat = Image.new("RGBA", im.size, (255, 255, 255, 255))
        flat.alpha_composite(im)
        flat.convert("RGB").save(b, "JPEG", quality=88)
        return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()
    im.save(b, "PNG")
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()


def flatten(im: Image.Image, bg=(255, 255, 255, 255)) -> Image.Image:
    out = Image.new("RGBA", im.size, bg)
    out.alpha_composite(im)
    return out


def to_bw(im: Image.Image) -> Image.Image:
    """The same artwork, forced to pure black and white, alpha untouched."""
    out = im.convert("L").point(lambda v: 0 if v < 128 else 255).convert("RGBA")
    out.putalpha(im.getchannel("A"))
    return out


def key_out(im: Image.Image, colour, tol: int = 12) -> Image.Image:
    """Exactly what the warning tells the user to do, so the promise can be checked."""
    out = im.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if all(abs(v - c) <= tol for v, c in zip((r, g, b), colour)):
                px[x, y] = (r, g, b, 0)
    return out


@pytest.fixture(scope="module")
def logo() -> Image.Image:
    return Image.open(Path(__file__).resolve().parents[2] / "assets" / "test-logo.png").convert("RGBA")


def design(src: str, *, scale=0.30, plate=False, mode="classic", rotation=0.0) -> QRSpec:
    return QRSpec.model_validate({
        "content": {"text": URL, "ecLevel": "H"},
        "mode": mode,
        "logo": {"src": src, "scale": scale, "rotation": rotation,
                 "plate": {"enabled": plate}},
    })


def ink_for(spec: QRSpec):
    return logo_ink(spec, matrix_for(spec), load_image(spec.logo.src))


def test_a_logo_that_kept_its_alpha_is_not_warned_about(logo):
    ink = ink_for(design(uri(logo)))
    assert not ink.flat
    assert not ink.removable
    assert ink.message is None


@pytest.mark.parametrize("fmt, bg", [("PNG", (255, 255, 255, 255)), ("PNG", (0, 0, 0, 255))])
def test_a_flattened_logo_is_warned_about(logo, fmt, bg):
    ink = ink_for(design(uri(flatten(logo, bg), fmt)))
    assert ink.flat and ink.removable
    assert ink.modules_background > 0
    assert ink.modules_background < ink.modules_covered
    assert "no transparent background" in ink.message
    assert ink.hex in ink.message


def test_jpeg_quantisation_does_not_hide_the_background(logo):
    """A flat white saved as JPEG is no longer exactly #ffffff. It is still a field."""
    ink = ink_for(design(uri(logo, "JPEG")))
    assert ink.removable
    assert all(v >= 250 for v in ink.background)


def test_full_bleed_artwork_is_never_warned_about(logo):
    """Opaque is the point of art mode, so the advice would be nonsense there."""
    ink = ink_for(design(uri(flatten(logo)), scale=1.0, mode="art"))
    assert ink.flat and ink.background is not None
    assert not ink.removable
    assert ink.message is None


def test_the_plate_changes_the_advice_rather_than_the_facts(logo):
    """With a plate on, keying the logo out on its own gains nothing -- say so."""
    src = uri(flatten(logo))
    off, on = ink_for(design(src, plate=False)), ink_for(design(src, plate=True))
    assert off.modules_background == on.modules_background
    assert "plate" not in off.message
    assert "plate" in on.message


def test_rotation_moves_which_modules_are_covered(logo):
    """The rectangle rotates with the image; counting the unrotated box overstates it."""
    src = uri(flatten(logo))
    straight = ink_for(design(src, rotation=0))
    turned = ink_for(design(src, rotation=30))
    assert straight.modules_covered > 0 and turned.modules_covered > 0
    assert straight.modules_background != turned.modules_background


def test_flattening_costs_more_than_recolouring(logo):
    """The claim the docs rest on, kept honest against the fixture that is committed.

    An earlier fixture was a 79%-ink disc, and on that one converting to pure
    black-and-white cost nothing at all -- which made "tone is not the variable" look
    like a general law rather than a property of a dense mark. It is not. On sparse
    artwork tone does cost something; it is just outweighed by opacity, and that is
    the ordering the warning depends on. Pinned as a comparison rather than as two
    numbers, because the numbers move with the artwork and the ordering does not.
    """
    def largest(im: Image.Image) -> float:
        best = 0.0
        for scale in (round(0.20 + 0.02 * i, 2) for i in range(31)):
            if not reads(design(uri(im), scale=scale), PRODUCTION):
                break
            best = scale
        return best

    alpha = largest(logo)
    tone_cost = alpha - largest(to_bw(logo))
    opacity_cost = alpha - largest(flatten(logo))
    assert opacity_cost > tone_cost, (
        f"opacity {opacity_cost:.2f} no longer outweighs tone {tone_cost:.2f}"
    )


def test_the_advice_is_true(logo):
    """Keying the named colour out lets the decoder read a larger logo.

    The claim the warning makes is about a scanner, so the model does not get to
    settle it. This sweeps the real decoder over both files and compares.
    """
    flat = flatten(logo)
    ink = ink_for(design(uri(flat)))
    assert ink.removable

    def largest(src: str) -> float | None:
        best = None
        for scale in (round(0.30 + 0.02 * i, 2) for i in range(12)):
            if not reads(design(src, scale=scale), PRODUCTION):
                break
            best = scale
        return best

    before = largest(uri(flat))
    after = largest(uri(key_out(flat, ink.background)))
    assert before is not None and after is not None
    assert after > before, f"keying {ink.hex} out did not help: {before} -> {after}"
