"""Art mode: decide, per module, whether to draw a solid block, a small mark, or
leave the artwork alone.

A scanner samples the *middle* of each module, so a small mark at each centre
carries the data while the artwork stays visible in between. That is also why
brightness is measured at the module centre rather than averaged over the whole
module -- the edges are exactly the part the scanner ignores.

Mirrors web/src/qr/sampler.ts. When a spec arrives with `art.cells` already filled
in, the browser's decisions are used instead of recomputing these -- see svg.py.
"""
import base64
import binascii
import io

from PIL import Image

from .encode import Matrix
from .geometry import finder_cells, finder_centres, structural_cells
from .spec import DARK_OK, LIGHT_OK, MARK_DARK, MARK_LIGHT, SKIP, SOLID_DARK, SOLID_LIGHT, QRSpec
from .svg import canvas_size, logo_rect

#: Samples per module edge. 3 keeps the centre third addressable, as in the original.
SAMPLE_RES = 3
#: Modules of breathing room around each finder disc.
FINDER_GAP = 0.5


def load_image(src: str) -> Image.Image:
    """Decode a data: URI or a filesystem path into RGBA."""
    if src.startswith("data:"):
        try:
            _, b64 = src.split(",", 1)
        except ValueError as e:
            raise ValueError("malformed data URI") from e
        try:
            raw = base64.b64decode(b64)
        except (binascii.Error, ValueError) as e:
            raise ValueError("logo is not valid base64") from e
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    return Image.open(src).convert("RGBA")


def _place(spec: QRSpec, matrix: Matrix, img: Image.Image, background) -> Image.Image:
    """The artwork composited onto a SAMPLE_RES-per-module canvas."""
    total = canvas_size(matrix.size, spec.canvas.quiet_zone)
    px = total * SAMPLE_RES
    base = Image.new("RGBA", (px, px), background)
    rect = logo_rect(spec, matrix.size, (img.width / img.height) if img.height else 1.0)
    if rect:
        x, y, w, h = rect
        scaled = img.resize(
            (max(1, round(w * SAMPLE_RES)), max(1, round(h * SAMPLE_RES))), Image.LANCZOS
        )
        base.alpha_composite(scaled, (round(x * SAMPLE_RES), round(y * SAMPLE_RES)))
    return base


def sample_luminance(spec: QRSpec, matrix: Matrix, img: Image.Image, light: str):
    """Luminance under every module. `light` is what shows through transparent art."""
    base = _place(spec, matrix, img, light)
    flat = Image.new("RGB", base.size, light)
    flat.paste(base, (0, 0), base)
    return flat.convert("L").load(), base.size[0]


def decide_cells(spec: QRSpec, matrix: Matrix, lum=None, width: int = 0) -> bytes:
    """Per-module draw decisions, row-major over the code area."""
    size, qz = matrix.size, spec.canvas.quiet_zone
    skip = finder_cells(size)
    solid = set() if spec.art.loose else structural_cells(matrix.version)

    out = bytearray(size * size)
    for r in range(size):
        for c in range(size):
            i = r * size + c
            if (r, c) in skip:
                out[i] = SKIP  # finders are drawn as rings, separately
                continue
            dark = matrix.get(r, c)
            if (r, c) in solid:
                out[i] = SOLID_DARK if dark else SOLID_LIGHT
                continue
            if lum is None:
                out[i] = MARK_DARK if dark else SKIP
                continue
            L = lum[(c + qz) * SAMPLE_RES + 1, (r + qz) * SAMPLE_RES + 1]
            if dark and L > DARK_OK:
                out[i] = MARK_DARK
            elif not dark and L < LIGHT_OK:
                out[i] = MARK_LIGHT
            else:
                out[i] = SKIP  # the artwork already reads correctly here
    return bytes(out)


def finder_clearance(spec: QRSpec, matrix: Matrix, img: Image.Image) -> list[bool]:
    """Whether each finder disc is free of opaque artwork.

    Tested against the alpha channel rather than the bounding box, so a round logo
    is not punished for its corners.
    """
    base = _place(spec, matrix, img, (0, 0, 0, 0))
    alpha = base.getchannel("A").load()
    px = base.size[0]
    qz = spec.canvas.quiet_zone
    out = []
    for cx, cy in finder_centres(matrix.size):
        dx, dy = (cx + qz) * SAMPLE_RES, (cy + qz) * SAMPLE_RES
        rad = 3.5 * SAMPLE_RES
        clear = True
        for y in range(max(0, int(dy - rad)), min(px, int(dy + rad) + 1)):
            for x in range(max(0, int(dx - rad)), min(px, int(dx + rad) + 1)):
                if alpha[x, y] <= 16:
                    continue
                if (x + 0.5 - dx) ** 2 + (y + 0.5 - dy) ** 2 <= rad * rad:
                    clear = False
                    break
            if not clear:
                break
        out.append(clear)
    return out


def fit_clear_of_finders(spec: QRSpec, matrix: Matrix, img: Image.Image) -> float:
    """Largest artwork scale whose opaque pixels stay clear of the finder discs.

    Binary search on scale, testing alpha against the three finder circles -- so a
    round logo can stay large where a square one has to shrink. Port of
    `_fit_clear_of_finders` from the original script.
    """
    if spec.logo is None:
        return 1.0
    qz = spec.canvas.quiet_zone
    discs = [
        ((cx + qz) * SAMPLE_RES, (cy + qz) * SAMPLE_RES, ((3.5 + FINDER_GAP) * SAMPLE_RES) ** 2)
        for cx, cy in finder_centres(matrix.size)
    ]

    def hits(scale: float) -> bool:
        probe = spec.model_copy(deep=True)
        probe.logo.scale = scale
        base = _place(probe, matrix, img, (0, 0, 0, 0))
        alpha = base.getchannel("A").load()
        px = base.size[0]
        for dx, dy, r2 in discs:
            rad = (3.5 + FINDER_GAP) * SAMPLE_RES
            for y in range(max(0, int(dy - rad)), min(px, int(dy + rad) + 1)):
                for x in range(max(0, int(dx - rad)), min(px, int(dx + rad) + 1)):
                    if alpha[x, y] <= 16:
                        continue
                    if (x + 0.5 - dx) ** 2 + (y + 0.5 - dy) ** 2 <= r2:
                        return True
        return False

    wanted = spec.logo.scale
    if not hits(wanted):
        return wanted
    lo, hi = 0.05, wanted
    for _ in range(14):
        mid = (lo + hi) / 2
        if hits(mid):
            hi = mid
        else:
            lo = mid
    return lo
