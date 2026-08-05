"""Genomics service for variant annotations and genome-wide off-targets.

Local indexed gnomAD and ClinVar VCFs are preferred when configured. When those
large files are absent, human regional annotations fall back to the official
gnomAD GraphQL API. Successful remote regions are cached and shared by both
optional tracks. Every capability reports availability through
``/api/genomics/status`` and degrades to ``{available: false}`` on failure.
"""

from __future__ import annotations

import os
import json
import gzip
import queue
import threading
import time
import re
import shutil
import subprocess
from bisect import bisect_left, bisect_right
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

try:
    import sassy
except ImportError:  # Optional: the standard Bowtie search remains available.
    sassy = None

router = APIRouter(prefix="/api/genomics")

# ---- configuration ---------------------------------------------------------

GNOMAD_DIR = Path(os.environ.get("GNOMAD_DIR", "/gpfs/commons/datasets/gnomAD/4.1"))
GNOMAD_TEMPLATE = os.environ.get(
    "GNOMAD_TEMPLATE", "gnomad.joint.v4.1.sites.chr{chrom}.vcf.bgz"
)
CLINVAR_DIR = Path(
    os.environ.get(
        "CLINVAR_DIR",
        "/gpfs/commons/datasets/variants/clinvar/clinvar/pub/clinvar",
    )
)
GNOMAD_API_URL = os.environ.get("GNOMAD_API_URL", "https://gnomad.broadinstitute.org/api").strip()
GNOMAD_API_TIMEOUT = float(os.environ.get("GNOMAD_API_TIMEOUT", "15"))
GNOMAD_API_CACHE_TTL = int(os.environ.get("GNOMAD_API_CACHE_TTL", "900"))
GNOMAD_API_CACHE_SIZE = int(os.environ.get("GNOMAD_API_CACHE_SIZE", "256"))
GTEX_API_URL = os.environ.get("GTEX_API_URL", "https://gtexportal.org/api/v2").rstrip("/")
GTEX_API_TIMEOUT = float(os.environ.get("GTEX_API_TIMEOUT", "10"))
GTEX_CACHE_TTL = int(os.environ.get("GTEX_CACHE_TTL", "3600"))
GTEX_CACHE_SIZE = int(os.environ.get("GTEX_CACHE_SIZE", "512"))
UNIPROT_API_URL = os.environ.get("UNIPROT_API_URL", "https://rest.uniprot.org").rstrip("/")
ALPHAFOLD_API_URL = os.environ.get("ALPHAFOLD_API_URL", "https://alphafold.ebi.ac.uk/api").rstrip("/")
PROTEIN_STRUCTURE_TIMEOUT = float(os.environ.get("PROTEIN_STRUCTURE_TIMEOUT", "15"))
OFFTARGET_CACHE_SIZE = int(os.environ.get("OFFTARGET_CACHE_SIZE", "10000"))
ADVANCED_OFFTARGET_CACHE_SIZE = int(os.environ.get("ADVANCED_OFFTARGET_CACHE_SIZE", "256"))
ADVANCED_OFFTARGET_MAX_RESULTS = int(os.environ.get("ADVANCED_OFFTARGET_MAX_RESULTS", "500"))
ADVANCED_OFFTARGET_TIMEOUT = int(os.environ.get("ADVANCED_OFFTARGET_TIMEOUT", "300"))
ADVANCED_OFFTARGET_CHUNK_BP = int(os.environ.get("ADVANCED_OFFTARGET_CHUNK_BP", "25000000"))
GNOMAD_REMOTE_DATASETS = {
    "GRCh38": "gnomad_r4",
    "GRCh37": "gnomad_r2_1",
}

# Reference genomes, prebuilt indexes, and Linux-native command-line tools.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
REFERENCE_DIR = Path(os.environ.get("REFERENCE_DIR", PROJECT_ROOT / "reference")).resolve()
INDEX_DIR = Path(os.environ.get("INDEX_DIR", PROJECT_ROOT / "index")).resolve()
BOWTIE_DIR = Path(os.environ.get("BOWTIE_DIR", PROJECT_ROOT / ".conda-env" / "bin"))

GENOME_FASTA = {
    "GRCh38": REFERENCE_DIR / "GRCh38.primary_assembly.genome.fa.gz",
    "GRCh37": REFERENCE_DIR / "GRCh37.primary_assembly.genome.fa.gz",
    "GRCm39": REFERENCE_DIR / "GRCm39.primary_assembly.genome.fa.gz",
}
GENE_INDEX = {
    "GRCh38": INDEX_DIR / "GRCh38.genes.tsv",
    "GRCh37": INDEX_DIR / "GRCh37.genes.tsv",
}
GENE_NAMES = PROJECT_ROOT / "server" / "data" / "HGNC.gene_names.tsv.gz"

GENCODE_GTF = {
    "GRCh38": INDEX_DIR / "GRCh38.gencode.gtf.gz",
    "GRCh37": INDEX_DIR / "GRCh37.gencode.gtf.gz",
}

# gnomAD v4.1 is GRCh38 only; ClinVar ships both builds.
CLINVAR_VCF = {
    "GRCh38": CLINVAR_DIR / "vcf_GRCh38" / "clinvar.vcf.gz",
    "GRCh37": CLINVAR_DIR / "vcf_GRCh37" / "clinvar.vcf.gz",
}


def _which(name: str) -> Optional[str]:
    local = BOWTIE_DIR / name
    if local.exists():
        return str(local)
    return shutil.which(name)


TABIX = _which("tabix")
BOWTIE = _which("bowtie")
BOWTIE_BUILD = _which("bowtie-build")


def _gnomad_path(chrom: str) -> Path:
    return GNOMAD_DIR / GNOMAD_TEMPLATE.format(chrom=chrom.replace("chr", ""))


def _bowtie_index_prefix(assembly: str) -> Path:
    return INDEX_DIR / f"{assembly}.bowtie"


def _bowtie_index_ready(assembly: str) -> bool:
    prefix = _bowtie_index_prefix(assembly)
    return (prefix.parent / f"{assembly}.bowtie.1.ebwt").exists() or (
        prefix.parent / f"{assembly}.bowtie.1.ebwtl"
    ).exists()


# ---- tabix helpers ---------------------------------------------------------

@lru_cache(maxsize=8)
def _tabix_contigs(path_str: str) -> tuple:
    if not TABIX:
        return ()
    try:
        out = subprocess.run(
            [TABIX, "-l", path_str], capture_output=True, text=True, timeout=30
        )
        return tuple(out.stdout.split())
    except Exception:
        return ()


def _contig_for(path: Path, chrom: str) -> Optional[str]:
    """Match the caller's chromosome to however the VCF names its contigs."""
    contigs = _tabix_contigs(str(path))
    bare = chrom.replace("chr", "")
    for candidate in (chrom, bare, f"chr{bare}"):
        if candidate in contigs:
            return candidate
    return chrom  # let tabix try; it simply returns nothing if wrong


def _tabix_query(path: Path, chrom: str, start: int, end: int, limit: int = 5000) -> List[str]:
    if not TABIX or not path.exists():
        return []
    contig = _contig_for(path, chrom)
    try:
        proc = subprocess.run(
            [TABIX, str(path), f"{contig}:{start}-{end}"],
            capture_output=True, text=True, timeout=60,
        )
    except Exception:
        return []
    lines = [ln for ln in proc.stdout.splitlines() if ln and not ln.startswith("#")]
    return lines[:limit]


def _parse_info(info: str) -> Dict[str, str]:
    out = {}
    for field in info.split(";"):
        if "=" in field:
            k, v = field.split("=", 1)
            out[k] = v
        elif field:
            out[field] = "true"
    return out


def _num(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value.split(",")[0])
    except (ValueError, AttributeError):
        return None


_REMOTE_VARIANT_QUERY = """
query RetroEditRegion(
  $chrom: String!, $start: Int!, $stop: Int!,
  $referenceGenome: ReferenceGenomeId!, $dataset: DatasetId!
) {
  region(
    chrom: $chrom, start: $start, stop: $stop,
    reference_genome: $referenceGenome
  ) {
    variants(dataset: $dataset) {
      variant_id pos ref alt rsids
      joint { ac an homozygote_count filters }
      exome { ac an homozygote_count filters }
      genome { ac an homozygote_count filters }
    }
    clinvar_variants {
      variant_id pos ref alt clinical_significance
      clinvar_variation_id gold_stars review_status
    }
  }
}
"""
_remote_variant_cache: Dict[tuple, tuple[float, dict]] = {}
_remote_variant_cache_lock = threading.Lock()


