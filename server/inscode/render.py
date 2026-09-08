"""One place that turns a QRSpec into pixels, shared by the API and the CLI.

`spec.encoded` and `spec.art.cells` are honoured when the browser sent them, so a
render here reproduces exactly what the preview showed. When they are absent -- a
plain API call, or the CLI -- they are derived here instead.
"""
from .encode import matrix_for
from .raster import render as rasterise
from .sampler import (
    decide_cells,
    finder_clearance,
    fit_clear_of_finders,
    load_image,
    sample_luminance,
)
from .spec import QRSpec
from .svg import decode_cells, render_svg


def build_svg(spec: QRSpec) -> str:
    matrix = matrix_for(spec)
    cells = None
    finder_clear = None
    aspect = 1.0

    img = load_image(spec.logo.src) if spec.logo else None
    if img is not None:
        aspect = (img.width / img.height) if img.height else 1.0

    if spec.mode == "art":
        if img is not None and spec.art.clear_finders:
            spec = spec.model_copy(deep=True)
            spec.logo.scale = min(spec.logo.scale, fit_clear_of_finders(spec, matrix, img))
        if spec.art.cells:
            # Authoritative: the browser already decided these against the artwork.
            cells = decode_cells(spec.art.cells, matrix.size * matrix.size)
        elif img is not None:
            lum, _ = sample_luminance(spec, matrix, img, spec.canvas.bg or "#ffffff")
            cells = decide_cells(spec, matrix, lum)
        else:
            cells = decide_cells(spec, matrix, None)
        finder_clear = finder_clearance(spec, matrix, img) if img is not None else [True] * 3

    return render_svg(spec, matrix, cells=cells, logo_aspect=aspect, finder_clear=finder_clear)


def render_spec(spec: QRSpec, fmt: str = "png", px: int = 1024, matte: str | None = None):
    """Returns (bytes, mime type)."""
    return rasterise(build_svg(spec), fmt, px=px, matte=matte)
