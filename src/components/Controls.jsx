import { isValidPattern } from '../lib/bio.js'
import { TRACR_RNAS } from '../lib/crispr.js'
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
  tracrId, onTracr,
  onSearch, loading, loadChanged,
}) {
  const pamOk = isValidPattern(pam)
  const examples = EXAMPLES[genomeId] ?? ['LTBR', 'PCSK9']
  const queryOk = query.trim().length > 0

  return (
    <form
      className={`controls${loading ? ' loading' : ''}`}
      onSubmit={(e) => { e.preventDefault(); if (queryOk && pamOk && loadChanged && !loading) onSearch() }}
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

      <label className="field">
        <span className="preserve-case">tracrRNA</span>
        <select value={tracrId} onChange={(e) => onTracr(e.target.value)}>
          {Object.values(TRACR_RNAS).map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>

      <button type="submit" className="go" disabled={loading || !queryOk || !pamOk || !loadChanged}>
        Load
      </button>
    </form>
  )
}
