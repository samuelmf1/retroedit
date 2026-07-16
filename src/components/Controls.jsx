import { isValidPattern } from '../lib/bio.js'
import { genomesByOrganism } from '../lib/genome.js'

const EXAMPLES = {
  'human-grch38': ['LTBR', 'PCSK9'],
  'human-grch37': ['LTBR', 'PCSK9'],
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

  return (
    <form
      className={`controls${loading ? ' loading' : ''}${customMode ? ' custom-mode' : ''}`}
      onSubmit={(e) => { e.preventDefault(); if (!customMode && queryOk && pamOk && loadChanged && !loading) onSearch() }}
    >
      <a className="controlbrand" href="/" aria-label="RetroEdit home">RetroEdit</a>
      <label className="field genome">
        <span>Genome</span>
        <select value={genomeId} onChange={(e) => onGenome(e.target.value)}>
          {genomesByOrganism().map(([organism, builds]) => (
            <optgroup key={organism} label={organism}>
              {builds.map((g) => (
                <option key={g.id} value={g.id}>{g.assembly}{g.note ? ` (${g.note})` : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="customupload" title="Upload FASTA or plain DNA; maximum 10,000 bases">
        Upload custom DNA
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

      {customMode ? (
        <div className="customsummary">
          <strong>{customName || 'Custom DNA'}</strong>
          <span>Full sequence stays in this browser; RS3 contexts are transient and not server-cached.</span>
          <span>Annotations and genome-wide off-targets are unavailable.</span>
        </div>
      ) : (
        <div className="field grow">
          <div className="fieldlabelrow">
            <label htmlFor="gene-or-locus">Gene or locus</label>
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
            placeholder="BRCA2  ·  ENSG00000139618  ·  chr13:32,315,717-32,315,767"
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
          Load
        </button>
      )}
    </form>
  )
}
