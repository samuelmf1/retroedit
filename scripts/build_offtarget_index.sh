#!/usr/bin/env bash
# Build the bowtie index + faidx genome used by the off-target search.
# One-time, ~1-2 h and ~4 GB per assembly. Safe to re-run (skips finished steps).
#
#   scripts/build_offtarget_index.sh GRCh38
#
set -euo pipefail

ASM="${1:-GRCh38}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${REFERENCE_DIR:-$ROOT/reference}"
BIN="${BOWTIE_DIR:-$ROOT/.conda-env/bin}"
SRC="$REF/${ASM}.primary_assembly.genome.fa.gz"
OUT="${INDEX_DIR:-$ROOT/index}"
mkdir -p "$OUT"

[ -f "$SRC" ] || { echo "missing genome: $SRC" >&2; exit 1; }

FA="$OUT/${ASM}.faidx.fa"            # plain fasta (temporary, for bowtie-build)
BGZ="$OUT/${ASM}.faidx.fa.gz"        # bgzip fasta for samtools faidx

if [ ! -f "${BGZ}.fai" ]; then
  echo "[1/3] decompressing genome to plain FASTA"
  gunzip -c "$SRC" > "$FA"
  echo "[2/3] bgzip + faidx for random PAM lookups"
  "$BIN/bgzip" -c "$FA" > "$BGZ"
  "$BIN/samtools" faidx "$BGZ"
fi

if [ ! -f "$OUT/${ASM}.bowtie.1.ebwt" ] && [ ! -f "$OUT/${ASM}.bowtie.1.ebwtl" ]; then
  echo "[3/3] building bowtie index (slow)"
  [ -f "$FA" ] || gunzip -c "$SRC" > "$FA"
  "$BIN/bowtie-build" --threads "$(sysctl -n hw.ncpu 2>/dev/null || nproc)" "$FA" "$OUT/${ASM}.bowtie"
fi

rm -f "$FA"
echo "done: off-target index ready for $ASM"
