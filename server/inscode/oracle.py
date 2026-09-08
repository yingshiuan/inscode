"""What a decoder actually does with the finished image. The authority, not a model.

`audit.py` models what a decoder should be able to recover. Models drift from reality
quietly, so nothing this project ships as a safety claim rests on the model alone: the
model proposes, and a real decoder disposes.

Two things are deliberately not constants here:

  * **The profile.** A perfect vector rasterisation decodes at 1.35 px/module, which no
    camera will manage, so the verdict is taken from a degraded render rather than a
    clean one. Which degradation is a question about the product, not the code, so it
    is a value you pass in.
  * **The decoder.** zxing-cpp is not zxing-wasm is not the iPhone -- and the finding
    that started this work was an iPhone reading a code the tool called dead. Adding a
    second opinion should mean writing a `Decoder`, not editing this file.

Shared with server/tests/harness.py, which sweeps the same profiles across a matrix of
damaged designs to calibrate the model against.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Callable, Protocol, Sequence

from PIL import Image, ImageEnhance, ImageFilter

from .raster import render as rasterise
from .render import build_svg
from .spec import QRSpec

#: A safety decision: given a design, can the configured decoder read it?
Oracle = Callable[[QRSpec], bool]


class Decoder(Protocol):
    """Anything that can be asked to read a picture of a QR code."""

    name: str
    version: str

    def read(self, image: Image.Image) -> list[str]:
        ...


class ZXingCpp:
    """The initial oracle. Note it binarises locally by default, where
    `audit.estimate_black_point` is a global histogram -- a known difference, and one
    the calibration dataset exists to quantify."""

    name = "zxing-cpp"

    def __init__(self) -> None:
        import importlib.metadata as md

        self.version = md.version("zxing-cpp")

    def read(self, image: Image.Image) -> list[str]:
        import zxingcpp

        return [r.text for r in zxingcpp.read_barcodes(image)]


@dataclass(frozen=True)
class Profile:
    """How a finished code is presented to a decoder: a size, and the ways a real read
    is worse than a render.

    Sized in pixels per *module*, never pixels: 200px is generous for a version-2 code
    and hopeless for a version-25 one.

    One definition, used for the production safety verdict here, for `validate.py`'s
    legibility ladder, and for the calibration sweep in the harness -- three callers
    that would otherwise each carry their own copy of the same PIL work. Mirrored in
    web/src/qr/oracle.ts, where the browser implements the subset it needs.
    """

    name: str
    px_per_module: float
    blur: float = 0.0
    #: PIL contrast factor. 1.0 leaves it alone; below that flattens it.
    contrast: float = 1.0
    rotate: float = 0.0
    #: Re-encode as JPEG at this quality first, for compression artefacts.
    jpeg_quality: int | None = None
    #: Resample down to this fraction and back, for a code that has been scaled about.
    downscale: float = 1.0

    def apply(self, image: Image.Image) -> Image.Image:
        if self.downscale != 1.0:
            small = (max(1, int(image.width * self.downscale)),) * 2
            image = image.resize(small, Image.LANCZOS).resize(image.size, Image.LANCZOS)
        if self.blur:
            image = image.filter(ImageFilter.GaussianBlur(self.blur))
        if self.contrast != 1.0:
            image = ImageEnhance.Contrast(image).enhance(self.contrast)
        if self.rotate:
            image = image.rotate(self.rotate, expand=True, fillcolor="white")
        if self.jpeg_quality is not None:
            buf = io.BytesIO()
            image.convert("RGB").save(buf, "JPEG", quality=self.jpeg_quality)
            image = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
        return image


#: The verdict the product stands behind: a code filling a phone screen at arm's
#: length, slightly out of focus, on a screen or print that is not quite black on not
#: quite white. Every undamaged symbol from version 1 to 20 survives it, so a failure
#: here is about the design rather than about the profile being unfair.
PRODUCTION = Profile(name="phone", px_per_module=4.0, blur=1.6, contrast=0.7)

#: Recorded alongside as a diagnostic, never used as the verdict.
CLEAN = Profile(name="clean", px_per_module=6.0)

#: Profiles the harness supports but does not sweep by default; each one multiplies
#: the dataset, so they are opt-in until a question needs them.
EXTRA_PROFILES = (
    Profile(name="print-small", px_per_module=2.5, blur=0.8, contrast=0.85),
    Profile(name="jpeg", px_per_module=4.0, blur=1.0, jpeg_quality=45),
    Profile(name="tilted", px_per_module=4.0, blur=1.2, rotate=12.0),
    Profile(name="downscaled", px_per_module=4.0, downscale=0.55),
)


def present(svg: str, modules: int, profile: Profile) -> Image.Image:
    """A drawn design as a decoder will receive it. `modules` includes the quiet zone."""
    px = max(32, round(modules * profile.px_per_module))
    # Matte white: a transparent code is read against whatever it is placed on, and
    # white is the honest best case for that.
    data, _ = rasterise(svg, "png", px=px, matte="#ffffff")
    return profile.apply(Image.open(io.BytesIO(data)).convert("RGB"))


def render_for(spec: QRSpec, profile: Profile, *, svg: str | None = None) -> Image.Image:
    """The same, from a spec rather than a drawing."""
    from .encode import matrix_for

    modules = matrix_for(spec).size + 2 * spec.canvas.quiet_zone
    return present(svg if svg is not None else build_svg(spec), modules, profile)


def reads(
    spec: QRSpec,
    profile: Profile = PRODUCTION,
    decoders: Sequence[Decoder] | None = None,
) -> bool:
    """Does every configured decoder recover the payload from the finished image?

    Every, not any: a design is only safe if nothing we can ask disagrees. With one
    decoder configured this is just that decoder, but the rule is what makes adding a
    second opinion tighten the answer rather than muddy it.
    """
    decoders = decoders if decoders is not None else default_decoders()
    try:
        image = render_for(spec, profile)
    except Exception:
        return False  # a design that cannot be rendered cannot be read
    expected = spec.content.text
    return all(expected in decoder.read(image) for decoder in decoders)


def default_decoders() -> list[Decoder]:
    return [ZXingCpp()]


def decoder_oracle(
    profile: Profile = PRODUCTION, decoders: Sequence[Decoder] | None = None
) -> Oracle:
    """An `Oracle` bound to a profile and a decoder set."""
    resolved = list(decoders) if decoders is not None else default_decoders()
    return lambda spec: reads(spec, profile, resolved)