def _remote_region_variants(assembly: str, chrom: str, start: int, end: int) -> dict:
    dataset = GNOMAD_REMOTE_DATASETS.get(assembly)
    if not GNOMAD_API_URL or not dataset:
        raise RuntimeError(f"remote variant annotations do not support {assembly}")
    normalized_chrom = chrom.replace("chr", "")
    key = (assembly, normalized_chrom, start, end)
    now = time.monotonic()

    # Hold the lock through the request so simultaneous gnomAD and ClinVar track
    # requests for one interval collapse into a single upstream API call.
    with _remote_variant_cache_lock:
        cached = _remote_variant_cache.get(key)
        if cached and now - cached[0] < GNOMAD_API_CACHE_TTL:
            return cached[1]

        body = json.dumps({
            "query": _REMOTE_VARIANT_QUERY,
            "variables": {
                "chrom": normalized_chrom,
                "start": start,
                "stop": end,
                "referenceGenome": assembly,
                "dataset": dataset,
            },
        }).encode("utf-8")
        request = Request(
            GNOMAD_API_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "RetroEdit/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=GNOMAD_API_TIMEOUT) as response:
                payload = json.load(response)
        except HTTPError as exc:
            detail = exc.read(500).decode("utf-8", errors="replace")
            raise RuntimeError(f"gnomAD API returned {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"gnomAD API request failed: {exc}") from exc

        if payload.get("errors"):
            message = payload["errors"][0].get("message", "GraphQL query failed")
            raise RuntimeError(f"gnomAD API error: {message}")
        region = payload.get("data", {}).get("region")
        if region is None:
            raise RuntimeError("gnomAD API returned no region data")

        _remote_variant_cache[key] = (now, region)
        while len(_remote_variant_cache) > max(1, GNOMAD_API_CACHE_SIZE):
            _remote_variant_cache.pop(next(iter(_remote_variant_cache)))
        return region


# ---- GTEx tissue expression ------------------------------------------------

_gtex_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_gtex_cache_lock = threading.Lock()
_gtex_request_locks: Dict[str, threading.Lock] = {}


def _gtex_get(path: str, params: dict) -> dict:
    request = Request(
        f"{GTEX_API_URL}{path}?{urlencode(params, doseq=True)}",
        headers={"Accept": "application/json", "User-Agent": "RetroEdit/1.0"},
    )
    try:
        with urlopen(request, timeout=GTEX_API_TIMEOUT) as response:
            return json.load(response)
    except HTTPError as exc:
        detail = exc.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(f"GTEx API returned {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"GTEx API request failed: {exc}") from exc


def _gtex_expression_uncollapsed(gene: str) -> dict:
    cache_key = gene.upper()
    now = time.monotonic()
    with _gtex_cache_lock:
        cached = _gtex_cache.get(cache_key)
        if cached and now - cached[0] < GTEX_CACHE_TTL:
            _gtex_cache.move_to_end(cache_key)
            return cached[1]

    reference = _gtex_get("/reference/gene", {
        "geneId": gene,
        "gencodeVersion": "v39",
        "genomeBuild": "GRCh38/hg38",
        "itemsPerPage": 25,
    })
    candidates = reference.get("data") or []
    resolved = next(
        (row for row in candidates if str(row.get("geneSymbol", "")).upper() == cache_key),
        candidates[0] if candidates else None,
    )
    if not resolved or not resolved.get("gencodeId"):
        result = {
            "available": True, "geneSymbol": gene, "gencodeId": None,
            "datasetId": "gtex_v10", "unit": "TPM", "rows": [],
        }
    else:
        gencode_id = resolved["gencodeId"]
        expression = _gtex_get("/expression/medianGeneExpression", {
            "gencodeId": gencode_id,
            "datasetId": "gtex_v10",
            "itemsPerPage": 1000,
        })
        result = {
            "available": True,
            "geneSymbol": resolved.get("geneSymbol") or gene,
            "gencodeId": gencode_id,
            "datasetId": "gtex_v10",
            "unit": "TPM",
            "rows": expression.get("data") or [],
        }

    with _gtex_cache_lock:
        _gtex_cache[cache_key] = (time.monotonic(), result)
        _gtex_cache.move_to_end(cache_key)
        while len(_gtex_cache) > max(1, GTEX_CACHE_SIZE):
            _gtex_cache.popitem(last=False)
    return result


def _gtex_expression(gene: str) -> dict:
    cache_key = gene.upper()
    with _gtex_cache_lock:
        request_lock = _gtex_request_locks.setdefault(cache_key, threading.Lock())
    # Collapse concurrent requests for one gene without blocking different genes.
    with request_lock:
        return _gtex_expression_uncollapsed(gene)


@router.get("/gtex-expression")
def gtex_expression(gene: str) -> dict:
    symbol = gene.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", symbol):
        raise HTTPException(status_code=400, detail="A valid gene symbol is required")
    if not GTEX_API_URL:
        raise HTTPException(status_code=503, detail="GTEx integration is unavailable")
    try:
        return _gtex_expression(symbol)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ---- AlphaFold protein structures -----------------------------------------

_protein_structure_locks: Dict[str, threading.Lock] = {}
_protein_structure_locks_guard = threading.Lock()
_protein_model_locks: Dict[str, threading.Lock] = {}


def _remote_json(url: str, label: str) -> dict | list:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "RetroEdit/1.0"},
    )
    try:
        with urlopen(request, timeout=PROTEIN_STRUCTURE_TIMEOUT) as response:
            return json.load(response)
    except HTTPError as exc:
        detail = exc.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(f"{label} returned {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{label} request failed: {exc}") from exc


@lru_cache(maxsize=512)
def _protein_structure_metadata(gene: str, tax_id: int) -> dict:
    cache_key = f"{tax_id}:{gene.upper()}"
    with _protein_structure_locks_guard:
        request_lock = _protein_structure_locks.setdefault(cache_key, threading.Lock())
    with request_lock:
        query = f"(gene_exact:{gene}) AND (organism_id:{tax_id}) AND (reviewed:true)"
        uniprot_params = urlencode({
            "query": query,
            "fields": "accession,id,gene_names,protein_name,length,sequence",
            "format": "json",
            "size": 5,
        })
        uniprot = _remote_json(
            f"{UNIPROT_API_URL}/uniprotkb/search?{uniprot_params}",
            "UniProt API",
        )
        records = uniprot.get("results", []) if isinstance(uniprot, dict) else []
        if not records:
            return {"available": False, "gene": gene, "reason": "No reviewed UniProt entry was found."}
        exact = next((record for record in records if any(
            str(item.get("geneName", {}).get("value", "")).upper() == gene.upper()
            for item in record.get("genes", [])
        )), records[0])
        accession = exact.get("primaryAccession")
        if not accession:
            return {"available": False, "gene": gene, "reason": "The UniProt entry has no accession."}

        predictions = _remote_json(
            f"{ALPHAFOLD_API_URL}/prediction/{accession}",
            "AlphaFold DB API",
        )
        prediction = predictions[0] if isinstance(predictions, list) and predictions else None
        if not prediction:
            return {"available": False, "gene": gene, "accession": accession, "reason": "No AlphaFold model was found."}
        entry_id = prediction.get("entryId") or prediction.get("modelEntityId")
        sequence = prediction.get("uniprotSequence") or prediction.get("sequence") \
            or exact.get("sequence", {}).get("value", "")
        return {
            "available": True,
            "gene": prediction.get("gene") or gene,
            "accession": accession,
            "uniprotId": prediction.get("uniprotId") or exact.get("uniProtkbId"),
            "description": prediction.get("uniprotDescription") or "Protein structure",
            "entryId": entry_id,
            "sourceUrl": f"https://alphafold.ebi.ac.uk/entry/{entry_id}",
            "modelUrl": f"/api/genomics/protein-structure/model/{accession}",
            "sequence": sequence,
            "sequenceStart": prediction.get("sequenceStart", 1),
            "sequenceEnd": prediction.get("sequenceEnd", len(sequence)),
            "confidence": prediction.get("globalMetricValue"),
            "version": prediction.get("latestVersion"),
            "organism": prediction.get("organismScientificName"),
            "chainId": prediction.get("chainId") or "A",
            "pdbUrl": prediction.get("pdbUrl"),
        }


@router.get("/protein-structure")
def protein_structure(gene: str, assembly: str = "GRCh38") -> dict:
    symbol = gene.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", symbol):
        raise HTTPException(status_code=400, detail="A valid gene symbol is required")
    tax_id = 10090 if assembly == "GRCm39" else 9606 if assembly in {"GRCh37", "GRCh38"} else None
    if tax_id is None:
        return {"available": False, "gene": symbol, "reason": "Protein structures are unavailable for this custom assembly."}
    try:
        return _protein_structure_metadata(symbol.upper(), tax_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/protein-structure/model/{accession}")
def protein_structure_model(accession: str) -> Response:
    accession = accession.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{6,10}", accession):
        raise HTTPException(status_code=400, detail="Invalid UniProt accession")
    try:
        payload = _protein_model_payload(accession)
        return Response(
            content=payload,
            media_type="chemical/x-pdb",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except HTTPException:
        raise
    except HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"AlphaFold model download returned {exc.code}") from exc
    except (URLError, TimeoutError, RuntimeError) as exc:
        raise HTTPException(status_code=502, detail=f"AlphaFold model download failed: {exc}") from exc


@lru_cache(maxsize=32)
def _protein_model_payload(accession: str) -> bytes:
    with _protein_structure_locks_guard:
        request_lock = _protein_model_locks.setdefault(accession, threading.Lock())
    with request_lock:
        predictions = _remote_json(
            f"{ALPHAFOLD_API_URL}/prediction/{accession}",
            "AlphaFold DB API",
        )
        prediction = predictions[0] if isinstance(predictions, list) and predictions else None
        pdb_url = prediction.get("pdbUrl") if prediction else None
        if not pdb_url or not pdb_url.startswith("https://alphafold.ebi.ac.uk/files/"):
            raise HTTPException(status_code=404, detail="AlphaFold model unavailable")
        request = Request(pdb_url, headers={"Accept": "application/octet-stream", "User-Agent": "RetroEdit/1.0"})
        with urlopen(request, timeout=PROTEIN_STRUCTURE_TIMEOUT) as upstream:
            payload = upstream.read(25 * 1024 * 1024 + 1)
        if len(payload) > 25 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="AlphaFold model is too large to display")
        return payload

# ---- status ----------------------------------------------------------------

@router.get("/status")
def status() -> dict:
    local_gnomad = bool(TABIX) and GNOMAD_DIR.exists() and any(
        _gnomad_path(c).exists() for c in ("1", "13", "17")
    )
    remote_variants = bool(GNOMAD_API_URL)
    gnomad_assemblies = {
        assembly: remote_variants or (assembly == "GRCh38" and local_gnomad)
        for assembly in GNOMAD_REMOTE_DATASETS
    }
    clinvar = {
        assembly: (bool(TABIX) and path.exists()) or remote_variants
        for assembly, path in CLINVAR_VCF.items()
    }
    genomes = {a: p.exists() for a, p in GENOME_FASTA.items()}
    annotations = {
        a: bool(TABIX) and p.exists() and Path(str(p) + ".tbi").exists()
        for a, p in GENCODE_GTF.items()
    }
    offtarget = {
        a: {"genome": p.exists(), "index": _bowtie_index_ready(a), "ready": offtarget_ready(a)}
        for a, p in GENOME_FASTA.items()
    }
    return {
        "tabix": bool(TABIX),
        "bowtie": bool(BOWTIE),
        "gnomad": {
            "available": any(gnomad_assemblies.values()),
            "assemblies": gnomad_assemblies,
            "remote": remote_variants,
        },
        "clinvar": {"available": clinvar, "remote": remote_variants},
        "genomes": genomes,
        "annotations": annotations,
        "offtarget": {"tool": bool(BOWTIE), "assemblies": offtarget},
    }


# ---- rsID resolution --------------------------------------------------------

NCBI_REFSNP_URL = "https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/{rsid}"
RSID_TIMEOUT = float(os.environ.get("RSID_TIMEOUT", "2"))
ASSEMBLY_PREFIX = {"GRCh38": "GRCh38", "GRCh37": "GRCh37", "GRCm39": "GRCm39"}


def _refseq_chromosome(seq_id: str, assembly: str) -> Optional[str]:
    accession = seq_id.split(".", 1)[0]
    if accession == "NC_012920" and assembly.startswith("GRCh"):
        return "MT"
    if accession == "NC_005089" and assembly == "GRCm39":
        return "MT"
    match = re.fullmatch(r"NC_(\d{6})", accession)
    if not match:
        return None
    number = int(match.group(1))
    if assembly.startswith("GRCh"):
        if 1 <= number <= 22:
            return str(number)
        return {23: "X", 24: "Y"}.get(number)
    if assembly == "GRCm39":
        if 67 <= number <= 85:
            return str(number - 66)
        return {86: "X", 87: "Y"}.get(number)
    return None


@lru_cache(maxsize=4096)
def _ncbi_rsid_location(assembly: str, rs_number: str) -> dict:
    request = Request(
        NCBI_REFSNP_URL.format(rsid=rs_number),
        headers={"Accept": "application/json", "User-Agent": "RetroEdit/1.0"},
    )
    try:
        with urlopen(request, timeout=RSID_TIMEOUT) as response:
            payload = json.load(response)
    except HTTPError as exc:
        if exc.code == 404:
            raise ValueError(f"rs{rs_number} was not found in dbSNP") from exc
        raise RuntimeError(f"NCBI RefSNP returned HTTP {exc.code}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError("NCBI RefSNP lookup is temporarily unavailable") from exc

    merged_into = payload.get("merged_snapshot_data", {}).get("merged_into", [])
    if merged_into:
        return _ncbi_rsid_location(assembly, str(merged_into[0]))

    assembly_prefix = ASSEMBLY_PREFIX.get(assembly)
    if not assembly_prefix:
        raise ValueError(f"rsID lookup does not support {assembly}")
    placements = payload.get("primary_snapshot_data", {}).get("placements_with_allele", [])
    for placement in placements:
        annotation = placement.get("placement_annot", {})
        if annotation.get("seq_type") != "refseq_chromosome":
            continue
        traits = annotation.get("seq_id_traits_by_assembly", [])
        if not any(
            str(trait.get("assembly_name", "")).startswith(assembly_prefix)
            and trait.get("is_top_level") and not trait.get("is_alt") and not trait.get("is_patch")
            for trait in traits
        ):
            continue
        chrom = _refseq_chromosome(placement.get("seq_id", ""), assembly)
        alleles = placement.get("alleles", [])
        if not chrom or not alleles:
            continue
        spdis = [item.get("allele", {}).get("spdi", {}) for item in alleles]
        reference = spdis[0]
        if not isinstance(reference.get("position"), int):
            continue
        start = reference["position"] + 1
        deleted = str(reference.get("deleted_sequence", ""))
        inserted = []
        for spdi in spdis:
            allele = str(spdi.get("inserted_sequence", ""))
            if allele not in inserted:
                inserted.append(allele)
        return {
            "id": f"rs{payload.get('refsnp_id', rs_number)}",
            "chrom": chrom,
            "start": start,
            "end": start + max(1, len(deleted)) - 1,
            "strand": -1 if annotation.get("is_aln_opposite_orientation") else 1,
            "alleles": "/".join(inserted) or None,
            "source": "NCBI dbSNP",
        }
    raise ValueError(f"No {assembly} chromosome mapping for rs{rs_number}")


@router.get("/variant-location")
def variant_location(assembly: str, rsid: str) -> dict:
    match = re.fullmatch(r"rs(\d+)", rsid.strip(), re.IGNORECASE)
    if not match:
        raise HTTPException(status_code=422, detail="enter an rsID such as rs11591147")
    try:
        return _ncbi_rsid_location(assembly, match.group(1))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ---- variants ---------------------------------------------------------------

class Variant(BaseModel):
    pos: int
    ref: str
    alt: str
    id: Optional[str] = None
    af: Optional[float] = None          # MAF (gnomAD joint, or ClinVar common)
    af_grpmax: Optional[float] = None
    grpmax: Optional[str] = None
    nhomalt: Optional[int] = None
    clnsig: Optional[str] = None        # ClinVar clinical significance
    clndn: Optional[str] = None         # ClinVar disease name
    review_status: Optional[str] = None
    gold_stars: Optional[int] = None
    source: str = "gnomad"


class VariantResponse(BaseModel):
    available: bool
    variants: List[Variant] = []
    truncated: bool = False
    detail: Optional[str] = None


@lru_cache(maxsize=128)
def _gnomad_variants(chrom: str, start: int, end: int) -> VariantResponse:
    path = _gnomad_path(chrom)
    if not TABIX or not path.exists():
        return VariantResponse(available=False, detail="gnomAD not available")
    rows = _tabix_query(path, chrom, start, end)
    variants = []
    for ln in rows:
        f = ln.split("\t")
        if len(f) < 8:
            continue
        info = _parse_info(f[7])
        af = _num(info.get("AF_joint"))
        # Skip monomorphic / absent alleles to keep the track meaningful.
        if af is None or af == 0:
            continue
        variants.append(Variant(
            pos=int(f[1]), ref=f[3], alt=f[4].split(",")[0],
            id=(f[2] if f[2] != "." else None),
            af=af,
            af_grpmax=_num(info.get("AF_grpmax_joint")),
            grpmax=(info.get("grpmax_joint") or "").split(",")[0] or None,
            nhomalt=int(_num(info.get("nhomalt_joint")) or 0),
            source="gnomad",
        ))
    return VariantResponse(available=True, variants=variants,
                           truncated=len(rows) >= 5000)


# ClinVar significance tag differs across releases (CLNSIG vs CLNSIG-less older
# builds); probe the common spellings.
_CLNSIG_KEYS = ("CLNSIG", "CLNSIGINCL", "CLINSIG")
_CLNDN_KEYS = ("CLNDN", "CLNDBN", "CLNDISDB")


@lru_cache(maxsize=128)
def _clinvar_variants(assembly: str, chrom: str, start: int, end: int) -> VariantResponse:
    path = CLINVAR_VCF.get(assembly)
    if not path or not TABIX or not path.exists():
        return VariantResponse(available=False, detail="ClinVar not available")
    rows = _tabix_query(path, chrom, start, end)
    variants = []
    for ln in rows:
        f = ln.split("\t")
        if len(f) < 8:
            continue
        info = _parse_info(f[7])
        clnsig = next((info[k] for k in _CLNSIG_KEYS if k in info), None)
        clndn = next((info[k] for k in _CLNDN_KEYS if k in info), None)
        variants.append(Variant(
            pos=int(f[1]), ref=f[3], alt=f[4].split(",")[0],
            id=(f[2] if f[2] != "." else None),
            af=_num(info.get("AF_ESP") or info.get("AF_EXAC") or info.get("CAF")),
            clnsig=(clnsig or "").replace("_", " ").replace("|", ", ") or None,
            clndn=(clndn or "").replace("_", " ").replace("|", ", ")[:200] or None,
            source="clinvar",
        ))
    return VariantResponse(available=True, variants=variants,
                           truncated=len(rows) >= 5000)


def _remote_gnomad_variants(
    assembly: str, chrom: str, start: int, end: int
) -> VariantResponse:
    try:
        rows = _remote_region_variants(assembly, chrom, start, end).get("variants", [])
    except RuntimeError as exc:
        return VariantResponse(available=False, detail=str(exc))

    variants = []
    for item in rows:
        joint = item.get("joint")
        if joint:
            ac = int(joint.get("ac") or 0)
            an = int(joint.get("an") or 0)
            nhomalt = int(joint.get("homozygote_count") or 0)
            filters = set(joint.get("filters") or [])
        else:
            parts = [part for part in (item.get("exome"), item.get("genome")) if part]
            ac = sum(int(part.get("ac") or 0) for part in parts)
            an = sum(int(part.get("an") or 0) for part in parts)
            nhomalt = sum(int(part.get("homozygote_count") or 0) for part in parts)
            filters = {value for part in parts for value in (part.get("filters") or [])}
        if ac <= 0 or an <= 0 or filters:
            continue
        rsids = item.get("rsids") or []
        variants.append(Variant(
            pos=int(item["pos"]),
            ref=item["ref"],
            alt=item["alt"],
            id=rsids[0] if rsids else item.get("variant_id"),
            af=min(1.0, ac / an),
            nhomalt=nhomalt,
            source="gnomad",
        ))
    return VariantResponse(
        available=True,
        variants=variants,
        truncated=len(rows) >= 5000,
        detail="gnomAD GraphQL API",
    )


def _remote_clinvar_variants(
    assembly: str, chrom: str, start: int, end: int
) -> VariantResponse:
    try:
        rows = _remote_region_variants(assembly, chrom, start, end).get("clinvar_variants", [])
    except RuntimeError as exc:
        return VariantResponse(available=False, detail=str(exc))

    variants = []
    for item in rows:
        variation_id = item.get("clinvar_variation_id")
        variants.append(Variant(
            pos=int(item["pos"]),
            ref=item["ref"],
            alt=item["alt"],
            id=str(variation_id) if variation_id is not None else item.get("variant_id"),
            clnsig=item.get("clinical_significance"),
            review_status=item.get("review_status"),
            gold_stars=item.get("gold_stars"),
            source="clinvar",
        ))
    return VariantResponse(
        available=True,
        variants=variants,
        truncated=len(rows) >= 5000,
        detail="gnomAD GraphQL API ClinVar track",
    )


@router.get("/variants", response_model=VariantResponse)
def variants(source: str, assembly: str, chrom: str, start: int, end: int) -> VariantResponse:
    if start < 1 or end < start:
        return VariantResponse(available=False, detail="invalid region")
    if end - start > 1_000_000:
        return VariantResponse(available=False, detail="region too large")
    if assembly not in GNOMAD_REMOTE_DATASETS:
        return VariantResponse(
            available=False,
            detail=f"variant annotations do not support {assembly}",
        )

    if source == "gnomad":
        if assembly == "GRCh38":
            local = _gnomad_variants(chrom, start, end)
            if local.available:
                return local
        return _remote_gnomad_variants(assembly, chrom, start, end)

    if source == "clinvar":
        local = _clinvar_variants(assembly, chrom, start, end)
        if local.available:
            return local
        return _remote_clinvar_variants(assembly, chrom, start, end)

    return VariantResponse(available=False, detail=f"unknown source {source}")


# ---- off-target search ------------------------------------------------------
#
# CRISPOR-style pipeline: align each 20 nt protospacer to the whole genome with
# bowtie allowing up to MAX_MM mismatches, then keep only hits whose adjacent
# 3 nt is an NGG/NAG PAM (fetched with `samtools faidx`). Counts are bucketed by
# mismatch number; the on-target locus itself is excluded.

MAX_MM = 2  # count genomic matches up to 2 mismatches; a unique guide is 1-0-0
MAX_HITS = 500
MAX_GUIDES = 100
MAX_SPACER_MATCHES = 500
MAX_SPACER_ALIGNMENTS = MAX_SPACER_MATCHES + 1
FAIDX_BATCH_SIZE = 2000
BOWTIE_THREADS = max(1, int(os.environ.get("BOWTIE_THREADS", "2")))
COMP = str.maketrans("ACGTNacgtn", "TGCANtgcan")
IUPAC_BASES = {
    "A": "A", "C": "C", "G": "G", "T": "T", "R": "AG", "Y": "CT",
    "S": "CG", "W": "AT", "K": "GT", "M": "AC", "B": "CGT", "D": "AGT",
    "H": "ACT", "V": "ACG", "N": "ACGT",
}

SAMTOOLS = _which("samtools")
BGZIP = _which("bgzip")


def _revcomp(seq: str) -> str:
    return seq.translate(COMP)[::-1]


def _faidx_fasta(assembly: str) -> Path:
    return INDEX_DIR / f"{assembly}.faidx.fa.gz"


def _faidx_ready(assembly: str) -> bool:
    return Path(str(_faidx_fasta(assembly)) + ".fai").exists()


@lru_cache(maxsize=1)
def _approved_gene_names() -> Dict[str, str]:
    """HGNC-approved human gene names keyed by current symbol."""
    if not GENE_NAMES.exists():
        return {}
    names: Dict[str, str] = {}
    with gzip.open(GENE_NAMES, "rt") as handle:
        for line in handle:
            symbol, separator, name = line.rstrip("\n").partition("\t")
            if separator and symbol and name:
                names[symbol.upper()] = name
    return names


@lru_cache(maxsize=3)
def _gene_index(assembly: str) -> Dict[str, dict]:
    path = GENE_INDEX.get(assembly)
    if not path or not path.exists():
        return {}
    genes: Dict[str, dict] = {}
    approved_names = _approved_gene_names() if assembly in {"GRCh38", "GRCh37"} else {}
    with path.open() as handle:
        for line in handle:
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 7:
                continue
            name_key, gene_id, chrom, start, end, strand, display_name = fields
            record = {
                "id": gene_id, "name": display_name, "chrom": chrom,
                "start": int(start), "end": int(end),
                "strand": -1 if strand == "-" else 1,
                "canonical": None, "description": approved_names.get(display_name.upper(), ""),
            }
            genes.setdefault(name_key, record)
            genes.setdefault(gene_id.upper(), record)
            if record["description"]:
                genes.setdefault(record["description"].upper(), record)
    return genes

@lru_cache(maxsize=3)
def _gene_catalog(assembly: str) -> tuple[dict, ...]:
    """Unique stable gene records for the lightweight autocomplete."""
    unique = {record["id"]: record for record in _gene_index(assembly).values()}
    return tuple(sorted(unique.values(), key=lambda item: (item["name"].upper(), item["id"])))


@lru_cache(maxsize=3)
def _gene_position_indexes(assembly: str) -> dict[str, tuple]:
    grouped: Dict[str, List[dict]] = {}
    for gene in _gene_catalog(assembly):
        chrom = str(gene["chrom"]).removeprefix("chr").upper()
        grouped.setdefault(chrom, []).append(gene)

    indexes = {}
    for chrom, records in grouped.items():
        genes = tuple(sorted(records, key=lambda gene: (gene["start"], gene["end"])))
        starts = tuple(gene["start"] for gene in genes)
        prefix_max_ends = []
        prefix_max_indexes = []
        best_index = 0
        for index, gene in enumerate(genes):
            if gene["end"] > genes[best_index]["end"]:
                best_index = index
            prefix_max_ends.append(genes[best_index]["end"])
            prefix_max_indexes.append(best_index)
        indexes[chrom] = (genes, starts, tuple(prefix_max_ends), tuple(prefix_max_indexes))
    return indexes


def _nearest_gene(assembly: str, chrom: str, start: int, end: int) -> Optional[dict]:
    index = _gene_position_indexes(assembly).get(str(chrom).removeprefix("chr").upper())
    if not index:
        return None
    genes, starts, prefix_max_ends, prefix_max_indexes = index

    # Find overlapping genes without scanning the chromosome. Prefix maxima let
    # us stop once no earlier interval can reach the spacer.
    right = bisect_right(starts, end)
    overlaps = []
    cursor = right - 1
    while cursor >= 0 and prefix_max_ends[cursor] >= start:
        gene = genes[cursor]
        if gene["end"] >= start:
            overlaps.append(gene)
        cursor -= 1
    if overlaps:
        gene = min(overlaps, key=lambda item: (item["end"] - item["start"], item["name"]))
        return {"name": gene["name"], "id": gene["id"], "distance": 0}

    candidates = []
    left_slot = bisect_left(starts, start) - 1
    if left_slot >= 0:
        candidates.append(genes[prefix_max_indexes[left_slot]])
    if right < len(genes):
        candidates.append(genes[right])
    if not candidates:
        return None

    def distance(gene: dict) -> int:
        return start - gene["end"] if gene["end"] < start else gene["start"] - end

    gene = min(candidates, key=lambda item: (distance(item), item["end"] - item["start"], item["name"]))
    return {"name": gene["name"], "id": gene["id"], "distance": distance(gene)}

@lru_cache(maxsize=3)
def _gene_search_indexes(assembly: str) -> tuple[tuple, tuple, tuple]:
    catalog = _gene_catalog(assembly)
    names = tuple(sorted((gene["name"].upper(), gene["id"], gene) for gene in catalog))
    ids = tuple(sorted((gene["id"].upper(), gene["id"], gene) for gene in catalog))
    full_names = tuple(sorted(
        (gene["description"].upper(), gene["id"], gene)
        for gene in catalog if gene.get("description")
    ))
    return names, ids, full_names


def _prefix_matches(entries: tuple, term: str) -> tuple:
    start = bisect_left(entries, (term,))
    end = bisect_left(entries, (term + "\uffff",))
    return entries[start:end]



@router.get("/gene-suggestions")
@lru_cache(maxsize=2048)
def gene_suggestions(assembly: str, query: str, limit: int = 8) -> dict:
    term = query.strip().upper().split(".", 1)[0]
    if len(term) < 2 or term.startswith("RS") or ":" in term:
        return {"suggestions": []}
    limit = max(1, min(12, limit))
    names, ids, full_names = _gene_search_indexes(assembly)
    ranked = []
    seen = set()
    for rank, entries in enumerate((names, ids, full_names)):
        for key, gene_id, gene in _prefix_matches(entries, term):
            if gene_id in seen:
                continue
            seen.add(gene_id)
            ranked.append((rank, len(key), key, gene))

    # Substring fallback is useful for longer symbols, but prefix matches avoid
    # a whole-catalog scan for the common path and for Ensembl IDs.
    if len(ranked) < limit and len(term) >= 3 and not term.startswith("ENS"):
        for gene in _gene_catalog(assembly):
            symbol = gene["name"].upper()
            full_name = gene.get("description", "").upper()
            match_key = symbol if term in symbol else full_name if term in full_name else ""
            if gene["id"] not in seen and match_key:
                seen.add(gene["id"])
                ranked.append((3, len(match_key), match_key, gene))
    ranked.sort(key=lambda item: item[:3])
    return {"suggestions": [item[3] for item in ranked[:limit]]}



@lru_cache(maxsize=3)
def _faidx_contigs(assembly: str) -> tuple[str, ...]:
    fai = Path(str(_faidx_fasta(assembly)) + ".fai")
    if not fai.exists():
        return ()
    with fai.open() as handle:
        return tuple(line.split("\t", 1)[0] for line in handle if line.strip())


def _local_contig(assembly: str, chrom: str) -> Optional[str]:
    contigs = set(_faidx_contigs(assembly))
    bare = str(chrom).removeprefix("chr")
    candidates = (
        str(chrom), bare, f"chr{bare}",
        "chrM" if bare in {"M", "MT"} else "",
    )
    return next((candidate for candidate in candidates if candidate in contigs), None)


_REGION_LOCKS = tuple(threading.Lock() for _ in range(32))


def _region_lock(kind: str, assembly: str, chrom: str, start: int, end: int) -> threading.Lock:
    key = (kind, assembly, str(chrom), start, end)
    return _REGION_LOCKS[hash(key) % len(_REGION_LOCKS)]

@lru_cache(maxsize=512)
def _local_sequence_cached(assembly: str, chrom: str, start: int, end: int) -> str:
    contig = _local_contig(assembly, chrom)
    if not contig:
        raise ValueError(f"unknown contig {chrom}")
    proc = subprocess.run(
        [SAMTOOLS, "faidx", str(_faidx_fasta(assembly)), f"{contig}:{start}-{end}"],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"samtools exited {proc.returncode}")
    return "".join(line.strip() for line in proc.stdout.splitlines() if not line.startswith(">"))


def _local_sequence(assembly: str, chrom: str, start: int, end: int) -> str:
    with _region_lock("sequence", assembly, chrom, start, end):
        return _local_sequence_cached(assembly, chrom, start, end)



def warm_genomic_indexes() -> None:
    """Warm small immutable indexes so the first request is not a cold start."""
    for assembly in GENE_INDEX:
        _gene_index(assembly)
        _gene_search_indexes(assembly)
    for assembly in GENOME_FASTA:
        _gene_position_indexes(assembly)
        _faidx_contigs(assembly)
    for path in GENCODE_GTF.values():
        if path.exists():
            _tabix_contigs(str(path))

@router.get("/gene")
def local_gene(assembly: str, query: str) -> dict:
    key = query.strip().upper().split(".", 1)[0]
    gene = _gene_index(assembly).get(key)
    if not gene:
        raise HTTPException(status_code=404, detail=f"gene {query} not found locally")
    return gene


@router.get("/sequence")
def local_sequence(assembly: str, chrom: str, start: int, end: int) -> dict:
    if assembly not in GENOME_FASTA or not SAMTOOLS or not _faidx_ready(assembly):
        raise HTTPException(status_code=404, detail=f"local sequence unavailable for {assembly}")
    if start < 1 or end < start or end - start + 1 > 300_000:
        raise HTTPException(status_code=422, detail="invalid or oversized sequence interval")
    try:
        seq = _local_sequence(assembly, chrom, start, end)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"seq": seq.upper()}


_GTF_ATTR_RE = re.compile(r'(\w+)\s+(?:"([^"]*)"|([^;]+));')


def _gtf_attrs(text: str) -> Dict[str, str]:
    return {
        match.group(1): (match.group(2) or match.group(3) or "").strip()
        for match in _GTF_ATTR_RE.finditer(text)
    }


def _stable_id(value: str) -> str:
    return value.split(".", 1)[0]


@lru_cache(maxsize=4096)
def _offtarget_gene_overview(assembly: str, gene_id: str) -> Optional[dict]:
    gene = _gene_index(assembly).get(gene_id.upper())
    if not gene:
        return None
    overview = {
        "name": gene["name"], "id": gene["id"], "chrom": gene["chrom"],
        "start": gene["start"], "end": gene["end"], "strand": gene["strand"], "exons": [],
    }
    try:
        canonical = canonical_gene_exons(assembly=assembly, query=gene_id)
    except Exception:
        return overview
    overview["exons"] = [
        {"start": exon["start"], "end": exon["end"], "rank": exon.get("rank")}
        for exon in canonical.get("exons", [])
    ]
    overview["transcript"] = canonical.get("transcript", {}).get("name")
    return overview


@lru_cache(maxsize=8192)
def _offtarget_feature_context(assembly: str, chrom: str, start: int, end: int) -> Optional[dict]:
    """Return canonical-transcript context for a short genomic match from local GENCODE."""
    nearest = _nearest_gene(assembly, chrom, start, end)
    if not nearest:
        return None
    overview = _offtarget_gene_overview(assembly, nearest["id"])
    if nearest["distance"] != 0:
        return {"region": "intergenic", "overview": overview}
    path = GENCODE_GTF.get(assembly)
    if not TABIX or not path or not path.exists() or not Path(str(path) + ".tbi").exists():
        return {"region": "genic", "overview": overview}

    transcripts: Dict[str, dict] = {}
    features: List[dict] = []
    for line in _tabix_query(path, chrom, max(1, start - 2), end + 2, limit=20_000):
        fields = line.split("\t")
        if len(fields) != 9:
            continue
        feature_type = fields[2]
        if feature_type not in {"transcript", "exon", "CDS", "UTR", "five_prime_utr", "three_prime_utr"}:
            continue
        attrs = _gtf_attrs(fields[8])
        if _stable_id(attrs.get("gene_id", "")) != nearest["id"]:
            continue
        transcript_id = _stable_id(attrs.get("transcript_id", ""))
        if not transcript_id:
            continue
        if feature_type == "transcript":
            tags = fields[8]
            transcripts[transcript_id] = {
                "id": transcript_id,
                "name": attrs.get("transcript_name") or transcript_id,
                "strand": -1 if fields[6] == "-" else 1,
                "score": (
                    4 if "MANE_Select" in tags else
                    3 if "Ensembl_canonical" in tags else
                    2 if "appris_principal" in tags else
                    1 if "GENCODE_Primary" in tags else 0
                ),
                "proteinCoding": attrs.get("transcript_type") == "protein_coding",
            }
            continue
        rank_text = attrs.get("exon_number", "")
        features.append({
            "type": feature_type, "transcript": transcript_id,
            "start": int(fields[3]), "end": int(fields[4]),
            "strand": -1 if fields[6] == "-" else 1,
            "rank": int(rank_text) if rank_text.isdigit() else None,
        })

    if not transcripts:
        return {"region": "genic", "overview": overview}
    transcript = max(
        transcripts.values(),
        key=lambda item: (item["score"], item["proteinCoding"], item["id"]),
    )
    transcript_features = [item for item in features if item["transcript"] == transcript["id"]]
    exact = [item for item in transcript_features if item["end"] >= start and item["start"] <= end]
    exons = [item for item in exact if item["type"] == "exon"]
    coding = any(item["type"] == "CDS" for item in exact)
    utr = any(item["type"] in {"UTR", "five_prime_utr", "three_prime_utr"} for item in exact)
    region = "CDS" if coding else "UTR" if utr else "exon" if exons else "intron"

    splice_sites = []
    nearby_exons = [item for item in transcript_features if item["type"] == "exon"]
    for exon in nearby_exons:
        boundaries = (
            (exon["start"], "acceptor" if exon["strand"] == 1 else "donor"),
            (exon["end"], "donor" if exon["strand"] == 1 else "acceptor"),
        )
        for boundary, kind in boundaries:
            distance = 0 if start <= boundary <= end else min(abs(start - boundary), abs(end - boundary))
            if distance <= 2 and kind not in splice_sites:
                splice_sites.append(kind)

    exon_ranks = sorted({item["rank"] for item in exons if item["rank"] is not None})
    return {
        "region": region,
        "exons": exon_ranks,
        "spliceSites": splice_sites,
        "transcript": transcript["name"],
        "transcriptId": transcript["id"],
        "canonical": transcript["score"] >= 3,
        "overview": overview,
    }


@lru_cache(maxsize=128)
def _local_annotations_cached(assembly: str, chrom: str, start: int, end: int) -> dict:
    path = GENCODE_GTF.get(assembly)
    if (
        not TABIX or not path or not path.exists()
        or not Path(str(path) + ".tbi").exists()
    ):
        raise HTTPException(status_code=404, detail=f"local annotations unavailable for {assembly}")
    if start < 1 or end < start or end - start + 1 > 250_000:
        raise HTTPException(status_code=422, detail="invalid or oversized annotation interval")

    genes: List[dict] = []
    transcripts: List[dict] = []
    exons: List[dict] = []
    coding: List[dict] = []
    for line in _tabix_query(path, chrom, start, end, limit=100_000):
        fields = line.split("\t")
        if len(fields) != 9:
            continue
        _seqname, source, feature_type, f_start, f_end, _score, strand, phase, attr_text = fields
        if feature_type not in {"gene", "transcript", "exon", "CDS"}:
            continue
        attrs = _gtf_attrs(attr_text)
        item_start, item_end = int(f_start), int(f_end)
        item_strand = -1 if strand == "-" else 1
        gene_id = _stable_id(attrs.get("gene_id", ""))
        transcript_id = _stable_id(attrs.get("transcript_id", ""))

        if feature_type == "gene":
            genes.append({
                "id": gene_id, "level": "gene",
                "name": attrs.get("gene_name") or gene_id,
                "biotype": attrs.get("gene_type", ""),
                "source": source, "description": "",
                "start": item_start, "end": item_end, "strand": item_strand,
            })
        elif feature_type == "transcript":
            tags = attr_text
            transcripts.append({
                "id": transcript_id, "level": "transcript",
                "name": attrs.get("transcript_name") or transcript_id,
                "biotype": attrs.get("transcript_type", ""),
                "source": source, "gene": gene_id,
                "tsl": attrs.get("transcript_support_level"),
                "isCanonical": any(
                    f'tag "{tag}"' in tags
                    for tag in ("Ensembl_canonical", "GENCODE_Primary", "MANE_Select")
                ),
                "start": item_start, "end": item_end, "strand": item_strand,
            })
        elif feature_type == "exon":
            exons.append({
                "id": _stable_id(attrs.get("exon_id", "")),
                "level": "exon", "transcript": transcript_id,
                "rank": int(attrs["exon_number"]) if attrs.get("exon_number", "").isdigit() else None,
                "start": item_start, "end": item_end, "strand": item_strand,
            })
        else:
            coding.append({
                "transcript": transcript_id,
                "start": item_start, "end": item_end, "strand": item_strand,
                "phase": int(phase) if phase.isdigit() else 0,
            })

    return {
        "features": {"genes": genes, "transcripts": transcripts, "exons": exons},
        "coding": coding,
    }



@router.get("/annotations")
def local_annotations(assembly: str, chrom: str, start: int, end: int) -> dict:
    with _region_lock("annotations", assembly, chrom, start, end):
        return _local_annotations_cached(assembly, chrom, start, end)

@router.get("/gene-exons")
@lru_cache(maxsize=512)
def canonical_gene_exons(assembly: str, query: str) -> dict:
    key = query.strip().upper().split(".", 1)[0]
    gene = _gene_index(assembly).get(key)
    path = GENCODE_GTF.get(assembly)
    if (
        not gene or not TABIX or not path or not path.exists()
        or not Path(str(path) + ".tbi").exists()
    ):
        raise HTTPException(status_code=404, detail=f"canonical exons unavailable for {query}")

    gene_id = gene["id"]
    transcripts: Dict[str, dict] = {}
    exons_by_transcript: Dict[str, List[dict]] = {}
    coding_by_transcript: Dict[str, List[dict]] = {}
    for line in _tabix_query(
        path, gene["chrom"], gene["start"], gene["end"], limit=200_000,
    ):
        fields = line.split("\t")
        if len(fields) != 9 or fields[2] not in {"transcript", "exon", "CDS"}:
            continue
        attrs = _gtf_attrs(fields[8])
        if _stable_id(attrs.get("gene_id", "")) != gene_id:
            continue
        transcript_id = _stable_id(attrs.get("transcript_id", ""))
        if not transcript_id:
            continue

        if fields[2] == "transcript":
            tags = fields[8]
            canonical_score = (
                3 if 'tag "Ensembl_canonical"' in tags else
                2 if 'tag "MANE_Select"' in tags else
                1 if 'tag "GENCODE_Primary"' in tags else 0
            )
            transcripts[transcript_id] = {
                "id": transcript_id,
                "name": attrs.get("transcript_name") or transcript_id,
                "strand": -1 if fields[6] == "-" else 1,
                "score": canonical_score,
                "protein_coding": attrs.get("transcript_type") == "protein_coding",
            }
        elif fields[2] == "exon":
            rank = attrs.get("exon_number", "")
            exons_by_transcript.setdefault(transcript_id, []).append({
                "id": _stable_id(attrs.get("exon_id", "")),
                "rank": int(rank) if rank.isdigit() else None,
                "start": int(fields[3]),
                "end": int(fields[4]),
            })
        else:
            coding_by_transcript.setdefault(transcript_id, []).append({
                "start": int(fields[3]),
                "end": int(fields[4]),
            })

    candidates = [
        transcript for transcript in transcripts.values()
        if exons_by_transcript.get(transcript["id"])
    ]
    if not candidates:
        raise HTTPException(status_code=404, detail=f"no canonical transcript exons for {query}")
    transcript = max(
        candidates,
        key=lambda item: (
            item["score"],
            item["protein_coding"],
            len(exons_by_transcript[item["id"]]),
        ),
    )
    exons = sorted(
        exons_by_transcript[transcript["id"]],
        key=lambda exon: (exon["start"], exon["end"]),
    )
    coding = sorted(
        coding_by_transcript.get(transcript["id"], []),
        key=lambda segment: (segment["start"], segment["end"]),
    )
    cds_start = None
    if coding:
        cds_start = (
            min(segment["start"] for segment in coding) if transcript["strand"] == 1
            else max(segment["end"] for segment in coding)
        )
    return {
        "gene": {
            "id": gene_id, "name": gene["name"],
            "start": gene["start"], "end": gene["end"], "strand": gene["strand"],
            "description": gene.get("description", ""),
        },
        "transcript": {
            "id": transcript["id"],
            "name": transcript["name"],
            "strand": transcript["strand"],
        },
        "chrom": gene["chrom"],
        "exons": exons,
        "coding": coding,
        "cdsStart": cds_start,
    }


def offtarget_ready(assembly: str) -> bool:
    return bool(BOWTIE and SAMTOOLS) and _bowtie_index_ready(assembly) and _faidx_ready(assembly)


class OffTargetRequest(BaseModel):
    assembly: str
    pam: str = "NGG"
    guides: List[dict]  # [{id, spacer, chrom, cutGenomic}]


class SpacerMatchRequest(BaseModel):
    assembly: str
    spacer: str
    pam: str = "NGG"


class AdvancedOffTargetRequest(BaseModel):
    assembly: str
    pam: str = "NGG"
    guide: dict  # {id, spacer, chrom, cutGenomic, protoGenomic}

class GuideOffTargets(BaseModel):
    id: str
    counts: Dict[str, int]     # genomic matches by mismatch, on-target included: {"0":1,"1":0,"2":0}
    unique: bool               # True when the pattern is 1-0-0 (only the on-target)
    top: List[dict]            # matches other than the on-target: {chrom,pos,strand,mm,pam}
    truncated: bool = False    # Bowtie reached the safety ceiling for this guide


class OffTargetResponse(BaseModel):
    available: bool
    guides: List[GuideOffTargets] = []
    detail: Optional[str] = None


_offtarget_cache: OrderedDict[tuple, dict] = OrderedDict()
_offtarget_cache_lock = threading.Lock()
_spacer_match_cache: OrderedDict[tuple, dict] = OrderedDict()
_spacer_match_cache_lock = threading.Lock()
_advanced_offtarget_cache: OrderedDict[tuple, dict] = OrderedDict()
_advanced_offtarget_cache_lock = threading.Lock()


_CIGAR_RE = re.compile(r"(\d+)([=XID])")


def _canonical_search_contigs(assembly: str) -> tuple[tuple[str, int], ...]:
    """Nuclear primary contigs only; skip decoys/alts and mitochondrial DNA."""
    maximum = 19 if assembly == "GRCm39" else 22
    allowed = {str(value) for value in range(1, maximum + 1)} | {"X", "Y"}
    fai = Path(str(_faidx_fasta(assembly)) + ".fai")
    if not fai.exists():
        return ()
    result = []
    with fai.open() as handle:
        for line in handle:
            fields = line.rstrip("\n").split("\t")
            if len(fields) >= 2 and fields[0].removeprefix("chr").upper() in allowed:
                result.append((fields[0], int(fields[1])))
    return tuple(result)


def _load_faidx_region(assembly: str, contig: str, start: int, end: int) -> bytes:
    """Read a bounded indexed region; advanced search never holds a chromosome."""
    proc = subprocess.Popen(
        [SAMTOOLS, "faidx", str(_faidx_fasta(assembly)), f"{contig}:{start}-{end}"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    sequence = bytearray()
    assert proc.stdout is not None
    for line in proc.stdout:
        if not line.startswith(b">"):
            sequence.extend(line.strip())
    stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(stderr.strip() or f"samtools faidx failed for {contig}:{start}-{end}")
    result = bytes(sequence).upper()
    sequence.clear()
    return result


def _sassy_alignment(query: str, matched: str, cigar: str) -> dict:
    """Expand Sassy CIGAR into fixed columns and locate PAM-proximal seed edits."""
    query_index = match_index = 0
    query_aligned: List[str] = []
    match_aligned: List[str] = []
    seed_columns: List[int] = []
    substitutions = insertions = deletions = 0
    operations = _CIGAR_RE.findall(cigar)
    if not operations or "".join(f"{count}{op}" for count, op in operations) != cigar:
        raise ValueError(f"unsupported Sassy CIGAR {cigar}")
    for count_text, operation in operations:
        for _ in range(int(count_text)):
            column = len(query_aligned)
            if operation in {"=", "X"}:
                query_aligned.append(query[query_index])
                match_aligned.append(matched[match_index])
                if operation == "X":
                    substitutions += 1
                    if query_index >= 10:
                        seed_columns.append(column)
                query_index += 1
                match_index += 1
            elif operation == "I":
                # Sassy I consumes query only: guide/RNA bulge relative to DNA.
                query_aligned.append(query[query_index])
                match_aligned.append("-")
                insertions += 1
                if query_index >= 10:
                    seed_columns.append(column)
                query_index += 1
            else:  # D consumes target text only: DNA bulge relative to guide.
                query_aligned.append("-")
                match_aligned.append(matched[match_index])
                deletions += 1
                if query_index >= 10:
                    seed_columns.append(column)
                match_index += 1
    if query_index != len(query) or match_index != len(matched):
        raise ValueError(f"CIGAR {cigar} does not span the query and match")
    bulge_type = (
        "mixed bulges" if insertions and deletions else
        "RNA bulge" if insertions else
        "DNA bulge" if deletions else None
    )
    return {
        "queryAligned": "".join(query_aligned),
        "matchAligned": "".join(match_aligned),
        "seedColumns": seed_columns,
        "seedEditCount": len(seed_columns),
        "substitutions": substitutions,
        "insertions": insertions,
        "deletions": deletions,
        "bulgeType": bulge_type,
    }


def _advanced_hit_sort_key(hit: dict, guide: dict) -> tuple:
    query_chrom = str(guide.get("chrom", "")).removeprefix("chr").upper()
    hit_chrom = str(hit.get("chrom", "")).removeprefix("chr").upper()
    query_position = int(guide.get("protoGenomic") or guide.get("cutGenomic") or 0)
    try:
        hit_rank = int(hit_chrom)
    except ValueError:
        hit_rank = 23 if hit_chrom == "X" else 24 if hit_chrom == "Y" else 1000
    try:
        query_rank = int(query_chrom)
    except ValueError:
        query_rank = 23 if query_chrom == "X" else 24 if query_chrom == "Y" else 1000
    return (
        int(hit["cost"]),
        0 if hit_chrom == query_chrom else 1,
        abs(int(hit["pos"]) - query_position) if hit_chrom == query_chrom else abs(hit_rank - query_rank),
        hit_rank,
        int(hit["pos"]),
    )


def _advanced_offtargets(
    req: AdvancedOffTargetRequest,
    on_progress=None,
    cancel_event: Optional[threading.Event] = None,
) -> dict:
    """Opt-in edit-distance search (substitutions plus DNA/RNA bulges) via Sassy."""
    assembly = req.assembly
    spacer = str(req.guide.get("spacer", "")).strip().upper()
    pam_pattern = req.pam.strip().upper()
    if assembly not in GENOME_FASTA:
        raise HTTPException(status_code=422, detail=f"unsupported assembly {assembly}")
    if not re.fullmatch(r"[ACGT]{20}", spacer):
        raise HTTPException(status_code=422, detail="guide spacer must be exactly 20 A/C/G/T bases")
    if not re.fullmatch(r"[ACGTRYSWKMBDHVN]{1,8}", pam_pattern):
        raise HTTPException(status_code=422, detail="invalid PAM pattern")
    if sassy is None:
        return {"available": False, "detail": "advanced search unavailable: install sassy-rs"}
    if not SAMTOOLS or not _faidx_ready(assembly):
        return {"available": False, "detail": "indexed reference genome unavailable"}

    cache_key = _offtarget_cache_key(assembly, pam_pattern, req.guide)
    with _advanced_offtarget_cache_lock:
        cached = _advanced_offtarget_cache.get(cache_key)
        if cached is not None:
            _advanced_offtarget_cache.move_to_end(cache_key)
            return cached

    started = time.monotonic()
    query = spacer.encode("ascii")
    pam_length = len(pam_pattern)
    hits_by_locus: Dict[tuple, dict] = {}
    truncated = False
    overlap = 20 + pam_length + 2
    timed_out = False
    chunk_size = max(1_000_000, ADVANCED_OFFTARGET_CHUNK_BP)
    search_contigs = _canonical_search_contigs(assembly)
    completed_contigs: List[str] = []
    total_contigs = len(search_contigs)
    for contig, contig_length in search_contigs:
        contig_label = str(contig).removeprefix("chr")
        if on_progress:
            on_progress({
                "type": "progress",
                "current": contig_label,
                "completed": completed_contigs.copy(),
                "completedCount": len(completed_contigs),
                "total": total_contigs,
            })
        for core_start0 in range(0, contig_length, chunk_size):
            if cancel_event is not None and cancel_event.is_set():
                return {"available": False, "cancelled": True, "detail": "advanced search cancelled"}
            if time.monotonic() - started > ADVANCED_OFFTARGET_TIMEOUT:
                truncated = timed_out = True
                break
            core_end0 = min(contig_length, core_start0 + chunk_size)
            fetch_start0 = max(0, core_start0 - overlap)
            fetch_end0 = min(contig_length, core_end0 + overlap)
            chromosome = _load_faidx_region(
                assembly, contig, fetch_start0 + 1, fetch_end0,
            )
            # A fresh searcher per chunk prevents native scratch state from
            # accumulating across a whole-genome scan. Construction is cheap
            # compared with reading the reference and keeps peak RSS bounded.
            searcher = sassy.Searcher("dna", rc=True)
            for match in searcher.search_all(query, chromosome, 2):
                local_start0, local_end0 = int(match.text_start), int(match.text_end)
                start0, end0 = fetch_start0 + local_start0, fetch_start0 + local_end0
                if start0 < core_start0 or start0 >= core_end0:
                    continue
                reverse = match.strand == "-"
                if reverse:
                    pam_raw = chromosome[max(0, local_start0 - pam_length):local_start0].decode("ascii")
                    pam = _revcomp(pam_raw)
                else:
                    pam = chromosome[local_end0:local_end0 + pam_length].decode("ascii")
                if not _pam_ok(pam, pam_pattern):
                    continue
                raw_match = chromosome[local_start0:local_end0].decode("ascii")
                matched = _revcomp(raw_match) if reverse else raw_match
                try:
                    alignment = _sassy_alignment(spacer, matched, match.cigar)
                except (IndexError, ValueError):
                    continue
                hit = {
                    "chrom": contig,
                    "pos": start0 + 1,
                    "protoEnd": end0,
                    "strand": match.strand,
                    "mm": int(match.cost),
                    "cost": int(match.cost),
                    "pam": pam,
                    "sequence": matched,
                    "cigar": match.cigar,
                    **alignment,
                }
                locus_key = (contig, start0, end0, match.strand)
                previous = hits_by_locus.get(locus_key)
                if previous is None or (hit["cost"], bool(hit["bulgeType"])) < (previous["cost"], bool(previous["bulgeType"])):
                    hits_by_locus[locus_key] = hit
            del chromosome
        completed_contigs.append(contig_label)
        if on_progress:
            on_progress({
                "type": "progress",
                "current": None,
                "completed": completed_contigs.copy(),
                "completedCount": len(completed_contigs),
                "total": total_contigs,
            })
        if timed_out:
            break

    all_hits = sorted(hits_by_locus.values(), key=lambda hit: _advanced_hit_sort_key(hit, req.guide))
    # Count the same set that the modal renders. Sassy can return additional
    # gapped alignments at the intended locus; those are alternative
    # representations of the target, not distinct genomic off-targets.
    all_off_targets = [
        hit for hit in all_hits
        if not _same_locus(hit["chrom"], hit["pos"], req.guide)
    ]
    counts = {
        str(distance): sum(hit["cost"] == distance for hit in all_off_targets)
        for distance in range(3)
    }
    off_targets = all_off_targets[:ADVANCED_OFFTARGET_MAX_RESULTS]
    for hit in off_targets:
        hit["nearestGene"] = _nearest_gene(assembly, hit["chrom"], hit["pos"], hit["protoEnd"])
        hit["annotation"] = _offtarget_feature_context(
            assembly, hit["chrom"], hit["pos"], hit["protoEnd"],
        )
    payload = {
        "available": True,
        "counts": counts,
        "unique": counts["0"] <= 1 and counts["1"] == 0 and counts["2"] == 0,
        "top": off_targets,
        "advanced": True,
        "truncated": truncated or len(all_off_targets) > ADVANCED_OFFTARGET_MAX_RESULTS,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "detail": None,
    }
    with _advanced_offtarget_cache_lock:
        _advanced_offtarget_cache[cache_key] = payload
        _advanced_offtarget_cache.move_to_end(cache_key)
        while len(_advanced_offtarget_cache) > max(1, ADVANCED_OFFTARGET_CACHE_SIZE):
            _advanced_offtarget_cache.popitem(last=False)
    return payload


@router.post("/offtargets-advanced")
def advanced_offtargets(req: AdvancedOffTargetRequest) -> dict:
    """Compatibility endpoint for clients that do not consume streamed progress."""
    return _advanced_offtargets(req)


@router.post("/offtargets-advanced-stream")
def advanced_offtargets_stream(req: AdvancedOffTargetRequest) -> StreamingResponse:
    """Stream chromosome-level progress followed by the completed advanced search."""
    updates: queue.Queue = queue.Queue()
    cancelled = threading.Event()

    def publish(event: dict) -> None:
        if not cancelled.is_set():
            updates.put(event)

    def run_search() -> None:
        try:
            result = _advanced_offtargets(req, on_progress=publish, cancel_event=cancelled)
            if not cancelled.is_set():
                publish({"type": "result", "payload": result})
        except HTTPException as exc:
            publish({"type": "error", "detail": str(exc.detail), "status": exc.status_code})
        except Exception as exc:
            publish({"type": "error", "detail": str(exc)})
        finally:
            updates.put(None)

    threading.Thread(target=run_search, name="advanced-offtarget-search", daemon=True).start()

    def stream():
        try:
            while True:
                event = updates.get()
                if event is None:
                    break
                yield json.dumps(event, separators=(",", ":")) + "\n"
        finally:
            cancelled.set()

    return StreamingResponse(
        stream(),
        # Starlette deliberately skips gzip buffering for event streams, so
        # each NDJSON progress record reaches the browser immediately.
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
    )


def _offtarget_cache_key(assembly: str, pam: str, guide: dict) -> tuple:
    return (
        assembly,
        pam.upper(),
        str(guide.get("spacer", "")).upper(),
        str(guide.get("chrom", "")).removeprefix("chr"),
        guide.get("cutGenomic"),
    )


def _cached_offtargets(
    assembly: str, pam: str, guides: List[dict],
) -> tuple[Dict[str, GuideOffTargets], List[dict]]:
    cached: Dict[str, GuideOffTargets] = {}
    missing: List[dict] = []
    with _offtarget_cache_lock:
        for guide in guides:
            key = _offtarget_cache_key(assembly, pam, guide)
            value = _offtarget_cache.get(key)
            if value is None:
                missing.append(guide)
                continue
            _offtarget_cache.move_to_end(key)
            guide_id = str(guide.get("id", ""))
            cached[guide_id] = GuideOffTargets(id=guide_id, **value)
    return cached, missing


def _store_offtarget(
    assembly: str, pam: str, guide: dict, result: GuideOffTargets,
) -> None:
    key = _offtarget_cache_key(assembly, pam, guide)
    with _offtarget_cache_lock:
        _offtarget_cache[key] = {
            "counts": result.counts,
            "unique": result.unique,
            "top": result.top,
            "truncated": result.truncated,
        }
def _pam_ok(seq3: str, pam: str) -> bool:
    seq3 = seq3.upper()
    return len(seq3) >= len(pam) and all(
        base in IUPAC_BASES.get(code, "") for base, code in zip(seq3, pam)
    )


@router.post("/spacer-matches")
def spacer_matches(req: SpacerMatchRequest) -> dict:
    assembly = req.assembly
    spacer = req.spacer.strip().upper()
    pam_pattern = req.pam.strip().upper()
    if assembly not in GENOME_FASTA:
        raise HTTPException(status_code=422, detail=f"unsupported assembly {assembly}")
    if not re.fullmatch(r"[ACGT]{20}", spacer):
        raise HTTPException(status_code=422, detail="spacer must be exactly 20 A/C/G/T bases")
    if not re.fullmatch(r"[ACGTRYSWKMBDHVN]{1,8}", pam_pattern):
        raise HTTPException(status_code=422, detail="invalid PAM pattern")
    if not offtarget_ready(assembly):
        return {"available": False, "matches": [], "detail": "genome search index unavailable"}

    cache_key = (assembly, spacer, pam_pattern)
    with _spacer_match_cache_lock:
        cached = _spacer_match_cache.get(cache_key)
        if cached is not None:
            _spacer_match_cache.move_to_end(cache_key)
            return cached

    concrete_pams = [""]
    for code in pam_pattern:
        concrete_pams = [prefix + base for prefix in concrete_pams for base in IUPAC_BASES[code]]
        if len(concrete_pams) > 256:
            raise HTTPException(status_code=422, detail="PAM pattern is too degenerate for spacer lookup")
    reads = "".join(f">pam{i}\n{spacer}{concrete}\n" for i, concrete in enumerate(concrete_pams))
    try:
        proc = subprocess.run(
            [BOWTIE, "--mm", "--sam-nohead", "-x", str(_bowtie_index_prefix(assembly)), "-f", "-", "-v", "0",
             "-k", str(MAX_SPACER_ALIGNMENTS), "-p", str(BOWTIE_THREADS), "--quiet", "-S"],
            input=reads, capture_output=True, text=True, timeout=300,
        )
    except Exception as exc:
        return {"available": False, "matches": [], "detail": f"bowtie failed: {exc}"}
    if proc.returncode != 0:
        detail = proc.stderr.strip() or f"exit code {proc.returncode}"
        return {"available": False, "matches": [], "detail": f"bowtie failed: {detail}"}

    pam_len = len(pam_pattern)
    hits_by_read: Dict[str, int] = {}
    matches_by_key = {}
    for line in proc.stdout.splitlines():
        if line.startswith("@"):
            continue
        fields = line.split("\t")
        if len(fields) < 6 or fields[2] == "*":
            continue
        read_name = fields[0]
        try:
            pam_seq = concrete_pams[int(read_name.removeprefix("pam"))]
        except (ValueError, IndexError):
            continue
        hits_by_read[read_name] = hits_by_read.get(read_name, 0) + 1
        chrom = fields[2]
        alignment_start = int(fields[3])
        reverse = bool(int(fields[1]) & 16)
        if reverse:
            pam_start = alignment_start
            proto_start = alignment_start + pam_len
        else:
            proto_start = alignment_start
            pam_start = alignment_start + 20
        match = {
            "chrom": chrom,
            "protoStart": proto_start,
            "protoEnd": proto_start + 19,
            "pamStart": pam_start,
            "pamEnd": pam_start + pam_len - 1,
            "pam": pam_seq,
            "strand": "-" if reverse else "+",
            "cutGenomic": proto_start + 3 if reverse else proto_start + 17,
        }
        matches_by_key[(chrom, proto_start, match["strand"])] = match

    matches = sorted(
        matches_by_key.values(), key=lambda item: (item["chrom"], item["protoStart"], item["strand"]),
    )
    display_matches = matches[:MAX_SPACER_MATCHES]
    for match in display_matches:
        match["nearestGene"] = _nearest_gene(
            assembly, match["chrom"], match["protoStart"], match["protoEnd"],
        )
        match["annotation"] = _offtarget_feature_context(
            assembly, match["chrom"], match["protoStart"], match["protoEnd"],
        )
    truncated = any(count >= MAX_SPACER_ALIGNMENTS for count in hits_by_read.values()) or len(matches) > MAX_SPACER_MATCHES
    payload = {
        "available": True,
        "matches": display_matches,
        "truncated": truncated,
        "detail": None,
    }
    with _spacer_match_cache_lock:
        _spacer_match_cache[cache_key] = payload
        _spacer_match_cache.move_to_end(cache_key)
        while len(_spacer_match_cache) > 1024:
            _spacer_match_cache.popitem(last=False)
    return payload

@router.post("/offtargets", response_model=OffTargetResponse)
def offtargets(req: OffTargetRequest) -> OffTargetResponse:
    assembly = req.assembly
    if assembly not in GENOME_FASTA:
        raise HTTPException(status_code=422, detail=f"unsupported assembly {assembly}")
    if len(req.guides) > MAX_GUIDES:
        raise HTTPException(
            status_code=422,
            detail=f"too many guides ({len(req.guides)} > {MAX_GUIDES})",
        )
    if not re.fullmatch(r"[ACGTRYSWKMBDHVN]{1,8}", req.pam.upper()):
        raise HTTPException(status_code=422, detail="invalid PAM pattern")
    if any(
        not re.fullmatch(r"[ACGT]{20}", str(g.get("spacer", "")).upper())
        for g in req.guides
    ):
        raise HTTPException(status_code=422, detail="guide spacers must be 20 A/C/G/T bases")
    if not offtarget_ready(assembly):
        return OffTargetResponse(
            available=False,
            detail="off-target index not built; run scripts/build_offtarget_index.sh",
        )

    cached, guides = _cached_offtargets(assembly, req.pam, req.guides)
    if not guides:
        return OffTargetResponse(
            available=True,
            guides=[cached[str(g.get("id", ""))] for g in req.guides],
        )

    index_prefix = str(_bowtie_index_prefix(assembly))
    faidx = _faidx_fasta(assembly)

    # One bowtie run over all spacers. Reads are the 20 nt protospacers.
    reads = "".join(
        f">{i}\n{g['spacer']}\n" for i, g in enumerate(guides) if len(g.get("spacer", "")) == 20
    )
    if not reads:
        return OffTargetResponse(available=True, guides=[])

    try:
        proc = subprocess.run(
            [BOWTIE, "--mm", "--sam-nohead", "-x", index_prefix, "-f", "-", "-v", str(MAX_MM),
             "-k", str(MAX_HITS), "-p", str(BOWTIE_THREADS), "--quiet", "-S"],
            input=reads, capture_output=True, text=True, timeout=300,
        )
    except Exception as exc:
        return OffTargetResponse(available=False, detail=f"bowtie failed: {exc}")
    if proc.returncode != 0:
        detail = proc.stderr.strip() or f"exit code {proc.returncode}"
        return OffTargetResponse(available=False, detail=f"bowtie failed: {detail}")

    # Collect hits per read. Fetch each 20-nt protospacer and its adjacent PAM
    # as one 23-nt interval instead of two separate faidx intervals.
    hits: Dict[int, list] = {}
    regions: list = []
    for line in proc.stdout.splitlines():
        if line.startswith("@"):
            continue
        f = line.split("\t")
        if len(f) < 6 or f[2] == "*":
            continue
        read_i = int(f[0])
        flag = int(f[1])
        chrom = f[2]
        pos = int(f[3])  # 1-based leftmost
        rev = bool(flag & 16)
        mm = 0
        m = re.search(r"NM:i:(\d+)", line)
        if m:
            mm = int(m.group(1))
        # PAM is 3 nt 3' of the protospacer on the guide strand.
        if not rev:
            pam_start, pam_end = pos + 20, pos + 22
        else:
            pam_start, pam_end = pos - 3, pos - 1
        fetch_start = max(1, pos - 3) if rev else pos
        fetch_end = pos + 19 if rev else pos + 22
        fetch_region = f"{chrom}:{fetch_start}-{fetch_end}"
        regions.append(fetch_region)
        hits.setdefault(read_i, []).append(
            {"chrom": chrom, "pos": pos, "rev": rev, "mm": mm,
             "pam_region": (chrom, pam_start, pam_end), "fetch_region": fetch_region}
        )

    pam_seq = _faidx_batch(faidx, regions)

    computed: Dict[str, GuideOffTargets] = {}
    for i, g in enumerate(guides):
        guide_hits = hits.get(i, [])
        counts = {str(k): 0 for k in range(MAX_MM + 1)}
        top = []
        for h in guide_hits:
            chrom, _, _ = h["pam_region"]
            raw = pam_seq.get(h["fetch_region"], "").upper()
            if h["rev"]:
                pam = _revcomp(raw[:3])
                site = _revcomp(raw[3:23])
            else:
                site = raw[:20]
                pam = raw[20:23]
            if not _pam_ok(pam, req.pam):
                continue
            # Count every genomic match (the on-target is included, so a truly
            # unique guide reads 1-0-0). List everything except the on-target as
            # a potential off-target.
            counts[str(h["mm"])] = counts.get(str(h["mm"]), 0) + 1
            if not (g.get("chrom") and _same_locus(chrom, h["pos"], g)):
                top.append({"chrom": chrom, "pos": h["pos"],
                            "strand": "-" if h["rev"] else "+", "mm": h["mm"],
                            "pam": pam, "sequence": site})
        top.sort(key=lambda t: t["mm"])
        for hit in top:
            hit["nearestGene"] = _nearest_gene(
                assembly, hit["chrom"], hit["pos"], hit["pos"] + 19,
            )
            hit["annotation"] = _offtarget_feature_context(
                assembly, hit["chrom"], hit["pos"], hit["pos"] + 19,
            )
        unique = counts.get("0", 0) <= 1 and all(
            counts.get(str(k), 0) == 0 for k in range(1, MAX_MM + 1)
        )
        result = GuideOffTargets(
            id=str(g.get("id", i)), counts=counts, unique=unique, top=top,
            truncated=len(guide_hits) >= MAX_HITS,
        )
        computed[result.id] = result
        _store_offtarget(assembly, req.pam, g, result)
    return OffTargetResponse(
        available=True,
        guides=[
            computed.get(str(g.get("id", ""))) or cached[str(g.get("id", ""))]
            for g in req.guides
        ],
    )


def _same_locus(chrom: str, pos: int, guide: dict) -> bool:
    gchrom = str(guide.get("chrom", "")).replace("chr", "")
    if chrom.replace("chr", "") != gchrom:
        return False
    cut = guide.get("cutGenomic")
    return cut is not None and abs(pos - cut) < 30


def _faidx_batch(faidx: Path, regions: list) -> Dict[str, str]:
    """Fetch many small regions in one samtools faidx call: {region: seq}."""
    if not regions or not SAMTOOLS:
        return {}
    uniq = list(dict.fromkeys(regions))
    out: Dict[str, str] = {}
    stdout_parts = []
    try:
        for start in range(0, len(uniq), FAIDX_BATCH_SIZE):
            proc = subprocess.run(
                [SAMTOOLS, "faidx", str(faidx), *uniq[start:start + FAIDX_BATCH_SIZE]],
                capture_output=True, text=True, timeout=120,
            )
            if proc.returncode == 0:
                stdout_parts.append(proc.stdout)
    except Exception:
        return {}
    name = None
    buf = []
    for line in "\n".join(stdout_parts).splitlines():
        if line.startswith(">"):
            if name is not None:
                out[name] = "".join(buf)
            name = line[1:].strip()
            buf = []
        else:
            buf.append(line.strip())
    if name is not None:
        out[name] = "".join(buf)
    return out
