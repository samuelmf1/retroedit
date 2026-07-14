import { isValidPattern } from '../lib/bio.js'
import { TRACR_RNAS } from '../lib/crispr.js'
import { genomesByOrganism } from '../lib/genome.js'

const WINDOWS = [100, 300, 600, 1000, 3000, 5000]

export default function Controls({
  genomeId, onGenome,
  query, onQuery,
  windowBp, onWindow,
  pam, onPam,
  tracrId, onTracr,
  onSearch, loading, searchChanged,
}) {
  const pamOk = isValidPattern(pam)

  return (
    <form
      className="controls"
      onSubmit={(e) => { e.preventDefault(); if (pamOk && searchChanged && !loading) onSearch() }}
    >
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

      <label className="field grow">
        <span>Gene or locus</span>
        <input
          value={query}
          placeholder="BRCA2  ·  ENSG00000139618  ·  chr13:32,315,717-32,315,767"
          onChange={(e) => onQuery(e.target.value)}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>Window</span>
        <select value={windowBp} onChange={(e) => onWindow(Number(e.target.value))}>
          {WINDOWS.map((w) => <option key={w} value={w}>{w.toLocaleString()} bp</option>)}
        </select>
      </label>

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
        <span>tracrRNA</span>
        <select value={tracrId} onChange={(e) => onTracr(e.target.value)}>
          {Object.values(TRACR_RNAS).map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>

      <button type="submit" className="go" disabled={loading || !pamOk || !searchChanged}>
        {loading ? '…' : 'Load'}
      </button>
    </form>
  )
}
