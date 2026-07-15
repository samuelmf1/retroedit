"""RuleSet3 scoring service for the sgRNA viewer.

RS3's sequence model is a LightGBM model over 30-mer contexts, so it cannot run
in the browser. The frontend posts contexts here and fills in the score column
as results arrive.

    uvicorn server.app:app --port 8000

Scoring is CPU-bound, so requests run on a worker thread and results are cached
per (context, tracr) — editing a base only asks for the guides that changed.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("rs3-service")

CONTEXT_LENGTH = 30
TRACRS = ("Chen2013", "Hsu2013")
MAX_API_BODY_BYTES = 256 * 1024
MAX_CONTEXTS = 2000

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the model off the request path so the first score is not slow.
    await asyncio.to_thread(_load)
    yield


app = FastAPI(title="RetroEdit backend", lifespan=lifespan)
_offtarget_gate = asyncio.Lock()

# The dev server proxies /api, but allow direct access too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_expensive_request_bodies(request: Request, call_next):
    """Reject oversized scoring requests before Pydantic parses their JSON."""
    if request.method == "POST" and request.url.path in {
        "/api/score",
        "/api/genomics/offtargets",
    }:
        try:
            content_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            content_length = 0
        if content_length > MAX_API_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content={"detail": f"request body exceeds {MAX_API_BODY_BYTES} bytes"},
            )
    if request.method == "POST" and request.url.path == "/api/genomics/offtargets":
        if _offtarget_gate.locked():
            return JSONResponse(
                status_code=429,
                content={"detail": "off-target search is busy; retry shortly"},
                headers={"Retry-After": "5"},
            )
        async with _offtarget_gate:
            return await call_next(request)
    return await call_next(request)

# gnomAD, ClinVar, annotation, and off-target endpoints.
try:
    from .genomics import router as genomics_router
except ImportError:
    from genomics import router as genomics_router
app.include_router(genomics_router)

_predict_seq = None
_import_error: Optional[str] = None
_cache: dict[tuple[str, str], float] = {}
_cache_lock = threading.Lock()
_score_gate = threading.BoundedSemaphore(1)


def _load():
    """Import rs3 once. Kept lazy so the service still boots without it."""
    global _predict_seq, _import_error
    if _predict_seq is not None or _import_error is not None:
        return
    try:
        from rs3.seq import predict_seq

        _predict_seq = predict_seq
        logger.info("rs3 loaded")
    except Exception as exc:  # noqa: BLE001 - surfaced to the client verbatim
        _import_error = f"{type(exc).__name__}: {exc}"
        logger.warning("rs3 unavailable - scores will be null (%s)", _import_error)


def _score_uncached_serial(contexts: List[str], tracr: str) -> List[Optional[float]]:
    _load()
    if _predict_seq is None:
        return [None] * len(contexts)

    missing = [c for c in dict.fromkeys(contexts) if (c, tracr) not in _cache]
    if missing:
        logger.info("scoring %d guides with RuleSet3 (tracr=%s)", len(missing), tracr)
        try:
            scores = _predict_seq(missing, sequence_tracr=tracr)
            with _cache_lock:
                for ctx, score in zip(missing, scores):
                    _cache[(ctx, tracr)] = float(score)
        except Exception as exc:  # noqa: BLE001
            logger.error("RuleSet3 scoring failed: %s", exc)
            return [None] * len(contexts)

    return [_cache.get((c, tracr)) for c in contexts]

def _score_uncached(contexts: List[str], tracr: str) -> List[Optional[float]]:
    """Serialize model access to avoid duplicate work and native contention."""
    with _score_gate:
        return _score_uncached_serial(contexts, tracr)



class ScoreRequest(BaseModel):
    contexts: List[str] = Field(..., description="30-mer contexts, guide-strand 5'->3'")
    tracr: str = "Chen2013"


class ScoreResponse(BaseModel):
    scores: List[Optional[float]]
    available: bool
    detail: Optional[str] = None


@app.get("/api/health")
async def health() -> dict:
    _load()
    return {
        "rs3": _predict_seq is not None,
        "detail": _import_error,
        "cached": len(_cache),
        "tracrs": list(TRACRS),
    }


@app.post("/api/score", response_model=ScoreResponse)
async def score(req: ScoreRequest) -> ScoreResponse:
    tracr = req.tracr if req.tracr in TRACRS else TRACRS[0]

    if len(req.contexts) > MAX_CONTEXTS:
        return ScoreResponse(
            scores=[None] * len(req.contexts),
            available=False,
            detail=f"Too many contexts ({len(req.contexts)} > {MAX_CONTEXTS})",
        )

    bad = next((c for c in req.contexts if len(c) != CONTEXT_LENGTH), None)
    if bad is not None:
        return ScoreResponse(
            scores=[None] * len(req.contexts),
            available=False,
            detail=f"Contexts must be {CONTEXT_LENGTH} nt; got {len(bad)}",
        )

    if not req.contexts:
        return ScoreResponse(scores=[], available=True)

    scores = await asyncio.to_thread(_score_uncached, req.contexts, tracr)
    return ScoreResponse(
        scores=scores,
        available=_predict_seq is not None,
        detail=_import_error,
    )


# Register the frontend last so the catch-all static mount cannot shadow /api.
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
else:
    logger.warning("frontend build not found at %s; run `npm run build`", DIST_DIR)
