# HDR Donor Designer

An interactive sequence viewer for designing CRISPR homology-directed-repair
(HDR) donor templates. Search a gene or locus, edit the reference (substitute,
insert, delete), and the app finds SpCas9 guides near your edit, scores them
with RuleSet3, and designs a repair template — including the silent
mutations needed to stop Cas9 from re-cutting the repaired allele.

## What it does

- **Search** by gene symbol (`BRCA2`), Ensembl ID (`ENSG00000139618`), or
  coordinates (`chr13:32,315,717-32,315,767`).
- **Switch genome builds** — Human GRCh38, Human GRCh37, and Mouse GRCm39 out of
  the box, plus an offline demo. Coordinates are read in the selected build; there
  is no liftover.
- **Edit** the sequence in a Benchling-style dual-strand viewer: type `A/C/G/T`
  to insert, double-click a base to mutate it, drag-select and `⌫` to delete.
- **Find guides** on both strands within 100 bp of any edit, for a configurable
  PAM (default `NGG`, IUPAC codes allowed) and tracrRNA scaffold (Chen 2013 or
  Hsu 2013). The PAM segment is drawn separately from the protospacer, with a
  notch at the SpCas9 cut site.
- **Score** every guide with **RuleSet3** (sequence model), re-ranking as you
  edit. The tracrRNA choice feeds RS3's `sequence_tracr` parameter.
- **Design an HDR donor** for the selected guide: symmetric homology arms
  (default 75 bp, adjustable), the edit carried in the template, and a disrupting
  mutation that disrupts the PAM or seed. In coding exons the disrupting mutation
  is made **synonymous**, verified against the transcript's reading frame.

## Running it

Two processes: the Vite web app and a small Python service that runs RuleSet3.

```bash
npm install
npm run dev:all      # web on :8000, RS3 service on :8001 (proxied at /api)
```

Or run them separately:

```bash
npm run dev          # web only — works fully, just without RS3 scores
npm run dev:api      # RS3 scoring service only
```

The web app is usable without the Python service; guides are still found and
donors still designed, but the RS3 column shows `off`.

## Custom DNA uploads

Users can upload plain DNA, single- or multi-record FASTA, or SnapGene `.dna` files up to 25 MB. SnapGene feature colors and CDS ranges are imported into the sequence viewer; CDS annotations also enable codon, amino-acid, and stop-codon context. The full uploaded file and sequence stay only in browser memory and are released when the page is closed or reloaded—they are never uploaded or written to server storage. Rule Set 3 receives only transient 30-base guide contexts for scoring, with server caching disabled for custom sequences.

Custom mode retains sequence editing, imported and user-created annotations, local guide discovery and off-target search, Rule Set 3 scoring, HDR repair-template design, and export. User annotations can be downloaded with the edited sequence as a SnapGene `.dna` file. Reference-database features such as locus navigation, gnomAD, and ClinVar are omitted.

## Production

Build the frontend whenever its source changes:

```bash
cd /opt/retroedit
/usr/bin/npm install
/usr/bin/npm run build
```

Run the built frontend and Python API together on port 8000 with one Uvicorn
worker. FastAPI serves the files in `dist/` and handles the `/api` routes:

```bash
cd /opt/retroedit
./.conda-env/bin/uvicorn server.app:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers 1
```

Use one worker because each worker loads its own RuleSet3 model and maintains a
separate scoring cache. The frontend build is not performed at service startup;
rerun `npm run build` as part of each frontend deployment, then restart the
service.

Verify the production service:

```bash
curl -fsS http://127.0.0.1:8000/ >/dev/null
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS http://127.0.0.1:8000/api/genomics/status
```

### Optional variant annotations

The gnomAD and ClinVar buttons query the official gnomAD GraphQL API through the
Python backend, so local VCF files are not required. Requests are made only when
a user enables a track. GRCh38 uses gnomAD v4 and GRCh37 uses gnomAD v2.1;
human variant tracks are unavailable for GRCm39.

Successful regional responses are shared by both tracks and cached in the
Uvicorn worker for 15 minutes. The defaults can be adjusted in the systemd
environment:

```ini
Environment=GNOMAD_API_URL=https://gnomad.broadinstitute.org/api
Environment=GNOMAD_API_TIMEOUT=15
Environment=GNOMAD_API_CACHE_TTL=900
Environment=GNOMAD_API_CACHE_SIZE=256
```

Set `GNOMAD_API_URL=` to disable remote variant annotations. If local indexed
VCFs are configured, the backend continues to prefer them and uses the API only
as a fallback.

### Concurrency safeguards

The application includes several limits for this 4 GB host:

- RuleSet3 predictions are serialized within the Uvicorn worker.
- Only one Bowtie off-target search can run at a time; additional requests get
  HTTP `429` with `Retry-After: 5` and the browser retries automatically.
- Off-target searches accept at most 100 guides and expensive request bodies are
  limited to 256 KiB.
- The browser waits one second after edits settle before starting Bowtie.
- Waiting RuleSet3 requests queue asynchronously instead of consuming the shared
  request thread pool.
- Reference sequences, GENCODE annotations, local variants, RuleSet3 scores, and
  completed Bowtie guide results use bounded in-memory caches shared by users.
- Simultaneous cold requests for the same sequence or annotation interval collapse
  into one indexed read.
- The browser deduplicates repeated immutable requests; fingerprinted production
  assets are gzip-compressed and cached as immutable for one year.

Cache limits can be tuned in the systemd unit without changing code:

```ini
Environment=RS3_CACHE_SIZE=20000
Environment=OFFTARGET_CACHE_SIZE=4096
```

