"""inscode render API.

Stateless by design: nothing is written to disk, nothing is stored, and request
logging deliberately excludes payload text and logo bytes. A request carries a
design in, an image comes back, and nothing about it is kept.

  POST /api/render    QRSpec (+ format, px, matte)  -> image bytes, decoder-verified
  POST /api/batch     one design, many payloads     -> ZIP
  POST /api/validate  QRSpec (+ output size)        -> integrity + optical + fit + logo
  GET  /api/health
"""
import asyncio
import io
import logging
import re
import zipfile
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from inscode.audit import audit, verified_max_scale
from inscode.oracle import PRODUCTION, decoder_oracle
from inscode.raster import FORMATS
from inscode.render import render_spec
from inscode.spec import QRSpec
from inscode.validate import report

#: A design with a large embedded logo is legitimately a few MB; beyond this it is
#: either a mistake or an attempt to tie the process up.
MAX_BODY = 12 * 1024 * 1024
MAX_PX = 8192
MAX_BATCH = 200
RENDER_TIMEOUT = 25.0

log = logging.getLogger("inscode")
_pool = ThreadPoolExecutor(max_workers=4)

app = FastAPI(title="inscode", version="1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173"],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def limit_body(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and int(length) > MAX_BODY:
        return JSONResponse(
            {"detail": f"request body over {MAX_BODY // (1024 * 1024)} MB"}, status_code=413
        )
    return await call_next(request)


async def _off_thread(fn, *args):
    """Run a render off the event loop, with a ceiling so one request cannot wedge a worker."""
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(loop.run_in_executor(_pool, fn, *args), RENDER_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(504, "render timed out") from None


class RenderRequest(BaseModel):
    spec: QRSpec
    format: Literal["svg", "png", "jpg", "jpeg"] = "png"
    px: int = Field(default=1024, gt=0, le=MAX_PX)
    #: Flatten onto this colour. JPEG always needs one; PNG only if you want it.
    matte: str | None = None
    #: Read the design back with a real decoder before returning it, and refuse if it
    #: cannot be read. On by default: this endpoint is the export path, and the
    #: heuristic that guards the preview is 95.6% accurate, which is the wrong number
    #: to be wrong at when somebody is about to print. Costs roughly 0.6s. Turn it off
    #: for a render whose scannability is not the point -- a thumbnail, a mock-up.
    verify: bool = True


class BatchItem(BaseModel):
    text: str
    name: str | None = None


class BatchRequest(BaseModel):
    #: One design; `content.text` is replaced per item. Note that each payload damages
    #: the logo differently, so a batch cannot inherit one verification -- and
    #: verifying 200 of them would take minutes. This path is deliberately unverified;
    #: check a sample from the ZIP, or run /api/render per item.
    template: QRSpec
    items: list[BatchItem] = Field(min_length=1, max_length=MAX_BATCH)
    format: Literal["svg", "png", "jpg", "jpeg"] = "png"
    px: int = Field(default=1024, gt=0, le=MAX_PX)


class PrintOutput(BaseModel):
    kind: Literal["print"]
    #: Finished width in millimetres, quiet zone included.
    mm: float = Field(gt=0, le=2000)


class ScreenOutput(BaseModel):
    kind: Literal["screen"]
    px: int = Field(gt=0, le=MAX_PX)


class ValidateRequest(BaseModel):
    spec: QRSpec
    #: How big the code will actually be. Without it the report answers in the
    #: abstract, and an abstract answer gets read as a verdict about whatever the
    #: reader is looking at -- usually a preview far larger than the finished code.
    output: PrintOutput | ScreenOutput | None = Field(default=None, discriminator="kind")


def _safe_name(text: str, fallback: str) -> str:
    stem = re.sub(r"[^a-zA-Z0-9]+", "-", re.sub(r"^[a-z]+://", "", text)).strip("-")[:48].lower()
    return stem or fallback


class Unreadable(Exception):
    """The design does not survive the production profile. Carries the size that does,
    when there is one, so the caller has something to act on rather than a refusal."""

    def __init__(self, message: str, verified: float | None):
        super().__init__(message)
        self.verified = verified


def _refusal(spec: QRSpec, oracle) -> Unreadable:
    """Words for an artifact that has *already* failed the decoder.

    Deliberately separate from the check. Nothing here can withhold permission -- it
    runs only once permission has been withheld -- which keeps `verified_max_scale`
    out of the gate. It found the notch this whole path exists for: a design it reports
    as safe up to 45.9% that does not read at 45%, and a comparison against it would
    have exported the file. It is equally wrong the other way, returning no answer at
    all for designs that read perfectly well, so it cannot be a veto either.
    """
    found = verified_max_scale(spec, oracle)
    if found.scale is not None and spec.logo is not None:
        return Unreadable(
            f"this design does not decode under the {PRODUCTION.name} profile; the "
            f"decoder reads it with the logo at {found.scale:.0%} or less "
            f"(currently {spec.logo.scale:.0%})",
            found.scale,
        )
    if found.unstable:
        return Unreadable(
            "this design reads at some logo sizes and not at smaller ones, so it is "
            "balanced on the decoder's threshold rather than safely inside it. Move the "
            "logo away from the corners, raise the contrast, or use a higher error "
            "correction level.",
            None,
        )
    return Unreadable(
        f"this design does not decode under the {PRODUCTION.name} profile at any logo "
        f"size — {audit(spec).message.lower()}",
        None,
    )


def _render(req: RenderRequest):
    if req.verify:
        # The only gate: this exact artifact, put to the production decoder.
        oracle = decoder_oracle(PRODUCTION)
        if not oracle(req.spec):
            raise _refusal(req.spec, oracle)

    fmt = req.format
    matte = req.matte
    if fmt in ("jpg", "jpeg") and req.spec.canvas.bg is None and matte is None:
        # JPEG has no alpha; be explicit rather than silently flattening onto black.
        matte = "#ffffff"
    return render_spec(req.spec, fmt, px=req.px, matte=matte)


@app.post("/api/render")
async def render(req: RenderRequest):
    """Render one design. `spec.encoded` and `spec.art.cells`, when the browser sent
    them, are drawn as-is so the output matches the preview exactly.

    Verified by default: the image is decoded back under the production profile and the
    request is refused if it cannot be read. Send `verify: false` to skip that.
    """
    try:
        data, mime = await _off_thread(_render, req)
    except HTTPException:
        raise
    except Unreadable as e:
        raise HTTPException(422, {"detail": str(e), "verifiedSafeScale": e.verified}) from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    except Exception:
        log.exception("render failed")  # no payload or logo bytes in the log
        raise HTTPException(500, "render failed") from None

    name = _safe_name(req.spec.content.text, "qr-code")
    ext = "jpg" if req.format in ("jpg", "jpeg") else req.format
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="{name}.{ext}"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/batch")
async def batch(req: BatchRequest):
    """One design, many payloads, returned as a ZIP.

    Built for menus, table tents and campaign links -- the case where the styling is
    settled and only the URL changes.
    """
    def build() -> bytes:
        buf = io.BytesIO()
        used: set[str] = set()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, item in enumerate(req.items):
                spec = req.template.model_copy(deep=True)
                spec.content.text = item.text
                # The template's encode belongs to a different payload.
                spec.encoded = None
                spec.art.cells = None
                data, _ = render_spec(spec, req.format, px=req.px)
                ext = "jpg" if req.format in ("jpg", "jpeg") else req.format
                stem = _safe_name(item.name or item.text, f"qr-{i + 1}")
                name = f"{stem}.{ext}"
                n = 2
                while name in used:
                    name = f"{stem}-{n}.{ext}"
                    n += 1
                used.add(name)
                zf.writestr(name, data)
        return buf.getvalue()

    try:
        payload = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(_pool, build),
            RENDER_TIMEOUT * 4,
        )
    except asyncio.TimeoutError:
        raise HTTPException(504, "batch timed out — try fewer items or a smaller size") from None
    except Exception:
        log.exception("batch failed")
        raise HTTPException(500, "batch failed") from None

    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="qr-codes.zip"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/validate")
async def validate(req: ValidateRequest):
    """Report on a design along both axes.

    `integrity` is exact -- computed from the design, per Reed-Solomon block, with
    the max logo scale the data can survive. `optical` is the empirical sweep: small
    sizes, soft focus, low contrast, rotation. A code can pass either and fail the
    other, which is why they are reported apart. Send `output` and `fit` answers the
    question at the size the code will actually be.

    `logo` is neither: an advisory about the file that was supplied, not about the
    symbol drawn from it. A logo flattened onto an opaque background covers modules
    over its whole bounding box rather than only where its ink is, which costs real
    logo size and is invisible in the preview. It never moves `grade`.
    """
    def run():
        return report(req.spec, req.output.model_dump() if req.output else None)

    try:
        return await _off_thread(run)
    except HTTPException:
        raise
    except Exception:
        log.exception("validate failed")
        raise HTTPException(500, "validate failed") from None


@app.get("/api/health")
async def health():
    return {"ok": True, "formats": list(FORMATS), "maxBatch": MAX_BATCH, "maxPx": MAX_PX}
