"""SVG -> PNG / JPEG / PDF.

Raster output is a rasterisation of the same SVG the browser previews, so a print
-resolution PNG cannot drift from what was on screen -- there is only ever one
drawing.
"""
import io

import resvg_py
from PIL import Image

FORMATS = ("svg", "png", "jpg", "jpeg")

# resvg rather than cairosvg: cairosvg silently ignores <mask> and <clip-path>,
# which this renderer relies on for a transparent logo plate and for cutting light
# modules out of full-bleed artwork. A rasteriser that drops those produces an
# image that does not match the browser preview -- and, worse, one that does not
# scan. resvg implements them, so PNG matches SVG.


def _png(svg: str, px: int) -> bytes:
    # resvg honours width/height on the root, so size is set there rather than
    # through a separate scaling argument.
    sized = svg.replace("<svg ", f'<svg width="{px}" height="{px}" ', 1)
    return bytes(resvg_py.svg_to_bytes(svg_string=sized))


def render(svg: str, fmt: str, *, px: int = 1024, matte: str | None = None) -> tuple[bytes, str]:
    """Returns (bytes, mime type)."""
    fmt = fmt.lower()
    if fmt == "svg":
        return svg.encode("utf-8"), "image/svg+xml"

    png = _png(svg, px)

    if fmt == "png":
        if matte:
            img = Image.open(io.BytesIO(png)).convert("RGBA")
            flat = Image.new("RGBA", img.size, matte)
            flat.alpha_composite(img)
            buf = io.BytesIO()
            flat.convert("RGB").save(buf, "PNG")
            return buf.getvalue(), "image/png"
        return png, "image/png"

    # JPEG has no alpha, so a transparent design has to be flattened onto something.
    # White is the honest default rather than a silent black.
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    flat = Image.new("RGBA", img.size, matte or "#ffffff")
    flat.alpha_composite(img)
    buf = io.BytesIO()
    flat.convert("RGB").save(buf, "JPEG", quality=95)
    return buf.getvalue(), "image/jpeg"