Keep Uvicorn at `--workers 1`; multiple workers could each launch a memory-heavy
Bowtie process and duplicate the RuleSet3 model.

Add equivalent ingress limits to nginx (the `limit_req_zone` directive belongs
in the `http` block):

```nginx
# http context
limit_req_zone $binary_remote_addr zone=retroedit_offtarget:10m rate=12r/m;

# server context
client_max_body_size 256k;
location = /api/genomics/offtargets {
    limit_req zone=retroedit_offtarget burst=2 nodelay;
    proxy_pass http://127.0.0.1:8000;
    proxy_read_timeout 310s;
}
```

Recommended systemd resource safeguards for this host:

```ini
MemoryMax=3500M
TasksMax=128
Restart=on-failure
RestartSec=5
```

Restart and verify after deploying an application update:

```bash
sudo /bin/systemctl restart retroedit.service
sudo /bin/systemctl status retroedit.service --no-pager
```

## Running on NE1 cluster

NE1 uses environment modules for Node.js. A validated module here is
`nodejs/20.13.1-GCCcore-13.3.0`.

Load Node and install JS deps:

```bash
cd /gpfs/commons/projects/one-v-proteome/hdr
module purge
module load nodejs/20.13.1-GCCcore-13.3.0
npm install
```

Create the local RS3 environment once:

```bash
conda create -p ./.conda-env -c bioconda -c conda-forge -y \
  python=3.10 lightgbm=3.3.5 scikit-learn=1.0.2 numpy=1.26 pandas=2.2 \
  pyarrow biopython tqdm joblib seqfold bowtie=1.3.1 samtools
./.conda-env/bin/pip install --no-deps rs3 sglearn sassy-rs
./.conda-env/bin/pip install fastapi "uvicorn[standard]"
```

Run both services:

```bash
module purge
module load nodejs/20.13.1-GCCcore-13.3.0
npm run dev:all
```

If `8000` is already in use, run web and API separately:

```bash
module purge
module load nodejs/20.13.1-GCCcore-13.3.0
npm run dev -- --host 0.0.0.0 --port 8002
./.conda-env/bin/uvicorn server.app:app --host 127.0.0.1 --port 8001
```

Verify RS3 is online:

```bash
curl -sS http://127.0.0.1:8001/api/health
```

### The RuleSet3 service

`rs3` depends on older `scikit-learn`/`lightgbm` combinations, so this project
uses a dedicated environment at `./.conda-env`; recreate it with:

```bash
conda create -p ./.conda-env -c bioconda -c conda-forge -y \
  python=3.10 lightgbm=3.3.5 scikit-learn=1.0.2 numpy=1.26 pandas=2.2 \
  pyarrow biopython tqdm joblib seqfold bowtie=1.3.1 samtools
./.conda-env/bin/pip install --no-deps rs3 sglearn sassy-rs
./.conda-env/bin/pip install fastapi "uvicorn[standard]"
```

If the UI shows RS3 `off`, the backend is not running or missing dependencies.
Start it directly and verify health:

```bash
./.conda-env/bin/uvicorn server.app:app --host 127.0.0.1 --port 8001
curl -sS http://127.0.0.1:8001/api/health
```

`server/app.py` loads the model once, scores 30-mer contexts on a worker thread,
and caches by `(context, tracr)` so editing only re-scores the guides that moved.

### Trying Sassy searches

The Python environment includes the `sassy-rs` bindings. Run an approximate DNA
search with:

```bash
./.conda-env/bin/python - <<'PY'
import sassy

searcher = sassy.Searcher("iupac")
matches = searcher.search(b"ACTG", b"ACGGCTACGCAGCATCATCAGCAT", k=1)
for match in matches:
    print(match)
PY
```

Use the `dna` profile instead of `iupac` when both inputs contain only `ACGT`.

## How it fits together

```
src/lib/
  genomes.js     genome + provider registries (add builds / organisms here)
  genome.js      region loading; registers GRCh38/GRCh37/GRCm39 + demo
  providers/     ensembl.js (REST), static.js (in-memory / custom genomes)
  bio.js         IUPAC, complementation, pattern matching
  crispr.js      guide discovery, tracrRNA scaffolds, 30-mer contexts, ranking
  editModel.js   edit representation (ref-indexed base records) + coordinates
  codon.js       codon table, reading-frame map, synonymous-codon search
  hdr.js         donor design + silent disrupting mutations
  rs3.js         client for the scoring service
src/components/  Controls, EditBar, SequenceViewer, GuideTable, DonorPanel
server/app.py    RuleSet3 FastAPI service
```

### Adding a genome

Genomes are registered against a provider. To add a build or organism served by
Ensembl, one line in `src/lib/genome.js`:

```js
registerGenome({
  id: 'rat-mratbn72', organism: 'Rat', assembly: 'mRatBN7.2',
  provider: 'ensembl', species: 'rattus_norvegicus', host: 'https://rest.ensembl.org',
})
```

A custom genome with its own sequence uses the `static` provider (see
`src/lib/demoData.js`); a local indexed-FASTA + GTF backend would be a new
provider implementing `lookupGene`, `fetchSequence`, `fetchFeatures`, and
optionally `fetchCoding`.

## Correctness notes

- The reading-frame map follows the GFF3 phase convention and is verified to
  match full BRCA2 and TP53 CDS reconstructions exactly on both strands; the
  translated protein is unchanged by the silent disrupting mutations.
- Guides target the **reference** allele (what Cas9 cuts); the donor converts it
  to the edited allele. A disrupting mutation is skipped when the edit already disrupts the
  PAM or seed.
- The melting-temperature helper is the classic long-oligo approximation, not
  nearest-neighbour.
