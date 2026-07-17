import { isValidPattern } from '../lib/bio.js'
import { genomesByOrganism } from '../lib/genome.js'

const EXAMPLES = {
  'human-grch38': ['PCSK9', 'rs11591147'],
  'human-grch37': ['PCSK9', 'rs11591147'],
  'mouse-grcm39': ['Ltbr', 'Pcsk9'],
}

export default function Controls({
  genomeId, onGenome,
  query, onQuery,
  pam, onPam,
  onSearch, onCustomUpload, customMode, customName,
  loading, loadChanged,
}) {
  const pamOk = isValidPattern(pam)
  const examples = EXAMPLES[genomeId] ?? []
  const queryOk = customMode || query.trim().length > 0
  const rsidQuery = /^rs\d+$/i.test(query.trim())

  return (
    <form
      className={`controls${loading ? ' loading' : ''}${customMode ? ' custom-mode' : ''}`}
      onSubmit={(e) => { e.preventDefault(); if (!customMode && queryOk && pamOk && loadChanged && !loading) onSearch() }}
    >
      <a className="controlbrand" href="/" aria-label="RetroEdit home">RetroEdit</a>
      <div className="field genome">
        <div className="genomeinputs">
          <select value={genomeId} onChange={(e) => onGenome(e.target.value)} aria-label="Genome">
            {genomesByOrganism().map(([organism, builds]) => (
              <optgroup key={organism} label={organism}>
                {builds.map((g) => (
                  <option key={g.id} value={g.id}>{g.assembly}{g.note ? ` (${g.note})` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="customuploadwrap">
            <label className="customupload" title={'FASTA: >sequence_name followed by DNA on the next line, or a plain DNA text file. Maximum 10,000 bases.'}>
              Upload Sequence
              <input
                type="file"
                accept=".fa,.fasta,.fna,.fas,.txt,text/plain"
                disabled={loading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) onCustomUpload(file)
                }}
              />
            </label>
          </div>
        </div>
      </div>

      {customMode ? (
        <div className="customsummary">
          <strong>{customName || 'Custom DNA'}</strong>
          <span>Full sequence stays in this browser; RS3 contexts are transient and not server-cached.</span>
          <span>Annotations and genome-wide off-targets are unavailable.</span>
        </div>
      ) : (
        <div className="field grow">
          <div className="fieldlabelrow">
            <label htmlFor="gene-or-locus">Gene, ENSG ID, locus, or rsID</label>
            <span className="examplechips" aria-label="Example genes and loci">
              <span className="examplelabel">Examples</span>
              {examples.map((example) => (
                <button key={example} type="button" className="examplechip" disabled={loading} onClick={() => {
                  onQuery(example)
                  onSearch(example)
                }}>
                  {example}
                </button>
              ))}
            </span>
          </div>
          <input
            id="gene-or-locus"
            value={query}
            placeholder="PCSK9  ·  ENSG00000169174  ·  chr1:55,039,445–55,064,852  ·  rs11591147"
            onChange={(e) => onQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      <label className="field small">
        <span>PAM</span>
        <input
          value={pam}
          onChange={(e) => onPam(e.target.value.toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, ''))}
          className={pamOk ? '' : 'invalid'}
          spellCheck={false}
          title="IUPAC codes allowed, e.g. NGG, NG, TTTV"
        />
      </label>


      {!customMode && (
        <button type="submit" className="go" disabled={loading || !queryOk || !pamOk || !loadChanged}>
          {loading && rsidQuery ? 'Resolving rsID...' : 'Load'}
        </button>
      )}
    </form>
  )
}
