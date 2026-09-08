"""Pydantic mirror of web/src/qr/spec.ts -- the contract both renderers speak.

`encoded` and `art.cells` are optional and *authoritative when present*: they carry
the browser's own encode and sampling results so this renderer draws exactly what
the preview showed, rather than re-deriving them and risking a different (still
valid, but visibly different) answer. Absent, we compute them here, which is what
makes POST /api/render usable straight from curl.
"""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

EC_LEVELS = ("L", "M", "Q", "H")
MODULE_SHAPES = ("square", "circle", "rounded", "cross", "diamond", "connected")
FINDER_SHAPES = ("square", "rounded", "circle")
MARK_SHAPES = ("cross", "dot", "square")

# A dark module needs no help if the art beneath it is already darker than DARK_OK;
# a light module is fine if the art is lighter than LIGHT_OK. Between the two, a
# mark is painted so the scanner reads the right value.
# Shared with web/src/qr/spec.ts -- change both together.
DARK_OK, LIGHT_OK = 90, 165

# Art-mode per-module decisions.
SKIP, SOLID_DARK, SOLID_LIGHT, MARK_DARK, MARK_LIGHT = 0, 1, 2, 3, 4

Color = str


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Encoded(Base):
    version: int = Field(ge=1, le=40)
    mask_pattern: int = Field(ge=0, le=7, alias="maskPattern")
    size: int = Field(ge=21, le=177)
    #: Row-major bit-packed matrix, MSB first, base64. size*size bits.
    bits: str

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class Plate(Base):
    enabled: bool = True
    #: Padding around the logo, in modules.
    pad: float = Field(default=0.7, ge=0)
    #: Corner radius as a fraction of the plate's shorter edge.
    radius: float = Field(default=0.18, ge=0, le=0.5)
    #: None follows the canvas background, including transparent.
    color: Color | None = None


class Logo(Base):
    #: data: URI. Never a remote URL -- exports must stay self-contained.
    src: str
    x: float = 0.5
    y: float = 0.5
    #: Longest edge as a fraction of the code width. One model for both modes.
    scale: float = Field(default=0.22, ge=0.01, le=1)
    rotation: float = 0.0
    plate: Plate = Plate()


class Content(Base):
    text: str = ""
    ec_level: Literal["L", "M", "Q", "H"] = Field(default="H", alias="ecLevel")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class Canvas(Base):
    #: Quiet zone in modules. The spec requires 4; below that scanners get flaky.
    quiet_zone: int = Field(default=4, ge=0, le=16, alias="quietZone")
    #: Pixels per module at export scale 1.
    module_size: float = Field(default=20, gt=0, le=200, alias="moduleSize")
    #: None = transparent.
    bg: Color | None = "#ffffff"
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class Modules(Base):
    shape: Literal[MODULE_SHAPES] = "square"  # type: ignore[valid-type]
    gap: float = Field(default=0.0, ge=0, le=0.5)
    color: Color = "#000000"


class Finders(Base):
    shape: Literal[FINDER_SHAPES] = "square"  # type: ignore[valid-type]
    #: None inherits modules.color.
    color: Color | None = None
    inner_color: Color | None = Field(default=None, alias="innerColor")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class Art(Base):
    mark: Literal[MARK_SHAPES] = "cross"  # type: ignore[valid-type]
    mark_size: float = Field(default=0.6, ge=0.1, le=1, alias="markSize")
    loose: bool = False
    clear_finders: bool = Field(default=False, alias="clearFinders")
    #: Authoritative when present: base64 RLE of per-module cell kinds.
    cells: str | None = None
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class QRSpec(Base):
    v: Literal[1] = 1
    content: Content = Content()
    encoded: Encoded | None = None
    mode: Literal["classic", "art"] = "classic"
    canvas: Canvas = Canvas()
    modules: Modules = Modules()
    finders: Finders = Finders()
    logo: Logo | None = None
    art: Art = Art()
