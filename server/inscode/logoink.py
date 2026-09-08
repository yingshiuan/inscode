"""Is the logo damaging the code with its artwork, or with its own background?

A logo covers modules over its whole bounding *rectangle*, not just where its ink
is. So the same mark costs very different amounts depending on how it was exported:
keep the alpha channel and only the artwork lands on the code; flatten it onto white
and the empty corners of the box damage modules exactly as the ink does.

Measured on one design -- the same artwork, the same size, the same payload, only
the file changing:

    logo file                                largest logo a decoder still reads
    colour, alpha preserved                  0.52
    same artwork forced to black-and-white   0.52   <- tone costs nothing
    colour, alpha flattened onto white       0.46
    black-and-white, flattened onto white    0.46
    flattened onto black                     0.42

Tone is not the variable; opacity is. That matters because it is invisible in the
preview -- a flattened white background looks like nothing at all against a white
canvas, while quietly holding the safe logo size down. The design just gets a
smaller `estimatedSafeScale` and the user is given no reason why.

This module supplies the reason. It reports what share of the artwork is a flat
opaque field, and how many of the modules the logo covers are that field rather
than ink -- the modules that keying the background out would give straight back.

Mirrors web/src/qr/logoInk.ts. `profile_pixels` is the parity-tested half: pure
integer work over an RGBA buffer, identical in both languages. The half above it
decodes and scales the image with each side's own machinery -- PIL here, a canvas
there -- so the two agree on verdicts rather than on pixels, as in audit.py.
"""
import io
import math
from dataclasses import dataclass

from PIL import Image

from .encode import Matrix
from .spec import QRSpec
from .svg import logo_rect

#: Alpha at or below this counts as transparent. Matches the clearance tests in
#: sampler.py, so "opaque" means the same thing everywhere in the codebase.
ALPHA_INK = 16

#: Samples per edge when profiling the artwork. Bounded so a 4000px logo costs no
#: more than a 200px one, and fixed so both languages sample the same grid.
PROFILE_GRID = 96

#: Samples at each edge of that grid taken as "the border". Three deep, because a
#: one-pixel ring catches JPEG ringing and a matted edge; three does not.
BORDER_BAND = 3

#: Per-channel distance within which two colours are the same flat field. Wide
#: enough for JPEG's quantisation of a solid area, far short of any real artwork.
TONE_TOLERANCE = 12

#: Share of the border that must be opaque before a flat background is even possible.
#: Below it the artwork already has a cutout, and there is nothing to key out.
BORDER_OPAQUE = 0.9

#: Share of the *opaque* border that must be one colour before it is called the
#: background. Not near-1.0: artwork routinely bleeds into the edge of its own box --
#: the reference logo puts ink in 24% of its border and is still a mark on a field.
BORDER_DOMINANCE = 0.6

#: Above this opaque share the artwork has no usable transparency at all. Not 1.0:
#: a "transparent" PNG that has been through a matting step often keeps a handful
#: of stray alpha pixels, and those do not make it a cutout.
FLAT_ALPHA = 0.98

#: Below this there is not enough background to be worth saying anything about.
MIN_BACKGROUND = 0.15

#: Longest edge the artwork is reduced to before sampling. The grid above is coarser
#: than this, so the reduction costs nothing and bounds the memory both sides hold.
PROFILE_MAX = 512


@dataclass(frozen=True)
class Ink:
    """What the artwork is made of, before any question about the code."""

    #: Share of the bounding box that is opaque.
    opaque: float
    #: The flat field the border sits on, if there is one.
    background: tuple[int, int, int] | None
    #: Share of the bounding box that is that flat field.
    background_share: float


