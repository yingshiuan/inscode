"""QRSpec -> SVG.

Mirrors web/src/qr/renderSvg.ts element for element -- same order, same attributes,
same number formatting -- so tests/test_parity.py can diff the two renderers' output
as strings. Change both together.

Raster output is produced by rasterising this SVG, so PNG and SVG are the same
drawing rather than two drawings that happen to look alike.
"""
import base64

from .encode import Matrix
from .geometry import finder_boxes, finder_cells, structural_cells
from .shapes import finder_rings, fmt, mark_path, module_path, rect_path, rounded_path
from .spec import MARK_DARK, MARK_LIGHT, SKIP, SOLID_DARK, SOLID_LIGHT, QRSpec


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")


def canvas_size(size: int, quiet_zone: int) -> int:
    return size + 2 * quiet_zone


def logo_rect(spec: QRSpec, size: int, aspect: float):
    """Artwork rectangle in module units. Mirrors layout.ts `logoRect`."""
    if spec.logo is None:
        return None
    qz = spec.canvas.quiet_zone
    longest = spec.logo.scale * size
    w = longest if aspect >= 1 else longest * aspect
    h = longest / aspect if aspect >= 1 else longest
    return (qz + spec.logo.x * size - w / 2, qz + spec.logo.y * size - h / 2, w, h)


def _image_tag(spec: QRSpec, rect, extra: str = "") -> str:
    x, y, w, h = rect
    rot = spec.logo.rotation
    t = f' transform="rotate({fmt(rot)} {fmt(x + w / 2)} {fmt(y + h / 2)})"' if rot else ""
    return (
        f'<image href="{_esc(spec.logo.src)}" x="{fmt(x)}" y="{fmt(y)}" '
        f'width="{fmt(w)}" height="{fmt(h)}" preserveAspectRatio="none"{t}{extra}/>'
    )


def _modules_path(spec: QRSpec, matrix: Matrix) -> str:
    qz = spec.canvas.quiet_zone
    skip = finder_cells(matrix.size)
    parts = []
    for r in range(matrix.size):
        for c in range(matrix.size):
            if not matrix.get(r, c) or (r, c) in skip:
                continue
            parts.append(
                module_path(
                    r + qz, c + qz, spec.modules.shape, spec.modules.gap,
                    lambda rr, cc: matrix.get(rr - qz, cc - qz),
                )
            )
    return " ".join(parts)


def _finders_path(spec: QRSpec, matrix: Matrix) -> str:
    qz = spec.canvas.quiet_zone
    parts = []
    for row, col in finder_boxes(matrix.size):
        parts.extend(finder_rings(row + qz, col + qz, spec.finders.shape))
    return " ".join(parts)


def _art_paths(spec: QRSpec, matrix: Matrix, cells) -> tuple[str, str]:
    qz = spec.canvas.quiet_zone
    r = spec.art.mark_size / 2
    dark, light = [], []
    for row in range(matrix.size):
        for col in range(matrix.size):
            kind = cells[row * matrix.size + col]
            if kind == SKIP:
                continue
            R, C = row + qz, col + qz
            if kind == SOLID_DARK:
                dark.append(rect_path(C, R, 1, 1))
            elif kind == SOLID_LIGHT:
                light.append(rect_path(C, R, 1, 1))
            else:
                p = mark_path(C + 0.5, R + 0.5, r, spec.art.mark)
                (dark if kind == MARK_DARK else light).append(p)
    return " ".join(dark), " ".join(light)


def decode_cells(b64: str, count: int) -> bytes:
    """Inverse of the TS `encodeCells`: (kind, run) byte pairs."""
    raw = base64.b64decode(b64)
    out = bytearray()
    for i in range(0, len(raw) - 1, 2):
        out.extend(bytes([raw[i]]) * raw[i + 1])
    if len(out) < count:
        raise ValueError(f"art.cells covers {len(out)} modules, expected {count}")
    return bytes(out[:count])


