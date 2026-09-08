"""Module and finder shapes as SVG path data.

Everything is in module units: module (r, c) occupies [c, c+1] x [r, r+1].

fmt() must produce byte-identical output to the `fmt` in web/src/qr/shapes.ts, or
the parity test cannot diff the two renderers' SVG. That means JS rounding
(floor(x + 0.5), not Python's banker's rounding) and JS number formatting (no
trailing ".0").
"""
import math

Radii = tuple[float, float, float, float]


def fmt(v: float) -> str:
    r = math.floor(v * 1e4 + 0.5) / 1e4
    if r == 0:
        return "0"
    s = repr(r)
    return s[:-2] if s.endswith(".0") else s


def _p(*parts) -> str:
    return " ".join(p if isinstance(p, str) else fmt(p) for p in parts)


def rect_path(x: float, y: float, w: float, h: float) -> str:
    return _p("M", x, y, "h", w, "v", h, "h", -w, "Z")


def circle_path(cx: float, cy: float, r: float) -> str:
    return _p("M", cx - r, cy, "a", r, r, 0, 1, 0, 2 * r, 0, "a", r, r, 0, 1, 0, -2 * r, 0, "Z")


def rounded_path(x: float, y: float, w: float, h: float, radii: Radii) -> str:
    lim = min(w, h) / 2
    a, b, c, d = (min(r, lim) for r in radii)

    def arc(r: float, dx: float, dy: float) -> str:
        return _p("a", r, r, 0, 0, 1, dx, dy) if r > 0 else ""

    parts = [
        _p("M", x + a, y),
        _p("h", w - a - b),
        arc(b, b, b),
        _p("v", h - b - c),
        arc(c, -c, c),
        _p("h", -(w - c - d)),
        arc(d, -d, -d),
        _p("v", -(h - d - a)),
        arc(a, a, -a),
        "Z",
    ]
    return " ".join(p for p in parts if p)


def star_path(cx: float, cy: float, r: float) -> str:
    """Four-pointed star -- the `cross` mark from the original script."""
    w = r * 0.4
    pts = [
        (cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
        (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w),
    ]
    return "M " + " L ".join(f"{fmt(px)} {fmt(py)}" for px, py in pts) + " Z"


def diamond_path(cx: float, cy: float, r: float) -> str:
    return _p("M", cx, cy - r, "L", cx + r, cy, "L", cx, cy + r, "L", cx - r, cy, "Z")


def mark_path(cx: float, cy: float, r: float, shape: str) -> str:
    if shape == "dot":
        return circle_path(cx, cy, r)
    if shape == "square":
        return rect_path(cx - r, cy - r, 2 * r, 2 * r)
    return star_path(cx, cy, r)


def module_path(row: int, col: int, shape: str, gap: float, is_dark) -> str:
    inset = gap / 2
    s = 1 - gap
    x, y = col + inset, row + inset
    cx, cy = col + 0.5, row + 0.5

    if shape == "circle":
        return circle_path(cx, cy, s / 2)
    if shape == "rounded":
        r = 0.35 * s
        return rounded_path(x, y, s, s, (r, r, r, r))
    if shape == "cross":
        return star_path(cx, cy, s / 2)
    if shape == "diamond":
        return diamond_path(cx, cy, s / 2)
    if shape == "connected":
        # Round only the corners whose two neighbours are both empty, so runs of
        # adjacent modules fuse into one continuous blob.
        n, so = is_dark(row - 1, col), is_dark(row + 1, col)
        w, e = is_dark(row, col - 1), is_dark(row, col + 1)
        R = 0.5 * s
        return rounded_path(x, y, s, s, (
            R if not n and not w else 0,
            R if not n and not e else 0,
            R if not so and not e else 0,
            R if not so and not w else 0,
        ))
    return rect_path(x, y, s, s)


def finder_rings(row: int, col: int, shape: str) -> list[str]:
    """The three concentric rings of one finder, outermost first.

    These stay solid in every style. Scanners lock onto the finders before reading
    anything else, and breaking them into loose dots is the single biggest reason
    decorative QR codes fail to scan.
    """
    def ring(inset: float, radius: float) -> str:
        size = 7 - 2 * inset
        if shape == "circle":
            return circle_path(col + 3.5, row + 3.5, size / 2)
        r = radius if shape == "rounded" else 0
        return rounded_path(col + inset, row + inset, size, size, (r, r, r, r))

    return [ring(0, 0.9), ring(1, 0.63), ring(2, 0.45)]