def sample_axis(n: int, extent: int) -> list[int]:
    """`n` evenly spaced pixel indices across `extent`, at the centre of each cell.

    Integer arithmetic, so the browser picks the same pixels rather than nearly the
    same ones -- the difference is invisible until a parity test disagrees by one.
    """
    return [((2 * i + 1) * extent) // (2 * n) for i in range(n)]


def profile_pixels(rgba: bytes, w: int, h: int, grid: int = PROFILE_GRID) -> Ink:
    """Opacity and flat-background analysis of an RGBA buffer.

    The parity-tested half: no image library, no floats that depend on a resampler,
    nothing that differs between Python and a browser given the same bytes.

    A background is only claimed when the border agrees with itself. That guard is
    what keeps a photograph -- which has no flat field to key out, and where the
    advice would be wrong -- from being reported as one.
    """
    n = min(grid, w, h)
    if n <= 0:
        return Ink(opaque=0.0, background=None, background_share=0.0)

    xs, ys = sample_axis(n, w), sample_axis(n, h)
    px = [
        tuple(rgba[(y * w + x) * 4 : (y * w + x) * 4 + 4])
        for y in ys
        for x in xs
    ]

    total = n * n
    opaque = sum(1 for p in px if p[3] > ALPHA_INK)

    # The border, three samples deep on every side.
    band = min(BORDER_BAND, n)
    edge = [
        px[r * n + c]
        for r in range(n)
        for c in range(n)
        if r < band or r >= n - band or c < band or c >= n - band
    ]
    solid = [p for p in edge if p[3] > ALPHA_INK]
    if not solid or len(solid) < BORDER_OPAQUE * len(edge):
        # A border that is partly transparent is already a cutout. Nothing to key.
        return Ink(opaque=opaque / total, background=None, background_share=0.0)

    # Modal colour of the border, bucketed to absorb compression noise.
    buckets: dict[tuple[int, int, int], list[int]] = {}
    for r, g, b, _ in solid:
        buckets.setdefault((r >> 3, g >> 3, b >> 3), [0, 0, 0, 0])
    for r, g, b, _ in solid:
        acc = buckets[(r >> 3, g >> 3, b >> 3)]
        acc[0] += 1
        acc[1] += r
        acc[2] += g
        acc[3] += b
    key = max(buckets, key=lambda k: (buckets[k][0], k))
    count, sr, sg, sb = buckets[key]
    if count < BORDER_DOMINANCE * len(solid):
        # Two or more tones share the border: this is artwork running to the edge,
        # not a mark sitting on a field. Keying one of them out is not the advice.
        return Ink(opaque=opaque / total, background=None, background_share=0.0)

    bg = (sr // count, sg // count, sb // count)
    share = sum(1 for p in px if p[3] > ALPHA_INK and is_tone(p, bg)) / total
    return Ink(opaque=opaque / total, background=bg, background_share=share)


def is_tone(pixel, colour: tuple[int, int, int]) -> bool:
    """Whether an opaque pixel belongs to a flat field of `colour`."""
    return all(abs(pixel[i] - colour[i]) <= TONE_TOLERANCE for i in range(3))


@dataclass(frozen=True)
class LogoInk:
    """The artwork profile, and what it costs this particular code."""

    opaque: float
    background: tuple[int, int, int] | None
    background_share: float
    #: Module centres that fall under the artwork rectangle.
    modules_covered: int
    #: Those that land on the flat background rather than on ink -- the ones a
    #: transparent export would hand straight back to the code.
    modules_background: int
    #: Set when a plate is already clearing these modules, which changes the advice:
    #: keying the logo out gains nothing until the plate is off too.
    plate: bool
    #: Full-bleed artwork is *meant* to be opaque, so it is never warned about.
    art: bool

    @property
    def flat(self) -> bool:
        """No usable transparency: the whole bounding box lands on the code."""
        return self.opaque >= FLAT_ALPHA

    @property
    def removable(self) -> bool:
        """Whether there is a flat background worth telling the user about."""
        return (
            not self.art
            and self.flat
            and self.background is not None
            and self.background_share >= MIN_BACKGROUND
            and self.modules_background > 0
        )

    @property
    def hex(self) -> str | None:
        return None if self.background is None else "#%02x%02x%02x" % self.background

    @property
    def message(self) -> str | None:
        """The warning, or None when the artwork is not costing anything avoidable."""
        if not self.removable:
            return None
        n, m = self.modules_background, self.modules_covered
        if self.plate:
            return (
                f"This logo has no transparent background — but the plate is clearing "
                f"those modules anyway. Turn the plate off and key out the flat "
                f"{self.hex} to give {n} of them back to the code."
            )
        return (
            f"This logo has no transparent background: {n} of the {m} modules it "
            f"covers are flat {self.hex}, not artwork. Keying that out would give "
            f"them back to the code."
        )

    def as_dict(self) -> dict:
        return {
            "opaque": round(self.opaque, 4),
            "background": self.hex,
            "backgroundShare": round(self.background_share, 4),
            "modulesCovered": self.modules_covered,
            "modulesBackground": self.modules_background,
            "plate": self.plate,
            "flat": self.flat,
            "removable": self.removable,
            "message": self.message,
        }


def _reduced(img: Image.Image) -> Image.Image:
    """The artwork at no more than PROFILE_MAX on its long edge, in RGBA."""
    longest = max(img.width, img.height)
    if longest <= PROFILE_MAX:
        return img.convert("RGBA")
    s = PROFILE_MAX / longest
    return img.convert("RGBA").resize(
        (max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS
    )


def logo_ink(spec: QRSpec, matrix: Matrix, img: Image.Image) -> LogoInk | None:
    """Profile the logo, and count what it costs this code in modules.

    The module count is taken at module *centres*, because that is where a decoder
    reads and where audit.py binarises -- a module whose centre sits on flat
    background is a module the background is spending, and the one a cutout returns.
    """
    if spec.logo is None:
        return None

    aspect = (img.width / img.height) if img.height else 1.0
    small = _reduced(img)
    ink = profile_pixels(small.tobytes(), small.width, small.height)

    covered = background = 0
    rect = logo_rect(spec, matrix.size, aspect)
    if rect is not None:
        px = small.load()
        for u, v in covered_centres(spec, matrix.size, rect):
            x = min(small.width - 1, int(u * small.width))
            y = min(small.height - 1, int(v * small.height))
            pixel = px[x, y]
            if pixel[3] <= ALPHA_INK:
                continue  # transparent here: this module is not covered at all
            covered += 1
            if ink.background is not None and is_tone(pixel, ink.background):
                background += 1

    return LogoInk(
        opaque=ink.opaque,
        background=ink.background,
        background_share=ink.background_share,
        modules_covered=covered,
        modules_background=background,
        plate=spec.mode == "classic" and spec.logo.plate.enabled,
        art=spec.mode == "art",
    )


def covered_centres(spec: QRSpec, size: int, rect):
    """Module centres under the artwork, with where each lands inside it, 0..1.

    Rotation is undone about the rectangle's centre rather than ignored: the SVG
    rotates the image, so a rotated logo covers a different set of modules and
    counting the unrotated box would quietly overstate the damage.
    """
    x0, y0, w, h = rect
    if w <= 0 or h <= 0:
        return
    qz = spec.canvas.quiet_zone
    cx, cy = x0 + w / 2, y0 + h / 2
    a = math.radians(-spec.logo.rotation) if spec.logo.rotation else 0.0
    cos_a, sin_a = math.cos(a), math.sin(a)

    for r in range(size):
        for c in range(size):
            mx, my = c + qz + 0.5, r + qz + 0.5
            if a:
                dx, dy = mx - cx, my - cy
                mx, my = cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a
            u, v = (mx - x0) / w, (my - y0) / h
            if 0.0 <= u < 1.0 and 0.0 <= v < 1.0:
                yield u, v