def render_svg(
    spec: QRSpec,
    matrix: Matrix,
    *,
    cells=None,
    logo_aspect: float = 1.0,
    finder_clear=None,
    with_pixel_size: bool = False,
) -> str:
    qz = spec.canvas.quiet_zone
    total = canvas_size(matrix.size, qz)
    transparent = spec.canvas.bg is None
    #: What shows through where nothing is drawn. Transparent exports assume white.
    light = spec.canvas.bg or "#ffffff"
    fg = spec.modules.color
    finder_fill = spec.finders.color or fg

    defs: list[str] = []
    body: list[str] = []

    if not transparent:
        body.append(f'<rect width="{fmt(total)}" height="{fmt(total)}" fill="{spec.canvas.bg}"/>')

    l_rect = logo_rect(spec, matrix.size, logo_aspect) if spec.logo else None

    if spec.mode == "art":
        if cells is None:
            raise ValueError("art mode needs sampled cells")
        dark_path, light_path = _art_paths(spec, matrix, cells)

        # On a transparent background a light module is cut out of the artwork
        # rather than painted over, so whatever the code sits on supplies the light.
        if l_rect:
            if transparent and light_path:
                defs.append(
                    f'<mask id="qr-art"><rect width="{fmt(total)}" height="{fmt(total)}" fill="#fff"/>'
                    f'<path fill="#000" d="{light_path}"/></mask>'
                )
            body.append(_image_tag(spec, l_rect, ' mask="url(#qr-art)"' if transparent and light_path else ""))

        # Artwork showing through a finder's middle ring reads as a dark module, so
        # cover it -- but only where artwork actually reaches, or a transparent
        # export grows three opaque discs it does not need.
        clear = finder_clear or [True, True, True]
        backdrops = " ".join(
            rect_path(col + qz, row + qz, 7, 7)
            for i, (row, col) in enumerate(finder_boxes(matrix.size))
            if not clear[i]
        )
        if backdrops:
            body.append(f'<path fill="{light}" d="{backdrops}"/>')

        if not transparent and light_path:
            body.append(f'<path fill="{light}" d="{light_path}"/>')
        if dark_path:
            body.append(f'<path fill="{fg}" d="{dark_path}"/>')
    else:
        # Classic: the plate is a painted rounded rect whenever it has a colour to
        # paint -- the common case, needing no <mask> at all. Only a transparent
        # plate has to actually punch a hole through the modules.
        plate = None
        if l_rect and spec.logo.plate.enabled:
            pad = spec.logo.plate.pad
            plate = (l_rect[0] - pad, l_rect[1] - pad, l_rect[2] + 2 * pad, l_rect[3] + 2 * pad)
        plate_fill = spec.logo.plate.color if spec.logo and spec.logo.plate.color else spec.canvas.bg
        mask_attr = ""
        plate_path = ""
        if plate:
            px_, py_, pw, ph = plate
            r = min(pw, ph) * spec.logo.plate.radius
            plate_path = rounded_path(px_, py_, pw, ph, (r, r, r, r))
            if plate_fill is None:
                defs.append(
                    f'<mask id="qr-plate"><rect width="{fmt(total)}" height="{fmt(total)}" fill="#fff"/>'
                    f'<path fill="#000" d="{plate_path}"/></mask>'
                )
                mask_attr = ' mask="url(#qr-plate)"'

        body.append(f"<g{mask_attr}>")
        body.append(f'<path fill="{fg}" d="{_modules_path(spec, matrix)}"/>')
        body.append(f'<path fill="{finder_fill}" fill-rule="evenodd" d="{_finders_path(spec, matrix)}"/>')
        body.append("</g>")

        if plate_path and plate_fill is not None:
            body.append(f'<path fill="{plate_fill}" d="{plate_path}"/>')

        if l_rect:
            body.append(_image_tag(spec, l_rect))

    if spec.mode == "art":
        body.append(f'<path fill="{finder_fill}" fill-rule="evenodd" d="{_finders_path(spec, matrix)}"/>')

    px = fmt(total * spec.canvas.module_size)
    size_attrs = f' width="{px}" height="{px}"' if with_pixel_size else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(total)} {fmt(total)}"'
        f'{size_attrs} shape-rendering="geometricPrecision">'
        + (f"<defs>{''.join(defs)}</defs>" if defs else "")
        + "".join(body)
        + "</svg>"
    )
