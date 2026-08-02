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
import os
import threading
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional
from functools import lru_cache

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from Bio import SeqIO
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
MAX_SCORE_CACHE = int(os.environ.get("RS3_CACHE_SIZE", "20000"))

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the model off the request path so the first score is not slow.
    await asyncio.gather(
        asyncio.to_thread(_load),
        asyncio.to_thread(warm_genomic_indexes),
    )
    yield


app = FastAPI(title="RetroEdit backend", lifespan=lifespan)
_offtarget_gate = asyncio.Lock()
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=3)

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
        "/api/genomics/offtargets-advanced",
        "/api/genomics/spacer-matches",
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
    if request.method == "POST" and request.url.path in {
        "/api/genomics/offtargets",
        "/api/genomics/offtargets-advanced",
        "/api/genomics/spacer-matches",
    }:
        async with _offtarget_gate:
            return await call_next(request)

    response = await call_next(request)
    # Vite fingerprints production assets, so they can be cached permanently.
    # The HTML shell remains revalidated so deployments appear immediately.
    if request.method in {"GET", "HEAD"} and request.url.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif request.method in {"GET", "HEAD"} and request.url.path in {"/", "/index.html"}:
        response.headers["Cache-Control"] = "no-cache"
    elif request.method in {"GET", "HEAD"} and request.url.path.startswith("/api/genomics/"):
        response.headers["Cache-Control"] = "private, max-age=300, stale-while-revalidate=60"
    elif request.method in {"GET", "HEAD"} and request.url.path == "/api/health":
        response.headers["Cache-Control"] = "private, max-age=30"
    return response

# gnomAD, ClinVar, annotation, and off-target endpoints.
try:
    from .genomics import router as genomics_router, warm_genomic_indexes
except ImportError:
    from genomics import router as genomics_router, warm_genomic_indexes
app.include_router(genomics_router)


_predict_seq = None
_import_error: Optional[str] = None
_cache: OrderedDict[tuple[str, str], float] = OrderedDict()
_cache_lock = threading.Lock()
_score_gate = threading.BoundedSemaphore(1)
_score_async_gate = asyncio.Lock()


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
                    _cache.move_to_end((ctx, tracr))
                while len(_cache) > max(1, MAX_SCORE_CACHE):
                    _cache.popitem(last=False)
        except Exception as exc:  # noqa: BLE001
            logger.error("RuleSet3 scoring failed: %s", exc)
            return [None] * len(contexts)

    return [_cache.get((c, tracr)) for c in contexts]

def _score_uncached(contexts: List[str], tracr: str) -> List[Optional[float]]:
    """Serialize model access to avoid duplicate work and native contention."""
    with _score_gate:
        return _score_uncached_serial(contexts, tracr)



def _score_private(contexts: List[str], tracr: str) -> List[Optional[float]]:
    """Score transient contexts without retaining their sequences in the server cache."""
    with _score_gate:
        _load()
        if _predict_seq is None:
            return [None] * len(contexts)
        try:
            logger.info("scoring %d private guides with RuleSet3 (tracr=%s)", len(contexts), tracr)
            return [float(score) for score in _predict_seq(contexts, sequence_tracr=tracr)]
        except Exception as exc:  # noqa: BLE001
            logger.error("Private RuleSet3 scoring failed: %s", exc)
            return [None] * len(contexts)


class ScoreRequest(BaseModel):
    contexts: List[str] = Field(..., description="30-mer contexts, guide-strand 5'->3'")
    tracr: str = "Chen2013"
    cache: bool = True


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

    scorer = _score_uncached if req.cache else _score_private
    # Queue model work on the event loop rather than occupying one worker
    # thread per waiting user. Normal sequence/annotation requests stay responsive.
    async with _score_async_gate:
        scores = await asyncio.to_thread(scorer, req.contexts, tracr)
    return ScoreResponse(
        scores=scores,
        available=_predict_seq is not None,
        detail=_import_error,
    )


PLASMID_TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "pWB366_U6_MSR_AATD-02-MSD_noPolyT.dna"


@lru_cache(maxsize=1)
def _load_plasmid_template() -> dict:
    record = SeqIO.read(PLASMID_TEMPLATE_PATH, "snapgene")
    features = []
    for index, feature in enumerate(record.features):
        label = feature.qualifiers.get("label", [feature.type])[0]
        features.append({
            "id": f"feature-{index}",
            "label": label,
            "type": feature.type,
            "start": int(feature.location.start),
            "end": int(feature.location.end),
            "strand": feature.location.strand or 0,
        })
    by_label = {feature["label"]: feature for feature in features}
    placeholder = by_label["Starting G"]
    msd = by_label["AATD-02-MSD"]
    return {
        "name": PLASMID_TEMPLATE_PATH.stem,
        "sequence": str(record.seq).upper(),
        "features": features,
        "anchors": {
            "guide_insert_after": placeholder["end"],
            "repair_insert_after": msd["end"],
        },
    }


@app.get("/api/plasmid/template")
async def plasmid_template() -> dict:
    try:
        return await asyncio.to_thread(_load_plasmid_template)
    except Exception as exc:  # noqa: BLE001
        logger.error("SnapGene template load failed: %s", exc)
        return JSONResponse(status_code=500, content={"detail": "Plasmid template is unavailable"})


# Register the frontend last so the catch-all static mount cannot shadow /api.
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
else:
    logger.warning("frontend build not found at %s; run `npm run build`", DIST_DIR)
