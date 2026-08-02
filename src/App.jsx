import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Controls from './components/Controls.jsx'
import EditBar from './components/EditBar.jsx'
import FeatureRibbon, { DEFAULT_GNOMAD_MAF } from './components/FeatureRibbon.jsx'
import {
  DEFAULT_PAM,
  DEFAULT_SPACER_LENGTH,
  DEFAULT_WINDOW_BP,
  TRACR_RNAS,
  compareGuides,
  findGuides,
  guidesNearEdits,
  fullSgRna,
  rs3Compatible,
} from './lib/crispr.js'
import {
  affectedDisplayIndices,
  affectedRefIndices,
  buildRefToDisplay,
  deletionJunctions,
  deleteRange,
  describeEdits,
  hasEdits,
  insertAt,
  makeEdited,
  replaceRange,
} from './lib/editModel.js'
import { DEFAULT_ARM_LEN, designDonor, planGuideBlock } from './lib/hdr.js'
import { rs3Fill, rs3NeedsLightText } from './lib/color.js'
import { DEFAULT_GENOME_ID, getGenome, loadRegion, loadRegionAnnotations, registerGenome, resolveLocus } from './lib/genome.js'
import { cachedScore, checkRs3Health, scoreContexts } from './lib/rs3.js'
import { biotypesPresent, buildFeatureItems } from './lib/features.js'
import { CODON_TABLE, buildCodonTrack, codonAt, codonsForAminoAcid } from './lib/codon.js'
import { complementBase, findPatternIndices, reverseComplement } from './lib/bio.js'
import { cachedOffTargets, fetchCanonicalExons, fetchNearbyFeatures, fetchOffTargets, fetchSpacerMatches, fetchVariants, genomicsStatus } from './lib/genomics.js'
import { fetchCustomOffTargets, setCustomOffTargetReference } from './lib/customOfftargets.js'
import { clinvarCategory } from './lib/variants.js'
import { buildSnapGeneFile, isSnapGeneBuffer, parseSnapGeneFile } from './lib/snapgene.js'

const DEFAULT_VIEW_OPTS = {
  featureLevels: { gene: true, transcript: false },
  biotypes: null, // null = all biotypes
  codons: true,
  gnomad: false,
  gnomadMaf: DEFAULT_GNOMAD_MAF,
  clinvarSignificances: null, // null = all ClinVar significance categories
  clinvar: false,
}
const MAF_WARN = 0.01 // polymorphism threshold that can impair a guide
const RSID_DEFAULT_GNOMAD_MAF = 0.01
const POSITION_VIEW_BP = 700
const DEFAULT_OVERVIEW_HALF_SPAN = 100_000
const MIN_OVERVIEW_HALF_SPAN = 5_000
const MAX_OVERVIEW_HALF_SPAN = 500_000
const EXON_CONTEXT_BP = 200
const EXTEND_BP = 200
const CUSTOM_GENOME_ID = 'custom-upload'
const MAX_CUSTOM_FILE_BYTES = 25 * 1024 * 1024
const MAX_CUSTOM_RECORDS = 1_000
const DEFAULT_ARM_TOTAL = DEFAULT_ARM_LEN * 2
const DEFAULT_LONG_ARM = Math.round(DEFAULT_ARM_TOTAL * 0.72)
const DEFAULT_SHORT_ARM = DEFAULT_ARM_TOTAL - DEFAULT_LONG_ARM

const loadGuideTable = () => import('./components/GuideTable.jsx')
const loadDonorPanel = () => import('./components/DonorPanel.jsx')
const loadSequenceViewer = () => import('./components/SequenceViewer.jsx')
const GuideTable = lazy(loadGuideTable)
const DonorPanel = lazy(loadDonorPanel)
const SequenceViewer = lazy(loadSequenceViewer)
const preloadWorkspace = () => Promise.all([loadGuideTable(), loadDonorPanel(), loadSequenceViewer()])

const AMINO_ACID_NAMES = {
  A: 'Alanine', C: 'Cysteine', D: 'Aspartate', E: 'Glutamate', F: 'Phenylalanine',
  G: 'Glycine', H: 'Histidine', I: 'Isoleucine', K: 'Lysine', L: 'Leucine',
  M: 'Methionine', N: 'Asparagine', P: 'Proline', Q: 'Glutamine', R: 'Arginine',
  S: 'Serine', T: 'Threonine', V: 'Valine', W: 'Tryptophan', Y: 'Tyrosine', '*': 'Stop',
}

const FEATURE_COLOR_PRESETS = ['#2f6fed', '#7c3aed', '#0f9d76', '#d97706', '#dc3a30', '#db2777', '#526b7b']
const DESIGN_PAIR_COLORS = ['#2f6fed', '#0f9d76', '#d97706', '#7c3aed', '#db2777', '#0072b2', '#e69f00', '#009e73']

function CustomFeatureDialog({ draft, onClose, onApply }) {
  const editing = Boolean(draft.id)
  const [name, setName] = useState(draft.name ?? '')
  const [color, setColor] = useState(draft.color ?? FEATURE_COLOR_PRESETS[0])
  const valid = Boolean(name.trim())

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Enter' && valid) onApply({ ...draft, name: name.trim(), color })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [color, draft, name, onApply, onClose, valid])

  return (
    <div className="spacermatchbackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="featureeditmodal" role="dialog" aria-modal="true" aria-labelledby="feature-edit-title">
        <header>
          <div>
            <div className="loadconfirmbrand">Sequence annotation</div>
            <h2 id="feature-edit-title">{editing ? 'Edit feature' : 'Add selected DNA as a feature'}</h2>
            <p>{draft.range} · {draft.length.toLocaleString()} bp</p>
          </div>
          <button type="button" className="spacermatchclose" aria-label="Close feature editor" onClick={onClose}>×</button>
        </header>
        <label className="featureeditname">
          <span>Feature name</span>
          <input autoFocus value={name} maxLength={80} placeholder="e.g. enhancer, primer binding site"
            onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset className="featureeditcolors">
          <legend>Feature color</legend>
          <div>
            {FEATURE_COLOR_PRESETS.map((preset) => (
              <button key={preset} type="button" className={color === preset ? 'selected' : ''}
                style={{ '--feature-choice': preset }} aria-label={`Use color ${preset}`}
                aria-pressed={color === preset} onClick={() => setColor(preset)} />
            ))}
            <label className="featurecustomcolor" title="Choose a custom color">
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              <span>Custom</span>
            </label>
          </div>
        </fieldset>
        <div className="featurepreview" style={{ '--feature-preview': color }}>
          <span>{name.trim() || 'Feature preview'}</span>
        </div>
        <div className="loadconfirmactions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!valid}
            onClick={() => onApply({ ...draft, name: name.trim(), color })}>
            {editing ? 'Save changes' : 'Add feature'}
          </button>
        </div>
      </section>
    </div>
  )
}

function AminoAcidEditDialog({ edit, onClose, onApply }) {
  const [draft, setDraft] = useState('')
  const [chosenCodon, setChosenCodon] = useState('')
  const aminoAcid = draft.toUpperCase()
  const choices = useMemo(
    () => codonsForAminoAcid(edit.currentCodon, aminoAcid),
    [edit.currentCodon, aminoAcid],
  )
  const selectedCodon = choices.some((choice) => choice.codon === chosenCodon)
    ? chosenCodon
    : choices[0]?.codon ?? ''
  const recommendedCodon = choices[0]?.codon ?? ''
  const valid = Boolean(AMINO_ACID_NAMES[aminoAcid])
  const unchanged = selectedCodon === edit.currentCodon

  useEffect(() => { setChosenCodon('') }, [aminoAcid])
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Enter' && selectedCodon && !unchanged) onApply(edit, selectedCodon)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [edit, onApply, onClose, selectedCodon, unchanged])

  return (
    <div className="spacermatchbackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="aaeditmodal" role="dialog" aria-modal="true" aria-labelledby="aa-edit-title">
        <header>
          <div>
            <div className="loadconfirmbrand">Coding edit</div>
            <h2 id="aa-edit-title">Change amino acid</h2>
            <p>{edit.transcript ? `${edit.transcript} · ` : ''}Current codon <code>{edit.currentCodon}</code> encodes <strong>{edit.currentAa}</strong> ({AMINO_ACID_NAMES[edit.currentAa] ?? 'Unknown'}).</p>
          </div>
          <button type="button" className="spacermatchclose" aria-label="Close amino-acid editor" onClick={onClose}>×</button>
        </header>
        <label className="aaeditinput">
          <span>New amino acid</span>
          <input
            autoFocus
            value={draft}
            maxLength={1}
            spellCheck="false"
            aria-describedby="aa-edit-help"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value.toUpperCase().slice(-1))}
            placeholder="V"
          />
          <span className="aaeditname">{valid ? AMINO_ACID_NAMES[aminoAcid] : ''}</span>
        </label>
        <p id="aa-edit-help" className="aaedithelp">Enter a standard one-letter amino-acid code, or <code>*</code> for a stop codon.</p>
        {draft && !valid && <p className="aaediterror" role="alert">That is not a supported amino-acid code.</p>}
        {valid && choices.length > 0 && (
          <div className="aaeditchoices">
            <div className="aaeditrecommendation">
              <strong>Codon options</strong>
              <span>Recommended: <code>{recommendedCodon}</code> · {choices[0].distance} nucleotide {choices[0].distance === 1 ? 'change' : 'changes'}</span>
            </div>
            <div className="aaeditcodons" role="radiogroup" aria-label={`All codons encoding ${AMINO_ACID_NAMES[aminoAcid]}`}>
              {choices.map((choice) => (
                <button
                  key={choice.codon}
                  type="button"
                  role="radio"
                  aria-checked={selectedCodon === choice.codon}
                  aria-label={`${choice.codon}, ${choice.distance} nucleotide ${choice.distance === 1 ? 'change' : 'changes'}${choice.codon === recommendedCodon ? ', recommended' : ''}`}
                  className={`${selectedCodon === choice.codon ? 'selected ' : ''}${choice.codon === recommendedCodon ? 'recommended' : ''}`.trim()}
                  onClick={() => setChosenCodon(choice.codon)}
                >
                  <span className="codonbases">
                    {edit.currentCodon.split('').map((base, index) => (
                      <span key={index} className={base !== choice.codon[index] ? 'changed' : ''}>{choice.codon[index]}</span>
                    ))}
                  </span>
                  <small>{choice.codon === recommendedCodon ? 'Recommended' : `${choice.distance} ${choice.distance === 1 ? 'edit' : 'edits'}`}</small>
                </button>
              ))}
            </div>
            {unchanged && <p className="aaeditunchanged">This codon already encodes the requested amino acid.</p>}
          </div>
        )}
        <div className="loadconfirmactions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!selectedCodon || unchanged} onClick={() => onApply(edit, selectedCodon)}>Apply codon edit</button>
        </div>
      </section>
    </div>
  )
}

function readLocationState() {
  const params = new URLSearchParams(window.location.search)
  const query = params.get('q')?.trim() ?? ''
  const pam = params.get('pam')?.trim().toUpperCase() || DEFAULT_PAM
  const requestedGenome = params.get('genome') || DEFAULT_GENOME_ID
  let genomeId = DEFAULT_GENOME_ID
  try { getGenome(requestedGenome); genomeId = requestedGenome } catch { /* use the default */ }
  return { genomeId, query, pam }
}

function writeLocationState({ genomeId, query, pam }, mode = 'push') {
  const url = new URL(window.location.href)
  url.search = ''
  if (query?.trim()) {
    url.searchParams.set('genome', genomeId)
    url.searchParams.set('q', query.trim())
    if (pam !== DEFAULT_PAM) url.searchParams.set('pam', pam)
  }
  window.history[mode === 'replace' ? 'replaceState' : 'pushState']({}, '', url)
}

const BASES = new Set(['A', 'C', 'G', 'T'])

const DRAFT_KEY = 'retroedit:session-draft:v1'
const RECENT_KEY = 'retroedit:recent-searches:v1'

function readJsonStorage(storage, key, fallback) {
  try {
    const value = JSON.parse(storage.getItem(key))
    return value ?? fallback
  } catch {
    return fallback
  }
}

function validDraftFor(draft, reference) {
  if (!draft || !reference || draft.genomeId !== reference.genomeId) return false
  if (draft.chrom !== reference.chrom || draft.start !== reference.start || draft.end !== reference.end) return false
  if (draft.referenceSeq !== reference.seq || !Array.isArray(draft.edited)) return false
  return draft.edited.every((record) => (
    record && BASES.has(record.base) &&
    (record.ref == null || (Number.isInteger(record.ref) && record.ref >= 0 && record.ref < reference.seq.length)) &&
    (record.del == null || typeof record.del === 'boolean')
  ))
}

function readRecentSearches() {
  const items = readJsonStorage(window.localStorage, RECENT_KEY, [])
  return Array.isArray(items) ? items.slice(0, 5) : []
}
function parseCustomFasta(text, filename) {
  const fallbackName = filename.replace(/\.(?:fa|fasta|fna|fas|txt)$/i, '') || 'sequence'
  const records = []
  let name = null
  let chunks = []
  const seen = new Set()
  const pushRecord = () => {
    if (name == null && chunks.length === 0) return
    const seq = chunks.join('').replace(/\s/g, '').toUpperCase()
    if (!seq) throw new Error(`FASTA record "${name || fallbackName}" is empty.`)
    const invalid = [...new Set(seq.replace(/[ACGTRYSWKMBDHVN]/g, ''))]
    if (invalid.length) throw new Error(`Unsupported DNA character${invalid.length === 1 ? '' : 's'}: ${invalid.slice(0, 12).join(' ')}`)
    const recordName = (name || fallbackName).trim().split(/\s+/)[0]
    if (seen.has(recordName)) throw new Error(`Duplicate FASTA record name "${recordName}".`)
    seen.add(recordName)
    records.push({ name: recordName, seq, length: seq.length })
    if (records.length > MAX_CUSTOM_RECORDS) throw new Error(`FASTA files may contain at most ${MAX_CUSTOM_RECORDS.toLocaleString()} records.`)
    chunks = []
  }
  const lines = text.split(/\r?\n/)
  const isFasta = lines.some((line) => line.trimStart().startsWith('>'))
  if (!isFasta) {
    name = fallbackName
    chunks = lines
    pushRecord()
  } else {
    for (const line of lines) {
      if (line.trimStart().startsWith('>')) {
        pushRecord()
        name = line.trimStart().slice(1).trim()
        if (!name) throw new Error('Every FASTA record needs a name after ">".')
      } else if (name != null) {
        chunks.push(line)
      } else if (line.trim()) {
        throw new Error('FASTA sequence data appears before the first header.')
      }
    }
    pushRecord()
  }
  if (!records.length) throw new Error('The uploaded file does not contain a DNA sequence.')
  return records
}

function readBinaryFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('progress', (event) => onProgress?.(event.loaded, event.total || file.size))
    reader.addEventListener('load', () => resolve(reader.result))
    reader.addEventListener('error', () => reject(reader.error || new Error('Could not read this file.')))
    reader.readAsArrayBuffer(file)
  })
}

function exportFilenameToken(value) {
  return String(value || '')
    .trim()
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'designs'
}

function exportChromosomeToken(value) {
  const bare = String(value ?? '').trim().replace(/^chr/i, '')
  return `chr${bare || 'unknown'}`
}

function extendEditedSnapshot(snapshot, newRefSeq, oldRefLength, leftAdded) {
  const prefix = Array.from(newRefSeq.slice(0, leftAdded), (base, ref) => ({ base, ref }))
  const shifted = snapshot.map((record) => (
    record.ref == null ? record : { ...record, ref: record.ref + leftAdded }
  ))
  const suffixStart = leftAdded + oldRefLength
  const suffix = Array.from(newRefSeq.slice(suffixStart), (base, index) => ({
    base,
    ref: suffixStart + index,
  }))
  return [...prefix, ...shifted, ...suffix]
}

export default function App() {
  const initialLocation = useMemo(readLocationState, [])
  const [genomeId, setGenomeId] = useState(initialLocation.genomeId)
  const [query, setQuery] = useState(initialLocation.query)
  const [loadedControls, setLoadedControls] = useState(null)
  const [pam, setPam] = useState(initialLocation.pam)
  const [rs3Model, setRs3Model] = useState('hsu2013')
  const spacerLength = DEFAULT_SPACER_LENGTH
  const loadChanged = loadedControls == null ||
    loadedControls.genomeId !== genomeId ||
    loadedControls.query !== query.trim() ||
    loadedControls.pam !== pam

  const [region, setRegion] = useState(null)
  const [edited, setEdited] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [caret, setCaret] = useState(0)
  const [selection, setSelection] = useState(null)
  const [emphasizedEdit, setEmphasizedEdit] = useState(null)
  const [sequenceSearch, setSequenceSearch] = useState('')
  const [sequenceMatchIndex, setSequenceMatchIndex] = useState(0)
  const [selectedGuideId, setSelectedGuideId] = useState(null)
  const [showAllGuides, setShowAllGuides] = useState(false)
  const [allGuidesRequested, setAllGuidesRequested] = useState(false)

  const [spacerMatchDialog, setSpacerMatchDialog] = useState(null)
  const [aminoAcidEdit, setAminoAcidEdit] = useState(null)
  const [featureDraft, setFeatureDraft] = useState(null)
  const [customFeatures, setCustomFeatures] = useState([])
  const [loadConfirmOpen, setLoadConfirmOpen] = useState(false)
  const [loadConfirmCopy, setLoadConfirmCopy] = useState(null)
  // Undo/redo stacks of the edited-sequence array.
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])

  // Homology arms are per-guide. `armDefault` applies to any guide that has not
  // been customised; `armMap` overrides it for specific guides.
  const [armDefault, setArmDefault] = useState({ left: DEFAULT_LONG_ARM, right: DEFAULT_SHORT_ARM, strand: '+' })
  const [armMap, setArmMap] = useState({})
  const [blockChoiceMap, setBlockChoiceMap] = useState({})
  const [orientation, setOrientation] = useState('auto')

  const [scoreVersion, setScoreVersion] = useState(0)
  const [rs3Status, setRs3Status] = useState({ rs3: false, detail: 'checking' })

  const [checked, setChecked] = useState(() => new Set())
  const [librarySignatures, setLibrarySignatures] = useState({})
  const [sidebarWidth, setSidebarWidth] = useState(640)
  const [sequenceLineMode, setSequenceLineMode] = useState(() => {
    const saved = window.sessionStorage.getItem('retroedit-sequence-line-mode')
    return ['window', 'fixed', 'single'].includes(saved) ? saved : 'window'
  })

  const [viewOpts, setViewOpts] = useState(DEFAULT_VIEW_OPTS)
  const [gStatus, setGStatus] = useState(null)
  const [variants, setVariants] = useState([]) // gnomAD + ClinVar for the region
  const [offTargets, setOffTargets] = useState({ available: false, byGuide: {}, loading: false, pendingIds: new Set() })
  const [exonNav, setExonNav] = useState(null)
  const [nearbyFeatures, setNearbyFeatures] = useState([])
  const [overviewHalfSpan, setOverviewHalfSpan] = useState(DEFAULT_OVERVIEW_HALF_SPAN)
  const [customUpload, setCustomUpload] = useState(null)
  const [customUploadProgress, setCustomUploadProgress] = useState(null)
  const [pendingDraft, setPendingDraft] = useState(null)
  const [recentSearches, setRecentSearches] = useState(readRecentSearches)

  const loadConfirmResolverRef = useRef(null)
  const loadConfirmCancelRef = useRef(null)
  const loadConfirmActionRef = useRef(null)
  const viewerRef = useRef(null)
  const emphasizedEditTimerRef = useRef(null)
  const viewerGuideCopyRef = useRef(null)
  const loadRequestRef = useRef(0)
  const loadAbortRef = useRef(null)
  const initialLocationLoadedRef = useRef(false)
  const [overviewTarget, setOverviewTarget] = useState(null)

  useEffect(() => { checkRs3Health().then(setRs3Status) }, [])
  useEffect(() => { window.sessionStorage.setItem("retroedit-sequence-line-mode", sequenceLineMode) }, [sequenceLineMode])
  useEffect(() => { genomicsStatus().then(setGStatus) }, [])

  const requestLoadConfirmation = useCallback((copy = null) => new Promise((resolve) => {
    loadConfirmResolverRef.current?.(false)
    loadConfirmResolverRef.current = resolve
    setLoadConfirmCopy(copy ?? {
      title: 'Load a different locus?',
      description: 'This will clear your current sequence edits and design selections.',
      action: 'Load and clear edits',
      tone: 'danger',
    })
    setLoadConfirmOpen(true)
  }), [])

  const closeLoadConfirmation = useCallback((confirmed) => {
    const resolve = loadConfirmResolverRef.current
    loadConfirmResolverRef.current = null
    setLoadConfirmOpen(false)
    setLoadConfirmCopy(null)
    resolve?.(confirmed)
  }, [])

  useEffect(() => {
    if (!loadConfirmOpen) return undefined
    const frame = requestAnimationFrame(() => loadConfirmCancelRef.current?.focus())
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeLoadConfirmation(false)
        return
      }
      if (event.key !== 'Tab') return
      const first = loadConfirmCancelRef.current
      const last = loadConfirmActionRef.current
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeLoadConfirmation, loadConfirmOpen])

  const doLoad = useCallback(async (opts = {}) => {
    if (!opts.skipLoadConfirmation && !opts.preserveLoadState && opts.historyMode !== 'none' && region && hasEdits(region.reference.seq, edited)) {
      const proceed = await requestLoadConfirmation()
      if (!proceed) return null
    }
    const gid = opts.genomeId ?? genomeId
    const q = opts.query ?? query
    const selectedPam = opts.pam ?? pam
    const custom = opts.customSequence ?? customUpload
    const requestId = ++loadRequestRef.current
    loadAbortRef.current?.abort()
    const loadController = new AbortController()
    loadAbortRef.current = loadController
    let selectedSpacerMatch = opts.spacerMatch ?? null
    void preloadWorkspace()
    setLoading(true)
    setError(null)
    try {
      let result
      let nextExonNav = null
      if (gid === CUSTOM_GENOME_ID) {
        const record = custom?.record
        if (!record?.seq) throw new Error('Upload a FASTA, plain-DNA, or SnapGene .dna file first.')
        const end = Math.min(record.length, POSITION_VIEW_BP)
        const center = Math.max(1, Math.ceil(end / 2))
        const locus = opts.locus ?? {
          chrom: record.name, start: 1, end,
          focus: { start: center, end: center }, gene: null,
          label: custom.records.length > 1 ? `${custom.name} · ${record.name}` : custom.name,
        }
        result = await loadRegion({ genomeId: gid, locus })
      } else {
        const genome = getGenome(gid)
        const rawQuery = q.trim()
        if (/^[ACGT]{15,}$/i.test(rawQuery) && rawQuery.length !== 20) {
          throw new Error(`Enter the 20-nt spacer only (${rawQuery.length} nt received). Do not include the PAM; the ${selectedPam} PAM pattern is applied automatically.`)
        }
        const normalizedSpacer = /^[ACGT]{20}$/i.test(rawQuery) ? rawQuery.toUpperCase() : null
        if (normalizedSpacer && !selectedSpacerMatch) {
          let matchedSpacer = normalizedSpacer
          let lookup = await fetchSpacerMatches({
            assembly: genome.assembly,
            spacer: matchedSpacer,
            pam: selectedPam,
          }, loadController.signal)
          if (!lookup.available) throw new Error(lookup.detail || 'Genome spacer search is unavailable.')

          // Guide strings are normally supplied 5′→3′ in spacer orientation. If
          // no PAM-compatible hit exists, also accept a genomic-strand 20-mer by
          // searching its reverse complement as the actual guide sequence.
          if (!lookup.matches?.length) {
            const reverseSpacer = reverseComplement(normalizedSpacer)
            if (reverseSpacer !== normalizedSpacer) {
              const reverseLookup = await fetchSpacerMatches({
                assembly: genome.assembly,
                spacer: reverseSpacer,
                pam: selectedPam,
              }, loadController.signal)
              if (reverseLookup.available && reverseLookup.matches?.length) {
                matchedSpacer = reverseSpacer
                lookup = reverseLookup
              }
            }
          }
          if (!lookup.matches?.length) {
            throw new Error(`No exact forward- or reverse-strand genomic matches with a ${selectedPam} PAM were found for this guide.`)
          }
          const reverseComplemented = matchedSpacer !== normalizedSpacer
          if (lookup.matches.length > 1) {
            if (requestId === loadRequestRef.current) {
              setSpacerMatchDialog({
                spacer: normalizedSpacer,
                matchedSpacer,
                reverseComplemented,
                pam: selectedPam,
                matches: lookup.matches,
                truncated: !!lookup.truncated,
              })
            }
            return null
          }
          selectedSpacerMatch = lookup.matches[0]
        }

        const canonicalExonLocus = (data) => {
          let index = data.exons.findIndex((exon) => exon.rank === 1)
          if (index < 0) index = data.transcript.strand === -1 ? data.exons.length - 1 : 0
          const exon = data.exons[index]
          const geneContext = { ...data.gene, canonical: data.transcript.id }
          nextExonNav = { ...data, index }
          return {
            chrom: data.chrom,
            start: Math.max(1, exon.start - EXON_CONTEXT_BP),
            end: exon.end + EXON_CONTEXT_BP,
            focus: { start: exon.start, end: exon.end },
            gene: geneContext,
            label: `${data.gene.name} (${data.gene.id})`,
          }
        }

        let locus
        if (selectedSpacerMatch) {
          const center = Math.floor((selectedSpacerMatch.protoStart + selectedSpacerMatch.protoEnd) / 2)
          const start = Math.max(1, center - Math.floor(POSITION_VIEW_BP / 2))
          locus = {
            chrom: selectedSpacerMatch.chrom,
            start,
            end: start + POSITION_VIEW_BP - 1,
            focus: { start: selectedSpacerMatch.protoStart, end: selectedSpacerMatch.protoEnd },
            gene: null,
            label: `${normalizedSpacer || q.trim().toUpperCase()} · ${selectedSpacerMatch.chrom}:${selectedSpacerMatch.protoStart.toLocaleString()}–${selectedSpacerMatch.protoEnd.toLocaleString()}`,
          }
        } else if (!opts.locus && !opts.preserveExonNav && !/^rs\d+$/i.test(rawQuery) && !rawQuery.includes(':')) {
          // Resolve local genes and their canonical first exon in one request.
          const data = await fetchCanonicalExons({ assembly: genome.assembly, gene: rawQuery })
          locus = data?.exons?.length
            ? canonicalExonLocus(data)
            : await resolveLocus(q, genome, POSITION_VIEW_BP)
        } else {
          locus = opts.locus ?? await resolveLocus(q, genome, POSITION_VIEW_BP)
        }
        if (opts.geneContext) locus = { ...locus, gene: opts.geneContext }

        // Retain the provider fallback for assemblies without a local canonical index.
        if (locus.gene && !nextExonNav && !opts.preserveExonNav && !opts.locus) {
          const data = await fetchCanonicalExons({ assembly: genome.assembly, gene: locus.gene.id })
          if (data?.exons?.length) locus = canonicalExonLocus(data)
        }

        // Sequence and local GENCODE annotations are independent reads. Fetch
        // them together so the load time is the slower request, not their sum.
        const annotationSeed = {
          reference: {
            genomeId: gid,
            assembly: genome.assembly,
            chrom: locus.chrom,
            start: locus.start,
            end: locus.end,
            gene: locus.gene,
          },
        }
        const [loaded, annotations] = await Promise.all([
          loadRegion({ genomeId: gid, locus }),
          loadRegionAnnotations(annotationSeed).catch(() => null),
        ])
        result = annotations ? { ...loaded, ...annotations } : loaded
      }

      // A newer search may finish first. Never let this older response replace it.
      if (requestId !== loadRequestRef.current) return null
      if (!opts.preserveLoadState) {
        setOverviewHalfSpan(DEFAULT_OVERVIEW_HALF_SPAN)
        setSequenceSearch('')
        setSequenceMatchIndex(0)
        setCustomFeatures([])
        setFeatureDraft(null)
        if (gid !== CUSTOM_GENOME_ID) {
          const draft = readJsonStorage(window.sessionStorage, DRAFT_KEY, null)
          setPendingDraft(validDraftFor(draft, result.reference) ? draft : null)
          const recent = { genomeId: gid, query: q.trim(), pam: selectedPam }
          setRecentSearches((current) => {
            const next = [recent, ...current.filter((item) => (
              item.genomeId !== recent.genomeId || item.query !== recent.query || item.pam !== recent.pam
            ))].slice(0, 5)
            window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
            return next
          })
        } else {
          setPendingDraft(null)
        }
        setLoadedControls({ genomeId: gid, query: q.trim(), pam: selectedPam })
        if (opts.historyMode !== 'none' && gid !== CUSTOM_GENOME_ID) {
          writeLocationState({ genomeId: gid, query: q, pam: selectedPam }, opts.historyMode)
        }
      }
      if (/^rs\d+$/i.test(q.trim()) && !opts.preserveAnnotationState) {
        setViewOpts((current) => ({ ...current, gnomad: true, gnomadMaf: RSID_DEFAULT_GNOMAD_MAF }))
      }
      setRegion(result)
      setEdited(makeEdited(result.reference.seq))
      setPast([])
      setFuture([])
      setArmMap({})
      setBlockChoiceMap({})
      setSelection(null)
      const selectedSpacerGuideId = selectedSpacerMatch
        ? `${selectedSpacerMatch.strand}${selectedSpacerMatch.protoStart - result.reference.start}`
        : null
      setSelectedGuideId(selectedSpacerGuideId)
      setShowAllGuides(!!selectedSpacerMatch)
      setAllGuidesRequested(!!selectedSpacerMatch)
      setSpacerMatchDialog(null)
      if (!opts.preserveExonNav) setExonNav(nextExonNav)
      const focusIdx = selectedSpacerMatch
        ? selectedSpacerMatch.protoStart - result.reference.start
        : result.focus.start - result.reference.start
      setCaret(Math.max(0, Math.min(result.reference.seq.length, focusIdx)))
      return result
    } catch (err) {
      if (requestId === loadRequestRef.current) setError(err.message)
      return null
    } finally {
      if (requestId === loadRequestRef.current) {
        loadAbortRef.current = null
        setLoading(false)
      }
    }
  }, [genomeId, query, pam, customUpload, region, edited, requestLoadConfirmation])

  useEffect(() => {
    if (!spacerMatchDialog) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSpacerMatchDialog(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [spacerMatchDialog])

  useEffect(() => {
    if (initialLocationLoadedRef.current) return
    initialLocationLoadedRef.current = true
    if (initialLocation.query) void doLoad({ ...initialLocation, historyMode: 'replace' })
  }, [doLoad, initialLocation])

  useEffect(() => {
    const restoreLocation = () => {
      const next = readLocationState()
      setGenomeId(next.genomeId)
      setQuery(next.query)
      setPam(next.pam)
      if (next.query) {
        void doLoad({ ...next, historyMode: 'none' })
      } else {
        loadRequestRef.current += 1
        setLoading(false)
        setError(null)
        setLoadedControls(null)
        setRegion(null)
        setEdited([])
        setPast([])
        setFuture([])
        setSelection(null)
        setCustomFeatures([])
        setFeatureDraft(null)
        setSelectedGuideId(null)
        setPendingDraft(null)
      }
    }
    window.addEventListener('popstate', restoreLocation)
    return () => window.removeEventListener('popstate', restoreLocation)
  }, [doLoad])

  const cancelLoad = useCallback(() => {
    loadRequestRef.current += 1
    loadAbortRef.current?.abort()
    loadAbortRef.current = null
    setLoading(false)
    setSpacerMatchDialog(null)
    setError(null)
  }, [])

  const handleCustomUpload = useCallback(async (file) => {
    try {
      if (file.size > MAX_CUSTOM_FILE_BYTES) {
        throw new Error(`Custom sequence files may be up to ${Math.round(MAX_CUSTOM_FILE_BYTES / 1024 / 1024)} MB.`)
      }
      setError(null)
      setCustomUploadProgress({ phase: 'reading', loaded: 0, total: file.size, name: file.name })
      const buffer = await readBinaryFile(file, (loaded, total) => {
        setCustomUploadProgress({ phase: 'reading', loaded, total, name: file.name })
      })
      setCustomUploadProgress({ phase: 'parsing', loaded: file.size, total: file.size, name: file.name })
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const snapGene = isSnapGeneBuffer(buffer)
      if (/\.dna$/i.test(file.name) && !snapGene) throw new Error('This .dna file is not a valid SnapGene DNA file.')
      const records = snapGene
        ? [parseSnapGeneFile(buffer, file.name)]
        : parseCustomFasta(new TextDecoder().decode(buffer), file.name)
      setCustomOffTargetReference(records)
      const name = file.name.replace(/\.(?:dna|fa|fasta|fna|fas|txt)$/i, '') || 'Custom DNA'
      const custom = { name, records, record: records[0] }
      const record = custom.record
      registerGenome({
        id: CUSTOM_GENOME_ID,
        organism: 'Custom', assembly: 'Uploaded DNA', provider: 'static',
        maxRegionBp: 300_000, maxFeatureBp: 300_000,
        note: `${records.length.toLocaleString()} record${records.length === 1 ? '' : 's'}`,
        data: { chrom: record.name, start: 1, end: record.length, seq: record.seq, features: record.features ?? [], cds: record.cds ?? [] },
      })
      setCustomUpload(custom)
      setGenomeId(CUSTOM_GENOME_ID)
      setQuery(name)
      await doLoad({ genomeId: CUSTOM_GENOME_ID, query: name, customSequence: custom })
    } catch (err) {
      setError(err.message)
    } finally {
      setCustomUploadProgress(null)
    }
  }, [doLoad])

  const handleCustomRecord = useCallback(async (recordName) => {
    const record = customUpload?.records.find((item) => item.name === recordName)
    if (!record) return
    const next = { ...customUpload, record }
    registerGenome({
      id: CUSTOM_GENOME_ID,
      organism: 'Custom', assembly: 'Uploaded DNA', provider: 'static',
      maxRegionBp: 300_000, maxFeatureBp: 300_000,
      note: `${next.records.length.toLocaleString()} record${next.records.length === 1 ? '' : 's'}`,
      data: { chrom: record.name, start: 1, end: record.length, seq: record.seq, features: record.features ?? [], cds: record.cds ?? [] },
    })
    const result = await doLoad({ genomeId: CUSTOM_GENOME_ID, query: next.name, customSequence: next })
    if (result) setCustomUpload(next)
  }, [customUpload, doLoad])

  const handleCustomPosition = useCallback((position) => {
    const record = customUpload?.record
    if (!record) return
    const center = Math.max(1, Math.min(record.length, Math.round(Number(position) || 1)))
    let start = Math.max(1, center - Math.floor(POSITION_VIEW_BP / 2))
    const end = Math.min(record.length, start + POSITION_VIEW_BP - 1)
    start = Math.max(1, end - POSITION_VIEW_BP + 1)
    void doLoad({
      genomeId: CUSTOM_GENOME_ID,
      query: customUpload.name,
      customSequence: customUpload,
      locus: {
        chrom: record.name, start, end,
        focus: { start: center, end: center }, gene: null,
        label: customUpload.records.length > 1 ? `${customUpload.name} · ${record.name}` : customUpload.name,
      },
    })
  }, [customUpload, doLoad])

  const handleGenomeChange = useCallback((id) => {
    setGenomeId(id)
    if (id === CUSTOM_GENOME_ID && customUpload) {
      setQuery(customUpload.name)
      void doLoad({ genomeId: id, query: customUpload.name, customSequence: customUpload })
    }
  }, [customUpload, doLoad])

  const snapToExon = useCallback(async (index) => {
    const nav = exonNav
    const exon = nav?.exons?.[index]
    if (!exon) return
    const geneContext = { ...nav.gene, canonical: nav.transcript.id }
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: nav.chrom,
        start: Math.max(1, exon.start - EXON_CONTEXT_BP),
        end: exon.end + EXON_CONTEXT_BP,
        focus: { start: exon.start, end: exon.end },
        gene: geneContext,
        label: `${nav.gene.name} (${nav.gene.id})`,
      },
    })
    if (!result) return
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id
        ? { ...current, index }
        : current
    ))
  }, [exonNav, doLoad])

  const shiftWindow = useCallback(async (direction) => {
    const nav = exonNav
    if (!region || !nav || !direction) return
    const reference = region.reference
    const width = reference.end - reference.start + 1
    const requestedStart = reference.start + direction * POSITION_VIEW_BP
    const start = Math.max(1, requestedStart)
    const end = start + width - 1
    const geneContext = { ...nav.gene, canonical: nav.transcript.id }
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: nav.chrom,
        start,
        end,
        focus: { start: Math.floor((start + end) / 2), end: Math.floor((start + end) / 2) },
        gene: geneContext,
        label: `${nav.gene.name} (${nav.gene.id})`,
      },
    })
    if (!result) return

    const resultCenter = (result.reference.start + result.reference.end) / 2
    let nearest = 0
    let distance = Infinity
    nav.exons.forEach((exon, i) => {
      const candidate = Math.abs((exon.start + exon.end) / 2 - resultCenter)
      if (candidate < distance) { distance = candidate; nearest = i }
    })
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id
        ? { ...current, index: nearest }
        : current
    ))
  }, [region, exonNav, doLoad])

  const navigateOverview = useCallback(async (center) => {
    if (!region || loading || !Number.isFinite(center)) return
    const reference = region.reference
    const position = Math.round(center)
    const width = reference.end - reference.start + 1
    const start = Math.max(1, Math.round(center - (width - 1) / 2))
    const end = start + width - 1
    const nav = exonNav
    const geneContext = nav ? { ...nav.gene, canonical: nav.transcript.id } : reference.gene
    const loadedQuery = loadedControls?.query?.trim() ?? ''
    const movingFromGuideSearch = /^[ACGT]{20}$/i.test(loadedQuery)
    const coordinateQuery = `chr${String(reference.chrom).replace(/^chr/i, '')}:${position.toLocaleString()}`

    if (movingFromGuideSearch) {
      const hasCurrentEdits = hasEdits(reference.seq, edited)
      const proceed = await requestLoadConfirmation({
        title: 'Change the guide search to a genomic position?',
        description: `Moving the overview will replace ${loadedQuery} in the search field with ${coordinateQuery}.${hasCurrentEdits ? ' Current sequence edits and design selections will be cleared.' : ''}`,
        action: 'Move to position',
        tone: 'primary',
      })
      if (!proceed) return
    }

    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: !movingFromGuideSearch,
      skipLoadConfirmation: movingFromGuideSearch,
      query: movingFromGuideSearch ? coordinateQuery : undefined,
      geneContext,
      locus: {
        chrom: reference.chrom,
        start,
        end,
        focus: { start: position, end: position },
        gene: geneContext,
        label: geneContext ? `${geneContext.name} (${geneContext.id})` : coordinateQuery,
      },
    })
    if (!result) return
    if (movingFromGuideSearch) setQuery(coordinateQuery)
    if (!nav) return
    const resultCenter = (result.reference.start + result.reference.end) / 2
    let nearest = 0
    let distance = Infinity
    nav.exons.forEach((exon, index) => {
      const candidate = Math.abs((exon.start + exon.end) / 2 - resultCenter)
      if (candidate < distance) { distance = candidate; nearest = index }
    })
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id ? { ...current, index: nearest } : current
    ))
  }, [region, loading, exonNav, doLoad, edited, loadedControls, requestLoadConfirmation])

  const navigateToOverviewGene = useCallback(async (gene) => {
    if (!gene || loading) return
    const geneQuery = gene.name || gene.id
    if (!geneQuery) return

    const loadedQuery = loadedControls?.query?.trim() ?? query.trim()
    const focus = region?.focus
    const variantPosition = focus ? Math.round((focus.start + focus.end) / 2) : null
    const viewingVariant = /^rs\d+$/i.test(loadedQuery) && Number.isFinite(variantPosition)
    const overlapsVariant = viewingVariant && gene.start <= focus.end && gene.end >= focus.start

    if (viewingVariant && overlapsVariant) {
      const reference = region.reference
      const data = await fetchCanonicalExons({
        assembly: reference.assembly,
        gene: gene.id || geneQuery,
      }).catch(() => null)
      const geneContext = data?.exons?.length
        ? { ...data.gene, canonical: data.transcript.id }
        : gene
      const width = reference.end - reference.start + 1
      const start = Math.max(1, variantPosition - Math.floor((width - 1) / 2))
      setQuery(loadedQuery)
      const result = await doLoad({
        skipLoadConfirmation: true,
        preserveExonNav: true,
        preserveAnnotationState: true,
        query: loadedQuery,
        geneContext,
        locus: {
          chrom: reference.chrom,
          start,
          end: start + width - 1,
          focus: { start: variantPosition, end: variantPosition },
          gene: geneContext,
          label: `${geneContext.name || geneQuery} (${geneContext.id || gene.id})`,
        },
      })
      if (result && data?.exons?.length) {
        let index = 0
        let distance = Infinity
        data.exons.forEach((exon, exonIndex) => {
          const candidate = variantPosition < exon.start
            ? exon.start - variantPosition
            : variantPosition > exon.end ? variantPosition - exon.end : 0
          if (candidate < distance) { distance = candidate; index = exonIndex }
        })
        setExonNav({ ...data, index })
      }
      return
    }

    setQuery(geneQuery)
    await doLoad({ query: geneQuery })
  }, [doLoad, loadedControls, loading, query, region])
  const offTargetLocusHref = useCallback((hit) => {
    if (!region || !hit) return null
    const targetStart = Number(hit.pos)
    if (!Number.isFinite(targetStart)) return null
    const targetEnd = targetStart + 19
    const chrom = String(hit.chrom || "").replace(/^chr/i, "")
    if (!chrom) return null
    const locusQuery = `chr${chrom}:${targetStart}-${targetEnd}`
    const url = new URL(window.location.href)
    url.search = ""
    url.searchParams.set("genome", region.reference.genomeId || genomeId)
    url.searchParams.set("q", locusQuery)
    if (pam !== DEFAULT_PAM) url.searchParams.set("pam", pam)
    return url.href
  }, [genomeId, pam, region])


  const resizeOverview = useCallback(async (requestedStart, requestedEnd) => {
    if (!region || loading || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) return
    const reference = region.reference
    const start = Math.max(1, Math.round(Math.min(requestedStart, requestedEnd)))
    const end = Math.round(Math.max(requestedStart, requestedEnd))
    if (end <= start || (start === reference.start && end === reference.end)) return

    const center = Math.round((start + end) / 2)
    const nav = exonNav
    const geneContext = nav ? { ...nav.gene, canonical: nav.transcript.id } : reference.gene
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: reference.chrom,
        start,
        end,
        focus: { start: center, end: center },
        gene: geneContext,
        label: geneContext ? `${geneContext.name} (${geneContext.id})` : `${reference.chrom}:${center}`,
      },
    })
    if (!result || !nav) return

    const resultCenter = (result.reference.start + result.reference.end) / 2
    let nearest = 0
    let distance = Infinity
    nav.exons.forEach((exon, index) => {
      const candidate = Math.abs((exon.start + exon.end) / 2 - resultCenter)
      if (candidate < distance) { distance = candidate; nearest = index }
    })
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id ? { ...current, index: nearest } : current
    ))
  }, [region, loading, exonNav, doLoad])

  const extendRegion = useCallback(async (direction) => {
    if (!region || loading || !direction) return
    const reference = region.reference
    const start = direction < 0 ? Math.max(1, reference.start - EXTEND_BP) : reference.start
    const recordEnd = reference.genomeId === CUSTOM_GENOME_ID ? customUpload?.record?.length : null
    const end = direction > 0 ? Math.min(recordEnd ?? Infinity, reference.end + EXTEND_BP) : reference.end
    if (start === reference.start && end === reference.end) return

    setLoading(true)
    setError(null)
    try {
      let result = await loadRegion({
        genomeId: reference.genomeId,
        locus: {
          chrom: reference.chrom,
          start,
          end,
          focus: region.focus,
          gene: reference.gene,
          label: reference.label,
        },
      })
      const annotations = await loadRegionAnnotations(result).catch(() => null)
      if (annotations) result = { ...result, ...annotations }
      const leftAdded = reference.start - start
      const rebase = (snapshot) => extendEditedSnapshot(
        snapshot,
        result.reference.seq,
        reference.seq.length,
        leftAdded,
      )
      setRegion(result)
      setEdited(rebase(edited))
      setPast((snapshots) => snapshots.map(rebase))
      setFuture((snapshots) => snapshots.map(rebase))
      setCaret((position) => position + leftAdded)
      setSelection((current) => current ? {
        anchor: current.anchor + leftAdded,
        focus: current.focus + leftAdded,
      } : null)
      setSelectedGuideId(null)
      setChecked(new Set())
      setLibrarySignatures({})
      setArmMap({})
      setBlockChoiceMap({})
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [region, loading, edited, customUpload])


  const refSeq = region?.reference.seq ?? ''
  const isCustomRegion = region?.reference.genomeId === CUSTOM_GENOME_ID
  const frame = region?.frame ?? null
  const invalidEditedBases = useMemo(() => edited.flatMap((record, index) => (
    !record.del && !BASES.has(String(record.base).toUpperCase())
      ? [{ index, base: String(record.base) }]
      : []
  )), [edited])
  const hasInvalidEditedBases = invalidEditedBases.length > 0

  // Discover each guide geometry once per loaded reference/PAM. Edit-specific
  // views cheaply filter these stable records, preserving all cached metrics.
  const allGuides = useMemo(() => (
    region ? findGuides({ seq: refSeq, pam, spacerLength, affected: null }) : []
  ), [region, refSeq, pam, spacerLength])

  const derived = useMemo(() => {
    if (!region) return null
    const affectedRef = affectedRefIndices(refSeq, edited)
    const affectedDisp = affectedDisplayIndices(refSeq, edited)
    const { dispStart, dispEnd } = buildRefToDisplay(refSeq, edited)
    const junctions = deletionJunctions(refSeq, edited)

    const guides = guidesNearEdits(allGuides, affectedRef, DEFAULT_WINDOW_BP)

    const nearMask = new Uint8Array(edited.length)
    for (const a of affectedDisp) {
      const lo = Math.max(0, a - DEFAULT_WINDOW_BP)
      const hi = Math.min(edited.length - 1, a + DEFAULT_WINDOW_BP)
      for (let i = lo; i <= hi; i++) nearMask[i] = 1
    }

    return {
      affectedRef, affectedDisp, dispStart, dispEnd, junctions, guides, nearMask,
      editList: describeEdits(refSeq, edited, region.reference.start),
      edits: hasEdits(refSeq, edited),
    }
  }, [region, refSeq, edited, allGuides])

  const focusEditInViewer = useCallback((edit) => {
    if (!Number.isInteger(edit?.displayStart) || !Number.isInteger(edit?.displayEnd)) return
    window.clearTimeout(emphasizedEditTimerRef.current)
    const next = {
      start: edit.displayStart,
      end: edit.displayEnd,
      token: Date.now(),
    }
    setEmphasizedEdit(next)
    requestAnimationFrame(() => {
      viewerRef.current?.scrollToIndexCentered(Math.floor((next.start + next.end) / 2))
    })
    emphasizedEditTimerRef.current = window.setTimeout(() => {
      setEmphasizedEdit(null)
      emphasizedEditTimerRef.current = null
    }, 1800)
  }, [])

  useEffect(() => {
    setEmphasizedEdit(null)
    window.clearTimeout(emphasizedEditTimerRef.current)
    emphasizedEditTimerRef.current = null
  }, [edited])

  useEffect(() => () => window.clearTimeout(emphasizedEditTimerRef.current), [])

  const exploringGuides = showAllGuides
  const visibleGuideCandidates = hasInvalidEditedBases
    ? []
    : (exploringGuides ? allGuides : (derived?.guides ?? []))
  // Once requested, finish and retain metrics for the entire window even after
  // an edit switches the UI back to its focused guide subset. Invalid pasted
  // symbols pause every downstream calculation until the sequence is repaired.
  const metricGuideCandidates = hasInvalidEditedBases
    ? []
    : (allGuidesRequested ? allGuides : visibleGuideCandidates)

  const sequenceMatches = useMemo(() => {
    const pattern = sequenceSearch.trim().toUpperCase()
    if (!pattern) return []
    const sequence = []
    const displayIndex = []
    edited.forEach((record, index) => {
      if (record.del) return
      sequence.push(record.base)
      displayIndex.push(index)
    })
    const realised = sequence.join('')
    const reversePattern = reverseComplement(pattern)
    const hits = new Map()
    const addHits = (queryPattern, strand) => {
      findPatternIndices(realised, queryPattern).forEach((start) => {
        const ds = displayIndex[start]
        const de = displayIndex[start + pattern.length - 1]
        if (ds == null || de == null) return
        const key = `${ds}:${de}`
        const previous = hits.get(key)
        hits.set(key, {
          ds,
          de,
          strand: previous && previous.strand !== strand ? '±' : strand,
        })
      })
    }
    addHits(pattern, '+')
    addHits(reversePattern, '-')
    return [...hits.values()].sort((a, b) => a.ds - b.ds || a.de - b.de)
  }, [edited, sequenceSearch])

  useEffect(() => {
    setSequenceMatchIndex((current) => (
      sequenceMatches.length ? Math.min(current, sequenceMatches.length - 1) : 0
    ))
  }, [sequenceMatches.length])

  useEffect(() => {
    if (!sequenceSearch || !sequenceMatches.length) return
    requestAnimationFrame(() => viewerRef.current?.scrollToIndex(sequenceMatches[0].ds))
  }, [sequenceMatches, sequenceSearch])

  const stepSequenceMatch = useCallback((direction) => {
    if (!sequenceMatches.length) return
    setSequenceMatchIndex((current) => {
      const next = (current + direction + sequenceMatches.length) % sequenceMatches.length
      viewerRef.current?.scrollToIndex(sequenceMatches[next].ds)
      return next
    })
  }, [sequenceMatches])

  // Keep a recoverable draft in this tab only. Exact reference matching prevents
  // edits from being restored onto a changed assembly or sequence window.
  useEffect(() => {
    if (!region || isCustomRegion || pendingDraft) return undefined
    if (!derived?.edits) {
      window.sessionStorage.removeItem(DRAFT_KEY)
      return undefined
    }
    const timer = window.setTimeout(() => {
      const reference = region.reference
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        genomeId: reference.genomeId,
        chrom: reference.chrom,
        start: reference.start,
        end: reference.end,
        referenceSeq: reference.seq,
        edited,
        savedAt: Date.now(),
      }))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [derived?.edits, edited, isCustomRegion, pendingDraft, region])

  useEffect(() => {
    if (!derived?.edits) return undefined
    const warnUnsaved = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnUnsaved)
    return () => window.removeEventListener('beforeunload', warnUnsaved)
  }, [derived?.edits])

  // Guide discovery needs sequence beyond the ±100 bp search interval so a
  // protospacer, PAM, and RS3 context can be complete at the interval edge.
  // Extend one side at a time; after rebasing, this effect re-checks the other.
  useEffect(() => {
    if (!region || isCustomRegion || !derived?.edits || loading || !derived.affectedRef.length) return
    const requiredBuffer = DEFAULT_WINDOW_BP + spacerLength + pam.length + 4
    const firstAffected = derived.affectedRef[0]
    const lastAffected = derived.affectedRef[derived.affectedRef.length - 1]
    const leftAvailable = firstAffected
    const rightAvailable = refSeq.length - 1 - lastAffected

    if (leftAvailable < requiredBuffer && region.reference.start > 1) {
      void extendRegion(-1)
      return
    }
    if (rightAvailable < requiredBuffer) void extendRegion(1)
  }, [derived, extendRegion, loading, pam.length, refSeq.length, region, spacerLength])

  const scorable = rs3Compatible(pam, spacerLength)

  // Fetch both Rule Set 3 tracrRNA models for every guide context.
  useEffect(() => {
    if (!derived || !scorable || !rs3Status.rs3) return
    const contexts = metricGuideCandidates.map((g) => g.context30).filter(Boolean)
    if (!contexts.length) return
    const controller = new AbortController()
    Promise.all([
      scoreContexts(contexts, 'Hsu2013', controller.signal, !isCustomRegion),
      scoreContexts(contexts, 'Chen2013', controller.signal, !isCustomRegion),
    ])
      .then((results) => {
        setScoreVersion((v) => v + 1)
        const unavailable = results.find((result) => !result.available && result.detail)
        if (unavailable) setRs3Status({ rs3: false, detail: unavailable.detail })
      })
      .catch((err) => { if (err.name !== 'AbortError') console.error(err) })
    return () => controller.abort()
  }, [metricGuideCandidates, scorable, rs3Status.rs3])

  // Merge both scores and use the table-selected model for recommended order and viewer color.
  const guideView = useMemo(() => {
    if (!derived || !region) return { items: [], sorted: [] }
    const { dispStart, dispEnd } = derived
    const items = visibleGuideCandidates.map((g) => {
      const rs3Hsu = g.context30 ? cachedScore(g.context30, 'Hsu2013') : undefined
      const rs3Chen = g.context30 ? cachedScore(g.context30, 'Chen2013') : undefined
      const score = rs3Model === 'chen2013' ? rs3Chen : rs3Hsu
      const cutDS = g.cutBefore < refSeq.length ? dispStart[g.cutBefore] : edited.length
      const protoDS = dispStart[g.protoStart]
      const protoDE = dispEnd[g.protoEnd]
      const pamDS = dispStart[g.pamStart]
      const pamDE = dispEnd[g.pamEnd]
      const offtarget = offTargets.byGuide[g.id]
      const blocking = exploringGuides ? null : planGuideBlock({
        refSeq, guide: g, pam, frame, affected: derived.affectedRef,
        blockingChoice: blockChoiceMap[g.id] ?? null,
      })
      return {
        ...g,
        rs3: typeof score === 'number' ? score : undefined,
        rs3Hsu: typeof rs3Hsu === 'number' ? rs3Hsu : undefined,
        rs3Chen: typeof rs3Chen === 'number' ? rs3Chen : undefined,
        rs3Complete: typeof rs3Hsu === 'number' && typeof rs3Chen === 'number',
        metricsReady:
          rs3Status.detail !== 'checking' &&
          !!gStatus &&
          (!scorable || !rs3Status.rs3 || !g.context30 ||
            (typeof rs3Hsu === 'number' && typeof rs3Chen === 'number')) &&
          (isCustomRegion
            ? !offTargets.pendingIds?.has(g.id)
            : (!gStatus?.offtarget?.assemblies?.[region.reference.assembly]?.ready || !offTargets.pendingIds?.has(g.id))),
        fill: rs3Fill(score),
        lightText: rs3NeedsLightText(score),
        offtarget,
        blocking,
        offUnique: offtarget ? offtarget.unique : undefined,
        chrom: region.reference.chrom,
        protoGenomic: region.reference.start + g.protoStart,
        cutGenomic: region.reference.start + g.cutBefore,
        protoDS, protoDE, pamDS, pamDE, cutDS,
        ds: Math.min(protoDS, pamDS),
        de: Math.max(protoDE, pamDE),
      }
    })
    const sorted = [...items].sort(compareGuides)
    return { items, sorted }
    // scoreVersion re-reads the RS3 cache after async scores land.
  }, [derived, region, rs3Model, refSeq, edited.length, scoreVersion, offTargets, pam, frame, blockChoiceMap, rs3Status, gStatus, scorable, visibleGuideCandidates, exploringGuides]) // eslint-disable-line react-hooks/exhaustive-deps


  const biotypes = useMemo(() => (region ? biotypesPresent(region.features) : []), [region])

  const featureItems = useMemo(() => {
    if (!region || !derived) return []
    const items = buildFeatureItems({
      raw: region.features,
      opts: viewOpts,
      dispStart: derived.dispStart,
      dispEnd: derived.dispEnd,
      refStart: region.reference.start,
      refLen: refSeq.length,
      gene: region.reference.gene,
    })
    if (!viewOpts.featureLevels.gene) return items
    const refStart = region.reference.start
    const refEnd = region.reference.end
    const lastRef = refSeq.length - 1
    const toDisplay = (start, end) => {
      const clippedStart = Math.max(refStart, start)
      const clippedEnd = Math.min(refEnd, end)
      if (clippedEnd < clippedStart) return null
      return {
        ds: derived.dispStart[Math.max(0, Math.min(lastRef, clippedStart - refStart))],
        de: derived.dispEnd[Math.max(0, Math.min(lastRef, clippedEnd - refStart))],
      }
    }
    const gene = region.reference.gene
    if (gene) {
      const tss = gene.strand === -1 ? gene.end : gene.start
      const promoterStart = gene.strand === -1 ? tss - 50 : tss - 200
      const promoterEnd = gene.strand === -1 ? tss + 200 : tss + 50
      const display = toDisplay(promoterStart, promoterEnd)
      if (display) items.push({
        id: `promoter-${gene.id ?? gene.name}-${tss}`,
        level: 'promoter', name: `${gene.name} promoter`, ...display,
        strand: gene.strand,
        source: 'inferred −200/+50 bp promoter window around the annotated transcription start site',
      })
    }

    const nav = exonNav
    const annotationsReady = region.features.transcripts.length > 0
    if (!nav?.exons?.length || !annotationsReady) return items

    const canonicalTranscript = region.features.transcripts.find(
      (transcript) => transcript.id === nav.transcript.id,
    )
    const proteinCoding = canonicalTranscript?.biotype === 'protein_coding'
    const coding = (region.features.coding ?? [])
      .filter((segment) => segment.transcript === nav.transcript.id)
      .sort((a, b) => a.start - b.start)
    const functional = []

    const addSegment = (level, portion, start, end, exon, exonIndex) => {
      const display = toDisplay(start, end)
      if (!display) return
      const exonNumber = exon.rank ?? exonIndex + 1
      functional.push({
        id: `${level}-${nav.transcript.id}-${start}-${end}`,
        level,
        name: level === 'utr' ? portion : `Exon ${exonNumber} · ${portion}`,
        ...display,
        strand: nav.transcript.strand,
        source: `canonical ${nav.transcript.name} · exon ${exonNumber}`,
      })
    }
    const utrName = (exon, side) => {
      if (!proteinCoding) return 'non-coding exon'
      if (side === 'before') return nav.transcript.strand === -1 ? '3′ UTR' : '5′ UTR'
      if (side === 'after') return nav.transcript.strand === -1 ? '5′ UTR' : '3′ UTR'
      if (exon.rank === 1) return '5′ UTR'
      if (exon.rank === nav.exons.length) return '3′ UTR'
      return 'non-coding exon'
    }

    nav.exons.filter((exon) => exon.end >= refStart && exon.start <= refEnd).forEach((exon, exonIndex) => {
      const exonStart = Math.max(exon.start, refStart)
      const exonEnd = Math.min(exon.end, refEnd)
      const exonCoding = coding.filter((segment) => segment.end >= exonStart && segment.start <= exonEnd)
      if (!exonCoding.length) {
        addSegment('utr', utrName(exon), exonStart, exonEnd, exon, exonIndex)
        return
      }
      let cursor = exonStart
      exonCoding.forEach((segment, index) => {
        const start = Math.max(exonStart, segment.start)
        const end = Math.min(exonEnd, segment.end)
        if (start > cursor) {
          addSegment('utr', utrName(exon, index === 0 ? 'before' : null), cursor, start - 1, exon, exonIndex)
        }
        addSegment('cds', 'CDS', start, end, exon, exonIndex)
        cursor = Math.max(cursor, end + 1)
      })
      if (cursor <= exonEnd) addSegment('utr', utrName(exon, 'after'), cursor, exonEnd, exon, exonIndex)
    })
    return [...items, ...functional]
  }, [region, derived, refSeq, viewOpts, exonNav])

  useEffect(() => {
    const reference = region?.reference
    const focus = region?.focus
    if (!reference || reference.genomeId === CUSTOM_GENOME_ID || reference.gene || !focus) {
      setNearbyFeatures([])
      return undefined
    }
    const center = Math.round((focus.start + focus.end) / 2)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetchNearbyFeatures({
        assembly: reference.assembly,
        chrom: reference.chrom,
        start: Math.max(1, center - overviewHalfSpan),
        end: center + overviewHalfSpan,
      }, controller.signal).then(setNearbyFeatures).catch(() => {})
    }, 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [region?.reference.assembly, region?.reference.chrom, region?.reference.gene, region?.focus?.start, region?.focus?.end, overviewHalfSpan])

  const locusOverview = useMemo(() => {
    if (isCustomRegion) return null
    if (!region) return null
    const gene = exonNav?.gene ?? region.reference.gene
    if (gene) {
      return {
        chrom: exonNav?.chrom ?? region.reference.chrom,
        start: gene.start,
        end: gene.end,
        label: gene.name,
        description: gene.description ?? '',
        strand: gene.strand,
        exons: exonNav?.exons ?? [],
        coding: exonNav?.coding ?? [],
      }
    }

    const focus = region.focus
    if (!focus) return null
    const center = Math.round((focus.start + focus.end) / 2)
    const spanLabel = overviewHalfSpan >= 1_000_000
      ? `${Number((overviewHalfSpan / 1_000_000).toFixed(2))} Mb`
      : `${Number((overviewHalfSpan / 1_000).toFixed(1))} kb`
    return {
      chrom: region.reference.chrom,
      start: Math.max(1, center - overviewHalfSpan),
      end: center + overviewHalfSpan,
      label: `chr${String(region.reference.chrom).replace(/^chr/i, '')}:${center.toLocaleString()} ±${spanLabel}`,
      exons: [],
      elements: nearbyFeatures,
    }
  }, [region, exonNav, nearbyFeatures, overviewHalfSpan])

  const zoomNearbyOverview = useCallback((factor) => {
    setOverviewHalfSpan((current) => Math.max(
      MIN_OVERVIEW_HALF_SPAN,
      Math.min(MAX_OVERVIEW_HALF_SPAN, Math.round(current * factor)),
    ))
  }, [])

  // Codon / amino-acid consequences mapped onto displayed sequence columns.
  const codonCells = useMemo(() => {
    if (!region || !derived || !frame) return null
    const track = buildCodonTrack(frame, refSeq)
    if (!track) return null

    const parity = new Int8Array(edited.length).fill(-1)
    const aa = new Array(edited.length).fill(null)
    const changed = new Uint8Array(edited.length)
    const title = new Array(edited.length).fill('')
    const kind = new Array(edited.length).fill('')
    const editTarget = new Array(edited.length).fill(null)
    const recordByRef = new Array(refSeq.length)
    const frameTranscript = region.features.transcripts.find(
      (transcript) => transcript.id === frame.transcript,
    )
    const frameLabel = frameTranscript?.name ?? frame.transcript ?? ''

    for (let d = 0; d < edited.length; d++) {
      const rec = edited[d]
      if (rec.ref == null) continue
      recordByRef[rec.ref] = rec
      if (track.pos[rec.ref] >= 0) parity[d] = track.parity[rec.ref]
    }
    const deletionSpans = []
    const largeDeletionMask = new Uint8Array(edited.length)
    for (let d = 0; d < edited.length;) {
      const record = edited[d]
      if (!record.del || record.ref == null || track.pos[record.ref] < 0) { d += 1; continue }
      let end = d + 1
      while (end < edited.length) {
        const next = edited[end]
        if (!next.del || next.ref == null || track.pos[next.ref] < 0) break
        end += 1
      }
      const codingBases = end - d
      if (codingBases >= 6) {
        for (let i = d; i < end; i++) largeDeletionMask[i] = 1
        const inFrame = codingBases % 3 === 0
        const firstRef = edited[d].ref
        const lastRef = edited[end - 1].ref
        const genomicStart = region.reference.start + Math.min(firstRef, lastRef)
        const genomicEnd = region.reference.start + Math.max(firstRef, lastRef)
        const consequence = inFrame
          ? `in-frame deletion of ${codingBases / 3} amino acids`
          : `frameshift caused by a ${codingBases} bp coding deletion`
        deletionSpans.push({
          ds: d, de: end - 1, inFrame,
          label: inFrame ? `Δ ${codingBases / 3} aa` : `Frameshift · ${codingBases} bp`,
          title: `${frameLabel ? `${frameLabel} · ` : ''}${consequence} · chr${region.reference.chrom}:${genomicStart.toLocaleString()}–${genomicEnd.toLocaleString()}`,
        })
      }
      d = end
    }


    for (let r = 0; r < refSeq.length; r++) {
      if (track.pos[r] !== 1) continue
      const codon = codonAt(frame, refSeq, r)
      if (!codon) continue
      const middleDisplay = derived.dispStart[r]
      const records = codon.refIdx.map((idx) => recordByRef[idx])
      let effectTitle

      if (records.some((rec) => !rec || rec.del)) {
        const consolidated = codon.refIdx.some((idx) => largeDeletionMask[derived.dispStart[idx]])
        if (!consolidated) {
          aa[middleDisplay] = 'Δ'
          kind[middleDisplay] = 'indel'
        }
        effectTitle = consolidated
          ? `${codon.codon} (${codon.aa ?? 'X'}) · included in consolidated coding deletion`
          : `${codon.codon} (${codon.aa ?? 'X'}) → deletion; coding frame may change`
      } else {
        const bases = records.map((rec) => rec.base)
        const editedCodon = frame.strand === 1
          ? bases.join('')
          : bases.map(complementBase).join('')
        const editedAa = CODON_TABLE[editedCodon] ?? 'X'
        aa[middleDisplay] = editedAa
        if (editedAa === '*') kind[middleDisplay] = 'stop'
        if (editedAa !== 'X') {
          editTarget[middleDisplay] = {
            refIdx: codon.refIdx,
            displayIdx: codon.refIdx.map((idx) => derived.dispStart[idx]),
            referenceCodon: codon.codon,
            currentCodon: editedCodon,
            currentAa: editedAa,
            strand: frame.strand,
            transcript: frameLabel,
          }
        }
        effectTitle = editedCodon === codon.codon
          ? `${codon.codon} · ${codon.aa ?? 'X'}${editedAa === '*' ? ' · stop codon' : ''}`
          : `${codon.codon} (${codon.aa ?? 'X'}) → ${editedCodon} (${editedAa})` +
            (editedAa === codon.aa ? ' · synonymous' : '') +
            (editedAa === '*' ? ' · stop codon' : '')
      }

      effectTitle = frameLabel ? `${frameLabel} · ${effectTitle}` : effectTitle

      const codonChanged = records.some(
        (rec, i) => !rec || rec.del || rec.base !== refSeq[codon.refIdx[i]],
      )
      for (const idx of codon.refIdx) {
        const d = derived.dispStart[idx]
        title[d] = effectTitle
        if (codonChanged) changed[d] = 1
      }
    }

    for (let d = 0; d < edited.length;) {
      if (edited[d].ref != null) { d += 1; continue }
      let end = d + 1
      while (end < edited.length && edited[end].ref == null) end += 1
      const left = d > 0 ? edited[d - 1].ref : null
      const right = end < edited.length ? edited[end].ref : null
      const coding = (left != null && frame.codonPos[left] >= 0) ||
        (right != null && frame.codonPos[right] >= 0)
      if (coding) {
        const inFrame = (end - d) % 3 === 0
        const neighbour = left != null && track.pos[left] >= 0 ? left : right
        parity[d] = neighbour != null ? track.parity[neighbour] : 0
        aa[d] = inFrame ? '+' : 'FS'
        changed[d] = 1
        kind[d] = 'indel'
        title[d] = inFrame
          ? `${end - d} bp in-frame coding insertion`
          : `${end - d} bp coding insertion · frameshift`
      }
      d = end
    }

    return { parity, aa, changed, title, kind, editTarget, deletionSpans, largeDeletionMask }
  }, [region, derived, refSeq, edited, frame])

  const detectedCodingFeatures = useMemo(() => {
    if (!codonCells) return []
    const features = []
    codonCells.editTarget.forEach((target, middleDisplay) => {
      if (!target || target.currentAa !== '*') return
      features.push({
        id: `stop-${target.refIdx.join('-')}`,
        level: 'stop', name: `Stop codon · ${target.currentCodon}`,
        ds: Math.min(...target.displayIdx), de: Math.max(...target.displayIdx),
        strand: target.strand,
        source: target.referenceCodon === target.currentCodon
          ? `annotated coding frame${target.transcript ? ` · ${target.transcript}` : ''}`
          : `introduced by sequence edit${target.transcript ? ` · ${target.transcript}` : ''}`,
      })
    })
    return features
  }, [codonCells])

  const customFeatureItems = useMemo(() => {
    if (!region || !derived) return []
    const refStart = region.reference.start
    const refEnd = region.reference.end
    const lastRef = refSeq.length - 1
    return customFeatures.flatMap((feature) => {
      if (feature.chrom !== region.reference.chrom || feature.assembly !== region.reference.assembly) return []
      if (feature.refStart == null || feature.refEnd == null) {
        if (feature.referenceWindowStart !== refStart) return []
        return [{ ...feature, level: 'custom', ds: feature.displayStart, de: feature.displayEnd, source: 'user annotation · inserted sequence' }]
      }
      if (feature.refEnd < refStart || feature.refStart > refEnd) return []
      const clippedStart = Math.max(refStart, feature.refStart)
      const clippedEnd = Math.min(refEnd, feature.refEnd)
      return [{
        ...feature,
        level: 'custom',
        ds: derived.dispStart[Math.max(0, Math.min(lastRef, clippedStart - refStart))],
        de: derived.dispEnd[Math.max(0, Math.min(lastRef, clippedEnd - refStart))],
        source: 'user annotation',
      }]
    })
  }, [customFeatures, derived, refSeq.length, region])

  const displayedFeatureItems = useMemo(
    () => [...featureItems, ...detectedCodingFeatures, ...customFeatureItems],
    [customFeatureItems, detectedCodingFeatures, featureItems],
  )

  const openCustomFeatureDialog = useCallback(({ ds, de, range, length }) => {
    if (!region || ds == null || de == null || de < ds) return
    const refs = edited.slice(ds, de + 1).map((record) => record.ref).filter((ref) => ref != null)
    setFeatureDraft({
      range, length,
      refStart: refs.length ? region.reference.start + Math.min(...refs) : null,
      refEnd: refs.length ? region.reference.start + Math.max(...refs) : null,
      displayStart: ds,
      displayEnd: de,
      referenceWindowStart: region.reference.start,
      chrom: region.reference.chrom,
      assembly: region.reference.assembly,
    })
  }, [edited, region])

  const addCustomFeature = useCallback((feature) => {
    setCustomFeatures((current) => feature.id
      ? current.map((existing) => existing.id === feature.id
        ? { ...existing, name: feature.name, color: feature.color }
        : existing)
      : [...current, {
        ...feature,
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }])
    setFeatureDraft(null)
  }, [])

  const editCustomFeature = useCallback((feature) => {
    if (feature?.level !== 'custom' || !feature.id) return
    setFeatureDraft(feature)
  }, [])

  const deleteCustomFeature = useCallback((feature) => {
    if (feature?.level !== 'custom' || !feature.id) return
    setCustomFeatures((current) => current.filter((existing) => existing.id !== feature.id))
    setFeatureDraft((current) => current?.id === feature.id ? null : current)
  }, [])

  // Always fetch gnomAD after an edit so common variants can flag affected
  // guides. ClinVar and visible sequence markers remain controlled by toggles.
  useEffect(() => {
    const needsGuideCheck = Boolean(derived?.edits) && !isCustomRegion
    if (!region || isCustomRegion || (!needsGuideCheck && !viewOpts.gnomad && !viewOpts.clinvar)) { setVariants([]); return }
    const controller = new AbortController()
    const { assembly, chrom, start, end } = region.reference
    const jobs = []
    if (needsGuideCheck || viewOpts.gnomad) jobs.push(fetchVariants({ source: 'gnomad', assembly, chrom, start, end }, controller.signal))
    if (viewOpts.clinvar) jobs.push(fetchVariants({ source: 'clinvar', assembly, chrom, start, end }, controller.signal))
    Promise.all(jobs)
      .then((results) => setVariants(results.filter((r) => r.available).flatMap((r) => r.variants)))
      .catch((err) => { if (err.name !== 'AbortError') console.error(err) })
    return () => controller.abort()
  }, [region, isCustomRegion, derived?.edits, viewOpts.gnomad, viewOpts.clinvar])

  const variantItems = useMemo(() => {
    if (!region || !derived) return []
    const out = []
    for (const v of variants) {
      const refIdx = v.pos - region.reference.start
      if (refIdx < 0 || refIdx >= refSeq.length) continue
      out.push({ ...v, refIdx, col: derived.dispStart[refIdx] })
    }
    return out
  }, [variants, region, derived, refSeq])

  const displayedVariantItems = useMemo(() => variantItems.filter((v) => (
    (v.source === 'gnomad' && viewOpts.gnomad && (v.af ?? 0) >= (viewOpts.gnomadMaf ?? DEFAULT_GNOMAD_MAF)) ||
    (v.source === 'clinvar' && viewOpts.clinvar &&
      (viewOpts.clinvarSignificances == null || viewOpts.clinvarSignificances.has(clinvarCategory(v.clnsig))))
  )), [
    variantItems, viewOpts.gnomad, viewOpts.gnomadMaf, viewOpts.clinvar, viewOpts.clinvarSignificances,
  ])

  // Common variants (alternate allele frequency >= 1%) can impair guide binding.
  const guideVariantWarn = useMemo(() => {
    if (!derived || !region) return {}
    const common = variantItems
      .filter((v) => v.source === 'gnomad' && (v.af ?? 0) >= MAF_WARN)
      .sort((a, b) => a.refIdx - b.refIdx)
    if (!common.length) return {}
    const out = {}
    for (const g of visibleGuideCandidates) {
      const hits = common.filter((v) => v.refIdx >= g.protoStart && v.refIdx <= g.pamEnd)
      if (!hits.length) continue
      const hit = hits.reduce((highest, current) => current.af > highest.af ? current : highest)
      out[g.id] = {
        af: hit.af, pos: hit.pos, id: hit.id, ref: hit.ref, alt: hit.alt,
        inPam: hit.refIdx >= g.pamStart, count: hits.length,
        variants: hits.map((v) => ({
          af: v.af, pos: v.pos, id: v.id, ref: v.ref, alt: v.alt,
          inPam: v.refIdx >= g.pamStart,
        })),
      }
    }
    return out
  }, [derived, region, variantItems, visibleGuideCandidates])

  useEffect(() => {
    const empty = { available: false, byGuide: {}, loading: false, pendingIds: new Set() }
    if (!region || !derived) { setOffTargets(empty); return undefined }
    const assembly = region.reference.assembly
    const customReference = region.reference.genomeId === CUSTOM_GENOME_ID
    const guides = metricGuideCandidates.map((g) => ({
      id: g.id,
      spacer: g.spacer,
      chrom: region.reference.chrom,
      strand: g.strand,
      protoGenomic: region.reference.start + g.protoStart,
      cutGenomic: region.reference.start + g.cutBefore,
    }))
    if (!guides.length) {
      setOffTargets({ available: true, byGuide: {}, loading: false, pendingIds: new Set() })
      return undefined
    }

    const applyOffTargetResults = (result, loadingNow) => {
      const byGuide = {}
      for (const guide of result.guides ?? []) byGuide[guide.id] = guide
      const stillPending = new Set(result.pendingIds ?? [])
      setOffTargets({
        available: result.available || Object.keys(byGuide).length > 0,
        byGuide,
        loading: loadingNow && stillPending.size > 0,
        pendingIds: stillPending,
      })
    }

    const controller = new AbortController()
    if (customReference) {
      setOffTargets({
        available: true,
        byGuide: {},
        loading: true,
        pendingIds: new Set(guides.map((guide) => guide.id)),
      })
      const timer = setTimeout(() => {
        fetchCustomOffTargets({ pam, guides }, controller.signal)
          .then((result) => applyOffTargetResults(result, false))
          .catch((err) => {
            if (err.name !== 'AbortError') {
              console.error(err)
              setOffTargets({ available: false, byGuide: {}, loading: false, pendingIds: new Set() })
            }
          })
      }, 250)
      return () => {
        clearTimeout(timer)
        controller.abort()
      }
    }

    const ready = gStatus?.offtarget?.assemblies?.[assembly]?.ready
    if (!ready) { setOffTargets(empty); return undefined }
    const cached = cachedOffTargets({ assembly, pam, guides })
    const pendingIds = new Set(cached.missing.map((guide) => guide.id))
    setOffTargets({ available: true, byGuide: cached.byGuide, loading: pendingIds.size > 0, pendingIds })
    if (!cached.missing.length) return undefined

    const timer = setTimeout(() => {
      fetchOffTargets(
        { assembly, pam, guides },
        controller.signal,
        (progress) => applyOffTargetResults(progress, true),
      )
        .then((result) => applyOffTargetResults(result, false))
        .catch((err) => {
          if (err.name !== 'AbortError') {
            console.error(err)
            setOffTargets({
              available: Object.keys(cached.byGuide).length > 0,
              byGuide: cached.byGuide,
              loading: false,
              pendingIds: new Set(),
            })
          }
        })
    }, 1000)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [region, metricGuideCandidates, gStatus, pam])

  const focusSpanDisplay = useMemo(() => {
    if (!region || !derived) return null
    const s = region.focus.start - region.reference.start
    const e = region.focus.end - region.reference.start
    if (e < 0 || s > refSeq.length - 1) return null
    const { dispStart, dispEnd } = derived
    return { ds: dispStart[Math.max(0, s)], de: dispEnd[Math.min(refSeq.length - 1, e)] }
  }, [region, derived, refSeq])

  // Transcription start site of the searched gene, if it falls in the window.
  const tssMarker = useMemo(() => {
    const gene = region?.reference.gene
    if (!gene || !derived) return null
    const tssGenomic = gene.strand === -1 ? gene.end : gene.start
    const refIdx = tssGenomic - region.reference.start
    if (refIdx < 0 || refIdx >= refSeq.length) return null
    return { col: derived.dispStart[refIdx], strand: gene.strand === -1 ? '-' : '+', name: gene.name }
  }, [region, derived, refSeq])

  const selectedGuide = guideView.items.find((g) => g.id === selectedGuideId) ?? null
  const highlightedSequence = useMemo(() => {
    if (!selection || selection.anchor === selection.focus) return null
    const start = Math.min(selection.anchor, selection.focus)
    const end = Math.max(selection.anchor, selection.focus)
    return edited.slice(start, end).map((record) => record.base).join('')
  }, [edited, selection])

  useEffect(() => {
    const copyViewerSequenceOrGuide = (event) => {
      if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return
      const browserSelection = window.getSelection?.()
      if (browserSelection && !browserSelection.isCollapsed) return

      if (highlightedSequence) {
        event.preventDefault()
        event.clipboardData?.setData('text/plain', highlightedSequence)
        return
      }

      const guideId = viewerGuideCopyRef.current
      if (!guideId || guideId !== selectedGuideId || !selectedGuide) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', selectedGuide.spacer)
    }
    document.addEventListener('copy', copyViewerSequenceOrGuide)
    return () => document.removeEventListener('copy', copyViewerSequenceOrGuide)
  }, [highlightedSequence, selectedGuide, selectedGuideId])
  useEffect(() => {
    if (!selectedGuide || !showAllGuides) return
    const frame = requestAnimationFrame(() => {
      viewerRef.current?.scrollToIndex(selectedGuide.ds, 'auto')
    })
    return () => cancelAnimationFrame(frame)
  }, [region?.reference.start, selectedGuide?.ds, selectedGuideId, showAllGuides])

  const selectedBlockingChoice = selectedGuide ? blockChoiceMap[selectedGuide.id] ?? null : null
  const setSelectedBlockingChoice = useCallback((choice) => {
    if (!selectedGuide) return
    setBlockChoiceMap((current) => {
      const next = { ...current }
      if (choice) next[selectedGuide.id] = choice
      else delete next[selectedGuide.id]
      return next
    })
  }, [selectedGuide])

  const inheritedArmsFor = useCallback((guide) => (
    guide && armDefault.strand && guide.strand !== armDefault.strand
      ? { left: armDefault.right, right: armDefault.left }
      : { left: armDefault.left, right: armDefault.right }
  ), [armDefault])
  const armsFor = useCallback((guide) => armMap[guide.id] ?? inheritedArmsFor(guide), [armMap, inheritedArmsFor])
  const selectedInheritedArms = selectedGuide ? inheritedArmsFor(selectedGuide) : armDefault
  const selectedArms = selectedGuide ? armsFor(selectedGuide) : armDefault
  const armsCustomized = selectedGuide != null && armMap[selectedGuide.id] != null &&
    (armMap[selectedGuide.id].left !== selectedInheritedArms.left || armMap[selectedGuide.id].right !== selectedInheritedArms.right)

  const setSelectedArm = useCallback((side, value) => {
    if (!selectedGuide) return
    setArmMap((m) => {
      const cur = m[selectedGuide.id] ?? inheritedArmsFor(selectedGuide)
      return { ...m, [selectedGuide.id]: { ...cur, [side]: value } }
    })
  }, [selectedGuide, inheritedArmsFor])
  const setSelectedArmRatio = useCallback((ratio) => {
    if (!selectedGuide) return
    let total = selectedArms.left + selectedArms.right
    let left
    let right
    if (ratio === '72:28') {
      // Richardson et al. used 91/36-nt asymmetric arms (~72:28). Preserve the
      // current total while keeping both arms within the slider's 10–200-bp bounds.
      total = Math.max(36, Math.min(277, total))
      const longArm = Math.round(total * 0.72)
      const shortArm = total - longArm
      // Forward PAMs are to the genomic right; reverse-strand PAMs are to the left.
      ;({ left, right } = selectedGuide.strand === '+'
        ? { left: longArm, right: shortArm }
        : { left: shortArm, right: longArm })
    } else {
      left = Math.round(total / 2)
      right = total - left
    }
    setArmMap((current) => ({ ...current, [selectedGuide.id]: { left, right } }))
  }, [selectedGuide, selectedArms])


  const setSelectedArmTotal = useCallback((nextTotal) => {
    if (!selectedGuide) return
    const currentTotal = selectedArms.left + selectedArms.right
    if (!currentTotal) return
    const boundedTotal = Math.max(50, Math.min(250, Math.round(nextTotal)))
    const leftFraction = selectedArms.left / currentTotal
    let left = Math.round(boundedTotal * leftFraction)
    left = Math.max(10, Math.min(200, left))
    let right = boundedTotal - left
    if (right < 10) {
      right = 10
      left = boundedTotal - right
    } else if (right > 200) {
      right = 200
      left = boundedTotal - right
    }
    setArmMap((current) => ({ ...current, [selectedGuide.id]: { left, right } }))
  }, [selectedGuide, selectedArms])

  const applyArmsToAll = useCallback(() => {
    if (!selectedGuide) return
    setArmDefault({ ...selectedArms, strand: selectedGuide.strand })
    setArmMap({}) // opposite-strand guides inherit the left/right swap
  }, [selectedArms, selectedGuide])

  const donor = useMemo(() => {
    if (!region || !selectedGuide || !derived || exploringGuides || hasInvalidEditedBases) return null
    return designDonor({
      refSeq,
      refStart: region.reference.start,
      edited,
      affected: derived.affectedRef,
      guide: selectedGuide,
      pam,
      frame,
      armLeft: selectedArms.left,
      armRight: selectedArms.right,
      orientation,
      blockingChoice: selectedBlockingChoice,
    })
  }, [region, selectedGuide, derived, refSeq, edited, pam, frame, selectedArms, orientation, selectedBlockingChoice, exploringGuides, hasInvalidEditedBases])

  // Aligned letter ribbons drawn directly against the track for the selected guide.
  const guideRibbon = useMemo(() => {
    if (!selectedGuide) return null
    const g = selectedGuide
    const cells = []
    for (let col = g.protoDS; col <= g.protoDE; col++) {
      const genomicBase = edited[col]?.base
      if (!genomicBase) continue
      const ch = g.strand === '-' ? complementBase(genomicBase) : genomicBase
      cells.push({ col, ch })
    }
    return {
      ds: g.protoDS, de: g.protoDE, strand: g.strand,
      protoColor: g.fill, lightText: g.lightText, cells, cutCol: g.cutDS,
    }
  }, [selectedGuide, edited])

  const donorRibbon = useMemo(() => {
    if (!donor?.ok || !derived) return null
    const from = derived.dispStart[donor.winStart]
    const cells = donor.track.map((t, i) => ({
      col: from + i,
      ch: donor.orientation === 'antisense' ? complementBase(t.base) : t.base,
      role: t.role,
    }))
    return {
      ds: from,
      de: from + donor.track.length - 1,
      cutCol: derived.dispStart[donor.cut], // display column of the cut junction
      orientation: donor.orientation,
      cells,
    }
  }, [donor, derived])

  // ---- multi-select + export ----
  const librarySignatureFor = useCallback((id) => {
    const guide = guideView.items.find((candidate) => candidate.id === id)
    if (!guide) return ''
    const arms = armsFor(guide)
    return JSON.stringify({
      editList: derived?.editList ?? [],
      pam,
      guideStrand: guide.strand,
      armLeft: arms.left,
      armRight: arms.right,
      orientation,
      blockingChoice: blockChoiceMap[id] ?? null,
    })
  }, [guideView.items, armsFor, derived?.editList, pam, orientation, blockChoiceMap])

  const toggleChecked = useCallback((id) => {
    if (hasInvalidEditedBases) return
    const removing = checked.has(id)
    setChecked((prev) => {
      const next = new Set(prev)
      if (removing) next.delete(id)
      else next.add(id)
      return next
    })
    setLibrarySignatures((current) => {
      const updated = { ...current }
      if (removing) delete updated[id]
      else updated[id] = librarySignatureFor(id)
      return updated
    })
  }, [checked, librarySignatureFor, hasInvalidEditedBases])

  const addOrUpdateChecked = useCallback((id) => {
    if (hasInvalidEditedBases) return
    const signature = librarySignatureFor(id)
    setChecked((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    setLibrarySignatures((current) => ({ ...current, [id]: signature }))
  }, [librarySignatureFor, hasInvalidEditedBases])

  const toggleAll = useCallback((ids) => {
    if (hasInvalidEditedBases) return
    const removing = ids.every((id) => checked.has(id))
    setChecked(removing ? new Set() : new Set(ids))
    setLibrarySignatures(removing
      ? {}
      : Object.fromEntries(ids.map((id) => [id, librarySignatureFor(id)])))
  }, [checked, librarySignatureFor, hasInvalidEditedBases])

  useEffect(() => {
    setChecked(new Set())
    setLibrarySignatures({})
  }, [region])

  const selectedGuideNeedsLibraryUpdate = Boolean(
    selectedGuide &&
    checked.has(selectedGuide.id) &&
    librarySignatures[selectedGuide.id] !== librarySignatureFor(selectedGuide.id)
  )

  const exportGuides = useCallback((format, options = {}) => {
    if (!region || !derived || hasInvalidEditedBases) return
    const chosen = guideView.sorted.filter((g) => g.metricsReady && checked.has(g.id))
    if (!chosen.length) return
    const chrom = exportChromosomeToken(region.reference.chrom)
    const selectedRs3Column = `rs3_${rs3Model}`
    const rows = chosen.map((g) => {
      const arms = armsFor(g)
      const d = designDonor({
        refSeq, refStart: region.reference.start, edited,
        affected: derived.affectedRef, guide: g, pam, frame,
        armLeft: arms.left, armRight: arms.right, orientation,
        blockingChoice: blockChoiceMap[g.id] ?? null,
      })
      return {
        id: `${g.strand === '+' ? 'fwd' : 'rev'}_${chrom}_${g.cutGenomic}`,
        strand: g.strand,
        spacer: g.spacer,
        pam: g.pamSeq,
        sgRNA: fullSgRna(g.spacer, rs3Model),
        sgRNA_scaffold: TRACR_RNAS[rs3Model].label,
        rs3_hsu2013: typeof g.rs3Hsu === 'number' ? g.rs3Hsu.toFixed(4) : '',
        rs3_chen2013: typeof g.rs3Chen === 'number' ? g.rs3Chen.toFixed(4) : '',
        gc: (g.gc * 100).toFixed(0),
        cut_genomic: g.cutGenomic,
        cut_dist: g.cutDist,
        context_30mer: g.context30 ?? '',
        repair_template: d.ok ? d.ssodn : '',
        repair_template_strand: d.ok ? d.orientation : '',
        re_cut_disruption: d.ok ? d.blocking.reason : '',
        _guide: g,
        _donor: d.ok ? d : null,
      }
    })

    const exportStem = `retroedit_${exportFilenameToken(loadedControls?.query ?? query)}_${exportFilenameToken(pam)}`
    const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
    if (format === 'dna') {
      const sequence = edited.filter((record) => !record.del).map((record) => record.base).join('')
      if (!sequence) return

      const activeBefore = new Uint32Array(edited.length + 1)
      for (let index = 0; index < edited.length; index += 1) {
        activeBefore[index + 1] = activeBefore[index] + (edited[index].del ? 0 : 1)
      }
      const displayInterval = (ds, de) => {
        const safeStart = Math.max(0, Math.min(edited.length - 1, Math.round(ds)))
        const safeEnd = Math.max(safeStart, Math.min(edited.length - 1, Math.round(de)))
        const start = activeBefore[safeStart]
        const end = activeBefore[safeEnd + 1]
        return end > start ? { start, end } : null
      }

      const editColors = { sub: '#7b3fe4', ins: '#18a66f', del: '#e13a32' }
      const editKinds = { sub: 'Replacement', ins: 'Insertion', del: 'Deletion' }
      const editFeatures = derived.editList.flatMap((edit) => {
        let start = activeBefore[Math.max(0, Math.min(edited.length, edit.displayStart))]
        let end = activeBefore[Math.max(0, Math.min(edited.length, edit.displayEnd + 1))]
        const deletionBoundary = end <= start
        if (deletionBoundary) {
          start = Math.max(0, Math.min(sequence.length - 1, start))
          end = Math.min(sequence.length, start + 1)
        }
        if (end <= start) return []
        const kind = editKinds[edit.type] ?? 'Sequence edit'
        return [{
          name: edit.label, type: 'variation', level: 'edit', start, end, strand: 1,
          color: editColors[edit.type] ?? '#7b3fe4',
          source: `RetroEdit ${kind.toLowerCase()} · ${edit.length.toLocaleString()} bp${deletionBoundary ? ' · feature marks the deletion junction' : ''}`,
        }]
      })

      const seen = new Set()
      const annotationFeatures = displayedFeatureItems.flatMap((feature) => {
        const interval = displayInterval(feature.ds, feature.de)
        if (!interval) return []
        const key = `${feature.name}:${interval.start}:${interval.end}:${feature.strand ?? 1}`
        if (seen.has(key)) return []
        seen.add(key)
        return [{
          name: feature.name, type: feature.type, level: feature.level,
          ...interval, strand: feature.strand, color: feature.color, source: feature.source,
        }]
      })

      const designFeatures = rows.flatMap((row, index) => {
        const color = DESIGN_PAIR_COLORS[index % DESIGN_PAIR_COLORS.length]
        const pair = `Design ${index + 1} · ${row.id}`
        const guideInterval = displayInterval(row._guide.protoDS, row._guide.protoDE)
        const donor = row._donor
        const donorInterval = donor
          ? displayInterval(derived.dispStart[donor.winStart], derived.dispEnd[donor.winEnd])
          : null
        return [
          guideInterval && {
            name: `${pair} · sgRNA target`, type: 'misc_binding', level: 'guide',
            ...guideInterval, strand: row.strand === '+' ? 1 : -1, color,
            source: `Matched design color: ${color} · spacer ${row.spacer} · PAM ${row.pam} · full sgRNA (${row.sgRNA_scaffold}) ${row.sgRNA}`,
          },
          donorInterval && {
            name: `${pair} · repair template`, type: 'misc_feature', level: 'repair_template',
            ...donorInterval, strand: row.repair_template_strand === 'antisense' ? -1 : 1, color,
            source: `Matched design color: ${color} · ${row.repair_template_strand} repair template · ${row.repair_template} · re-cut disruption: ${row.re_cut_disruption || 'none'}`,
          },
        ].filter(Boolean)
      })

      const file = buildSnapGeneFile({
        name: `RetroEdit designs · ${loadedControls?.query ?? query}`,
        sequence,
        features: [...editFeatures, ...annotationFeatures, ...designFeatures],
        circular: false,
      })
      const url = URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${exportStem}_designs.dna`
      anchor.click()
      URL.revokeObjectURL(url)
      return
    }
    let text
    let filename
    let mimeType = 'text/plain'
    if (format === 'fasta') {
      text = rows.map((r) =>
        `>${r.id}|spacer|${selectedRs3Column}=${r[selectedRs3Column]}\n${r.spacer}\n` +
        (r.repair_template ? `>${r.id}|repair_template_${r.repair_template_strand}\n${r.repair_template}\n` : ''),
      ).join('')
      filename = `${exportStem}.fasta`
    } else if (format === 'idt-grna') {
      text = [
        ['Name', 'Sequence'],
        ...rows.map((r) => [`${r.id}_gRNA_${r.sgRNA_scaffold}`, r.sgRNA]),
      ].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
      filename = `${exportStem}_IDT_gRNA.csv`
      mimeType = 'text/csv'
    } else if (format === 'idt-cloning') {
      const topOverhang = String(options.topOverhang ?? '').toUpperCase()
      const bottomOverhang = String(options.bottomOverhang ?? '').toUpperCase()
      const includeBottom = options.includeBottom !== false
      const namePattern = String(options.namePattern || '{guide}_{strand}')
      const oligoName = (row, index, strand) => namePattern
        .replaceAll('{guide}', row.id)
        .replaceAll('{index}', String(index + 1))
        .replaceAll('{strand}', strand)
      text = [
        ['Name', 'Sequence'],
        ...rows.flatMap((r, index) => {
          const oligos = [[oligoName(r, index, 'top'), `${topOverhang}${r.spacer}`]]
          if (includeBottom) {
            oligos.push([oligoName(r, index, 'bottom'), `${bottomOverhang}${reverseComplement(r.spacer)}`])
          }
          return oligos
        }),
      ].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
      filename = `${exportStem}_IDT_cloning_oligos.csv`
      mimeType = 'text/csv'
    } else if (format === 'idt-gblocks') {
      const donorRows = rows.filter((r) => r.repair_template)
      if (!donorRows.length) return
      text = [
        ['Name', 'Sequence'],
        ...donorRows.map((r) => [`${r.id}_repair_template_${r.repair_template_strand}`, r.repair_template]),
      ].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
      filename = `${exportStem}_IDT_gBlocks.csv`
      mimeType = 'text/csv'
    } else {
      const cols = ['id', 'strand', 'spacer', 'pam', 'sgRNA', 'sgRNA_scaffold', selectedRs3Column, 'gc',
        'cut_genomic', 'cut_dist', 'context_30mer', 'repair_template', 'repair_template_strand', 're_cut_disruption']
      text = [cols.join('\t'), ...rows.map((r) => cols.map((c) => r[c]).join('\t'))].join('\n') + '\n'
      filename = `${exportStem}.tsv`
    }
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [region, derived, guideView.sorted, checked, rs3Model, refSeq, edited, pam, frame, armsFor, orientation, blockChoiceMap, loadedControls, query, hasInvalidEditedBases, displayedFeatureItems])

  const exportAnnotatedSnapGene = useCallback(() => {
    if (!region || !derived || hasInvalidEditedBases) return
    const sequence = edited.filter((record) => !record.del).map((record) => record.base).join('')
    if (!sequence) return

    const activeBefore = new Uint32Array(edited.length + 1)
    for (let index = 0; index < edited.length; index += 1) {
      activeBefore[index + 1] = activeBefore[index] + (edited[index].del ? 0 : 1)
    }
    const exportedLevels = new Set(['imported', 'custom', 'promoter', 'stop'])
    const editColors = { sub: '#7b3fe4', ins: '#18a66f', del: '#e13a32' }
    const editKinds = { sub: 'Replacement', ins: 'Insertion', del: 'Deletion' }
    const editFeatures = derived.editList.flatMap((edit) => {
      let start = activeBefore[Math.max(0, Math.min(edited.length, edit.displayStart))]
      let end = activeBefore[Math.max(0, Math.min(edited.length, edit.displayEnd + 1))]
      const deletionBoundary = end <= start
      if (deletionBoundary) {
        start = Math.max(0, Math.min(sequence.length - 1, start))
        end = Math.min(sequence.length, start + 1)
      }
      if (end <= start) return []
      const kind = editKinds[edit.type] ?? 'Sequence edit'
      return [{
        name: edit.label,
        type: 'variation',
        level: 'edit',
        start,
        end,
        strand: 1,
        color: editColors[edit.type] ?? '#7b3fe4',
        source: `RetroEdit ${kind.toLowerCase()} · ${edit.length.toLocaleString()} bp${deletionBoundary ? ' · feature marks the deletion junction' : ''}`,
      }]
    })
    const seen = new Set()
    const annotationFeatures = displayedFeatureItems.flatMap((feature) => {
      if (!exportedLevels.has(feature.level)) return []
      const ds = Math.max(0, Math.min(edited.length - 1, Math.round(feature.ds)))
      const de = Math.max(ds, Math.min(edited.length - 1, Math.round(feature.de)))
      const start = activeBefore[ds]
      const end = activeBefore[de + 1]
      if (end <= start) return []
      const key = `${feature.name}:${start}:${end}:${feature.strand ?? 1}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{
        name: feature.name, type: feature.type,
        level: feature.level, start, end,
        strand: feature.strand, color: feature.color,
        source: feature.source,
      }]
    })
    const file = buildSnapGeneFile({
      name: `RetroEdit ${loadedControls?.query ?? query}`,
      sequence,
      features: [...editFeatures, ...annotationFeatures],
      circular: false,
    })
    const url = URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `retroedit_${exportFilenameToken(loadedControls?.query ?? query)}_annotated.dna`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [region, derived, hasInvalidEditedBases, edited, displayedFeatureItems, loadedControls, query])

  // ---- panel resizing ----
  const startResize = useCallback((event) => {
    event.preventDefault()
    const startX = event.clientX
    const startW = sidebarWidth
    const onMove = (e) => {
      const w = startW + (startX - e.clientX)
      setSidebarWidth(Math.max(320, Math.min(880, w)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }, [sidebarWidth])

  // ---- editing ----
  const selRange = selection && selection.anchor !== selection.focus
    ? [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)]
    : null

  const selectedFeatureDraft = useMemo(() => {
    if (!selRange || !region?.reference) return null
    const [start, end] = selRange
    const selected = edited.slice(start, end)
    let minRef = Infinity
    let maxRef = -Infinity
    selected.forEach((record) => {
      if (record.ref == null) return
      minRef = Math.min(minRef, record.ref)
      maxRef = Math.max(maxRef, record.ref)
    })
    const chrom = String(region.reference.chrom).replace(/^chr/i, '')
    const range = Number.isFinite(minRef) && Number.isFinite(maxRef)
      ? `chr${chrom}:${(region.reference.start + minRef).toLocaleString()}${(region.reference.start + maxRef).toLocaleString()}`
      : `edited bases ${(start + 1).toLocaleString()}${end.toLocaleString()}`
    return { ds: start, de: end - 1, range, length: end - start }
  }, [edited, region?.reference?.chrom, region?.reference?.start, selRange?.[0], selRange?.[1]])

  // Every mutating action goes through commit(), which records history.
  const commit = useCallback((next, nextCaret) => {
    setShowAllGuides(false)
    setPendingDraft(null)
    setPast((p) => [...p, edited])
    setFuture([])
    setEdited(next)
    if (nextCaret != null) setCaret(nextCaret)
    setSelection(null)
  }, [edited])

  const applyAminoAcidCodon = useCallback((target, codingCodon) => {
    if (!target || !codingCodon || target.displayIdx.length !== 3) return
    const next = edited.slice()
    target.displayIdx.forEach((displayIndex, codonIndex) => {
      const record = next[displayIndex]
      if (!record || record.ref == null || record.del) return
      const codingBase = codingCodon[codonIndex]
      next[displayIndex] = {
        ...record,
        base: target.strand === 1 ? codingBase : complementBase(codingBase),
        del: false,
      }
    })
    commit(next, Math.max(...target.displayIdx) + 1)
    setAminoAcidEdit(null)
    requestAnimationFrame(() => viewerRef.current?.scrollToIndex?.(target.displayIdx[1], 'center'))
  }, [commit, edited])

  const toggleGuideExplore = useCallback(() => {
    if (hasInvalidEditedBases) return
    setSelectedGuideId(null)
    setShowAllGuides((current) => {
      const next = !current
      if (next) setAllGuidesRequested(true)
      return next
    })
  }, [hasInvalidEditedBases])

  const canUndo = past.length > 0
  const canRedo = future.length > 0

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p
      const prev = p[p.length - 1]
      setFuture((f) => [edited, ...f])
      setEdited(prev)
      setCaret((c) => Math.min(c, prev.length))
      setSelection(null)
      return p.slice(0, -1)
    })
  }, [edited])

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f
      const nxt = f[0]
      setPast((p) => [...p, edited])
      setEdited(nxt)
      setCaret((c) => Math.min(c, nxt.length))
      setSelection(null)
      return f.slice(1)
    })
  }, [edited])

  const handleKeyDown = useCallback((event) => {
    const key = event.key
    if (event.metaKey || event.ctrlKey) {
      // Undo / redo shortcuts.
      if (key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key.toLowerCase() === 'y') {
        event.preventDefault(); redo()
      }
      return
    }
    if (event.altKey) return
    const upper = key.toUpperCase()

    if (key.length === 1 && BASES.has(upper)) {
      event.preventDefault()
      if (selRange) commit(replaceRange(edited, selRange[0], selRange[1], upper), selRange[0] + 1)
      else commit(insertAt(edited, caret, upper), caret + 1)
    } else if (key === 'Backspace') {
      event.preventDefault()
      if (selRange) commit(deleteRange(edited, selRange[0], selRange[1]), selRange[0])
      else if (caret > 0) commit(deleteRange(edited, caret - 1, caret), caret - 1)
    } else if (key === 'Delete') {
      event.preventDefault()
      if (selRange) commit(deleteRange(edited, selRange[0], selRange[1]), selRange[0])
      else if (caret < edited.length) commit(deleteRange(edited, caret, caret + 1), caret)
    } else if (key === 'ArrowLeft') {
      event.preventDefault(); setCaret(Math.max(0, caret - 1)); setSelection(null)
    } else if (key === 'ArrowRight') {
      event.preventDefault(); setCaret(Math.min(edited.length, caret + 1)); setSelection(null)
    } else if (key === 'Escape') {
      setSelection(null)
    }
  }, [edited, caret, selRange, commit, undo, redo])

  const handlePaste = useCallback((event) => {
    const raw = event.clipboardData?.getData('text/plain') ?? ''
    if (!raw) return
    event.preventDefault()
    // Preserve every non-whitespace symbol so unsupported bases can be seen
    // and corrected instead of being silently discarded.
    const pasted = raw.replace(/\s+/g, '').toUpperCase()
    if (!pasted) return
    const start = selRange ? selRange[0] : caret
    const next = selRange
      ? replaceRange(edited, selRange[0], selRange[1], pasted)
      : insertAt(edited, caret, pasted)
    commit(next, start + Array.from(pasted).length)
  }, [edited, caret, selRange, commit])

  const focusFirstInvalidBase = useCallback(() => {
    const first = invalidEditedBases[0]
    if (!first) return
    setSelection({ anchor: first.index, focus: first.index + 1 })
    setCaret(first.index + 1)
    requestAnimationFrame(() => {
      viewerRef.current?.scrollToIndexCentered(first.index)
      viewerRef.current?.focus()
    })
  }, [invalidEditedBases])

  // Left and Right always belong to the sequence cursor once a sequence is
  // loaded. Text-entry controls and modal dialogs retain native arrow behavior.
  useEffect(() => {
    if (!region) return undefined
    const moveSequenceCursor = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="dialog"]')) return

      event.preventDefault()
      event.stopPropagation()
      const delta = event.key === 'ArrowLeft' ? -1 : 1
      setCaret((current) => Math.max(0, Math.min(edited.length, current + delta)))
      setSelection(null)
      viewerRef.current?.focus()
    }
    window.addEventListener('keydown', moveSequenceCursor, true)
    return () => window.removeEventListener('keydown', moveSequenceCursor, true)
  }, [edited.length, region])


  const recoverDraft = useCallback(() => {
    if (!pendingDraft || !region || !validDraftFor(pendingDraft, region.reference)) return
    const recovered = pendingDraft.edited.map((record) => ({ ...record }))
    setPast([makeEdited(region.reference.seq)])
    setFuture([])
    setEdited(recovered)
    setCaret(Math.min(recovered.length, Math.max(0, recovered.findIndex((record) => record.del || record.ref == null || region.reference.seq[record.ref] !== record.base))))
    setSelection(null)
    setSelectedGuideId(null)
    setPendingDraft(null)
  }, [pendingDraft, region])

  const discardDraft = useCallback(() => {
    window.sessionStorage.removeItem(DRAFT_KEY)
    setPendingDraft(null)
  }, [])
  const revert = useCallback(() => {
    if (!region) return
    commit(makeEdited(region.reference.seq), 0)
    setSelectedGuideId(null)
  }, [region, commit])

  const selectGuide = useCallback((id, source = 'table') => {
    // Clicking the already-selected guide deselects it.
    setSelectedGuideId((cur) => {
      if (cur === id) {
        viewerGuideCopyRef.current = null
        return null
      }
      const g = guideView.items.find((x) => x.id === id)
      viewerGuideCopyRef.current = source === 'viewer' && g ? id : null
      if (g) viewerRef.current?.scrollToIndex(g.ds)
      return id
    })
  }, [guideView.items])

  return (
    <div className="app">
      {/* <header className="topbar">
        <div className="brand">
          <span className="logo">✂︎</span>
          <div>
            <h1>RetroEdit</h1>
            <p>Search a locus, make an edit, pick a guide, get an HDR repair template.</p>
          </div>
        </div>
        <Rs3Badge status={rs3Status} scorable={scorable} />
      </header> */}

      <Controls
        genomeId={genomeId} onGenome={handleGenomeChange}
        query={query} onQuery={setQuery}
        pam={pam} onPam={setPam}
        onSearch={(example) => doLoad(example ? { query: example } : undefined)}
        onCancelLoad={cancelLoad}
        loading={loading}
        onCustomUpload={handleCustomUpload}
        customMode={genomeId === CUSTOM_GENOME_ID}
        customName={customUpload?.name}
        customRecords={customUpload?.records ?? []}
        customRecord={customUpload?.record?.name ?? ''}
        onCustomPosition={handleCustomPosition}
        onCustomRecord={handleCustomRecord}
        uploadProgress={customUploadProgress}
        recentSearches={recentSearches}
        onRecent={(item) => {
          setGenomeId(item.genomeId)
          setQuery(item.query)
          setPam(item.pam)
          void doLoad({ ...item })

        }}
        onClearRecent={() => {
          window.localStorage.removeItem(RECENT_KEY)
          setRecentSearches([])
        }}
        onClearSelection={setSelection}
        loadChanged={loadChanged}
      />
      {featureDraft && (
        <CustomFeatureDialog
          draft={featureDraft}
          onClose={() => setFeatureDraft(null)}
          onApply={addCustomFeature}
        />
      )}

      {aminoAcidEdit && (
        <AminoAcidEditDialog
          edit={aminoAcidEdit}
          onClose={() => setAminoAcidEdit(null)}
          onApply={applyAminoAcidCodon}
        />
      )}

      {loadConfirmOpen && (
        <div
          className="spacermatchbackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeLoadConfirmation(false)
          }}
        >
          <section className="loadconfirmmodal" role="dialog" aria-modal="true" aria-labelledby="load-confirm-title" aria-describedby="load-confirm-description">
            <div className="loadconfirmbrand">RetroEdit</div>
            <h2 id="load-confirm-title">{loadConfirmCopy?.title}</h2>
            <p id="load-confirm-description">{loadConfirmCopy?.description}</p>
            <div className="loadconfirmactions">
              <button ref={loadConfirmCancelRef} type="button" onClick={() => closeLoadConfirmation(false)}>Cancel</button>
              <button ref={loadConfirmActionRef} type="button" className={loadConfirmCopy?.tone ?? 'danger'} onClick={() => closeLoadConfirmation(true)}>{loadConfirmCopy?.action}</button>
            </div>
          </section>
        </div>
      )}

      {spacerMatchDialog && (
        <div
          className="spacermatchbackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSpacerMatchDialog(null)
          }}
        >
          <section className="spacermatchmodal" role="dialog" aria-modal="true" aria-labelledby="spacer-match-title">
            <header>
              <div>
                <h2 id="spacer-match-title">Choose a genomic spacer match</h2>
                <p>
                  <code>{spacerMatchDialog.spacer}</code>
                  {spacerMatchDialog.reverseComplemented ? (
                    <> matches the reverse-strand guide <code>{spacerMatchDialog.matchedSpacer}</code> at {spacerMatchDialog.matches.length.toLocaleString()} sites with a {spacerMatchDialog.pam} PAM.</>
                  ) : (
                    <> has {spacerMatchDialog.matches.length.toLocaleString()} exact matches on either genomic strand with a {spacerMatchDialog.pam} PAM.</>
                  )}
                </p>
              </div>
              <button type="button" className="spacermatchclose" aria-label="Close" onClick={() => setSpacerMatchDialog(null)}>×</button>
            </header>
            {spacerMatchDialog.truncated && (
              <p className="spacermatchwarning">The result limit was reached; refine the spacer or choose from the matches shown.</p>
            )}
            <div className="spacermatchlist" role="list" aria-label="Exact genomic matches">
              {spacerMatchDialog.matches.map((match) => {
                const chrom = String(match.chrom).replace(/^chr/i, '')
                return (
                  <button
                    type="button"
                    role="listitem"
                    key={`${match.chrom}:${match.protoStart}:${match.strand}`}
                    onClick={() => {
                      const spacer = spacerMatchDialog.spacer
                      setSpacerMatchDialog(null)
                      void doLoad({ query: spacer, spacerMatch: match })
                    }}
                  >
                    <span>
                      <strong>chr{chrom}:{match.protoStart.toLocaleString()}–{match.protoEnd.toLocaleString()}</strong>
                      {match.nearestGene && (
                        <small className="spacermatchgene" title={match.nearestGene.id}>
                          <b>{match.nearestGene.name}</b>
                          {match.nearestGene.distance === 0
                            ? ' · within gene'
                            : ` · ${match.nearestGene.distance.toLocaleString()} bp away`}
                        </small>
                      )}
                      <small>{match.strand} strand</small>
                    </span>
                    <span className="spacermatchpam">PAM <code>{match.pam}</code><b aria-hidden="true">→</b></span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      )}

      {error && <div className="banner error" role="alert">⚠ {error}</div>}

      {pendingDraft && (
        <div className="banner draftnotice" role="status">
          <span><strong>Unsaved edits found.</strong> Recover the draft from this browser tab?</span>
          <div>
            <button type="button" className="primary" onClick={recoverDraft}>Recover edits</button>
            <button type="button" onClick={discardDraft}>Discard</button>
          </div>
        </div>
      )}
      {!region && <GettingStarted />}

      {region && derived && (
        <Suspense fallback={<div className="workspaceloading" role="status">Preparing sequence editor…</div>}>
          {!isCustomRegion && <div className="locusbar">
            <FeatureRibbon
              opts={viewOpts}
              onChange={setViewOpts}
              biotypes={biotypes}
              status={gStatus}
              assembly={region.reference.assembly}
              frameAvailable={!!frame}
              overviewTargetRef={setOverviewTarget}
              locusOverview={locusOverview}
              shownBp={region.reference.seq.length}
              exonNav={exonNav}
              navigationDisabled={loading}
              onSnapExon={() => snapToExon(exonNav?.index)}
              onPreviousExon={() => snapToExon((exonNav?.index ?? 0) - 1)}
              onNextExon={() => snapToExon((exonNav?.index ?? -1) + 1)}
              onPanLeft={() => shiftWindow(-1)}
              onPanRight={() => shiftWindow(1)}
            />
          </div>}

          <div className="workspace">
            <div className="editorpane">
              <EditBar
                editList={derived.editList}
                selRange={selRange}
                edits={derived.edits}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={undo}
                onRedo={redo}
                onRevert={revert}
                onEditFocus={focusEditInViewer}
                customFeatureCount={customFeatureItems.length + derived.editList.length}
                onDownloadSnapGene={exportAnnotatedSnapGene}
                snapGeneDisabled={hasInvalidEditedBases}
                annotationOptions={viewOpts}
                onAnnotationChange={setViewOpts}
                biotypes={biotypes}
                annotationStatus={gStatus}
                assembly={region.reference.assembly}
                inputKey={query}
                loadedInputKey={loadedControls?.query ?? query}
                showAnnotations={!isCustomRegion}
                sequenceLineMode={sequenceLineMode}
                onSequenceLineMode={setSequenceLineMode}
                exploreGuides={exploringGuides}
                onExploreGuides={toggleGuideExplore}
                sequenceBlocked={hasInvalidEditedBases}
                sequenceSearch={sequenceSearch}
                onSequenceSearch={(value) => {
                  setSequenceSearch(value)
                  setSequenceMatchIndex(0)
                }}
                sequenceMatches={sequenceMatches}
                sequenceMatchIndex={sequenceMatchIndex}
                onPreviousSequenceMatch={() => stepSequenceMatch(-1)}
                onNextSequenceMatch={() => stepSequenceMatch(1)}
              />
              {hasInvalidEditedBases && (
                <div className="sequencevalidation" role="alert">
                  <span>
                    <strong>Fix pasted sequence before continuing.</strong>{' '}
                    {invalidEditedBases.length} unsupported {invalidEditedBases.length === 1 ? 'symbol' : 'symbols'} found
                    ({[...new Set(invalidEditedBases.map((item) => item.base))].slice(0, 8).join(', ')}).
                    Use only A, C, G, or T; highlighted symbols remain editable.
                  </span>
                  <button type="button" onClick={focusFirstInvalidBase}>Go to first issue</button>
                </div>
              )}
              <SequenceViewer
                ref={viewerRef}
                reference={region.reference}
                locusOverview={locusOverview}
                overviewTarget={overviewTarget}
                edited={edited}
                lineMode={sequenceLineMode}
                guideItems={guideView.items}
                featureItems={displayedFeatureItems}
                guideRibbon={guideRibbon}
                donorRibbon={donorRibbon}
                cutColumn={selectedGuide ? selectedGuide.cutDS : null}
                tss={tssMarker}
                codonCells={codonCells}
                onAminoAcidEdit={setAminoAcidEdit}
                variantItems={displayedVariantItems}
                focusSpan={focusSpanDisplay}
                emphasizedEdit={emphasizedEdit}
                nearMask={derived.nearMask}
                junctions={derived.junctions}
                caret={caret}
                selection={selection}
                featureSelection={selectedFeatureDraft}
                onAddFeature={openCustomFeatureDialog}
                onEditFeature={editCustomFeature}
                onDeleteFeature={deleteCustomFeature}
                sequenceSearch={sequenceSearch}
                searchMatches={sequenceMatches}
                searchMatchIndex={sequenceMatchIndex}
                selectedGuideId={selectedGuideId}
                onCaretChange={setCaret}
                onSelectionChange={setSelection}
                onSelectGuide={selectGuide}
                onOverviewNavigate={isCustomRegion ? undefined : navigateOverview}
                onOverviewGene={isCustomRegion ? undefined : navigateToOverviewGene}
                onOverviewResize={isCustomRegion ? undefined : resizeOverview}
                onOverviewZoom={isCustomRegion ? undefined : zoomNearbyOverview}
                onOverviewExon={isCustomRegion ? undefined : snapToExon}
                overviewDisabled={loading}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onExtendLeft={() => extendRegion(-1)}
                onExtendRight={() => extendRegion(1)}
                extensionDisabled={loading}
              />
            </div>

            <div className="resizer" onMouseDown={startResize} title="Drag to resize" />

            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <GuideTable
                guides={guideView.sorted}
                hasEdits={derived.edits}
                sequenceBlocked={hasInvalidEditedBases}
                exploreMode={exploringGuides}
                rs3Model={rs3Model}
                onRs3Model={setRs3Model}
                scorable={scorable}
                rs3Available={rs3Status.rs3}
                selectedGuideId={selectedGuideId}
                onSelect={selectGuide}
                checked={checked}
                onToggle={toggleChecked}
                onToggleAll={toggleAll}
                offAvailable={offTargets.available}
                variantWarn={guideVariantWarn}
                assembly={region.reference.assembly}
                pamPattern={pam}
                showOffTargets
                getOffTargetHref={offTargetLocusHref}
              />
              {!exploringGuides && (
              <DonorPanel
                donor={donor}
                guide={selectedGuide}
                armLeft={selectedArms.left}
                armRight={selectedArms.right}
                onArmLeft={(v) => setSelectedArm('left', v)}
                onArmRight={(v) => setSelectedArm('right', v)}
                onArmRatio={setSelectedArmRatio}
                onArmTotal={setSelectedArmTotal}
                armsCustomized={armsCustomized}
                onApplyArmsToAll={applyArmsToAll}
                orientation={orientation}
                onOrientation={setOrientation}
                blockingChoice={selectedBlockingChoice}
                onBlockingChoice={setSelectedBlockingChoice}
                scaffold={TRACR_RNAS[rs3Model].scaffold}
                scaffoldLabel={TRACR_RNAS[rs3Model].label}
                guideChecked={selectedGuide ? checked.has(selectedGuide.id) : false}
                guideNeedsUpdate={selectedGuideNeedsLibraryUpdate}
                onAddToLibrary={() => selectedGuide && addOrUpdateChecked(selectedGuide.id)}
                libraryCount={guideView.sorted.filter((guide) => guide.metricsReady && checked.has(guide.id)).length}
                onExport={exportGuides}
                reference={region.reference}
              />
              )}
            </aside>
          </div>
        </Suspense>
      )}

    </div>
  )
}

function GettingStarted() {
  return (
    <main className="gettingstarted">
      <header className="demotitle">
        <h1>RetroEdit Demo</h1>
        <p>Follow the workflow below to see how a precise-editing design moves from locus to export.</p>
      </header>
      <div className="tutorialstart">
        <span className="tutorialnumber">1</span>
        <div><h2>Input gene or locus</h2><p>Type a symbol, rsID, or coordinate above and press Load, or choose an example button.</p></div>
      </div>
      <div className="tutorialnavigate">
        <div className="tutorialstep compact">
          <span className="tutorialnumber">2</span>
          <div>
            <h3>Navigate and resize the gene view</h3>
            <p>Drag the highlighted window to move, drag either edge to resize it, or click an exon to snap.</p>
          </div>
        </div>
        <div className="mockoverview" aria-hidden="true">
          <span className="mockoverview-gene" />
          <i className="e1" /><i className="e2" /><i className="e3" /><i className="e4" />
          <b><em /><em /></b>
        </div>
      </div>
      <div className="tutoriallayout">
        <section className="tutorialmock tutorialsequence">
          <div className="tutorialstep">
            <span className="tutorialnumber">3</span>
            <div><h3>Edit sequence here</h3><p>Select bases, type to insert, double-click a base to mutate it, or press Delete to remove it.</p></div>
          </div>
          <div className="mocksequence" aria-hidden="true">
            <div className="mocktrackrow mockdnarow">
              <b>Sequence</b>
              <div className="mockdnatrack">
                <span className="mockstrand">ACTGACC<span className="mockedit mocksub">A</span>GAGGCTAC<span className="mockedit mockins">TT</span>CGTAG<span className="mockedit mockdel">GCT</span>GACCTGAGGCTACCGTA</span>
                <span className="mockstrand mockcomplement">TGACTGG<span className="mockedit mocksub">T</span>CTCCGATG<span className="mockedit mockins">AA</span>GCATC<span className="mockedit mockdel">CGA</span>CTGGACTCCGATGGCAT</span>
              </div>
            </div>
            <div className="mockeditlegend">
              <span className="mocksub">C→A mutation</span><span className="mockins">+TT insertion</span><span className="mockdel">−GCT deletion</span>
            </div>
            <div className="mocktrackrow mockcodonrow"><b>Codons / AA</b><div className="mockcodons"><span>ACT · T</span><span>GAG · E</span><span>GCT · A</span><span>ACC · T</span></div></div>
            <div className="mocktrackrow mockvariantrow">
              <b>Variants</b>
              <div className="mockvariants"><span className="gnomad-common">gnomAD ≥1%</span><span className="gnomad-rare">gnomAD rare</span><span className="clinvar-pathogenic">ClinVar pathogenic</span></div>
            </div>
            <div className="mockannotations">
              <div className="mockannotationlane"><b>Gene</b><span className="mockgene">GENE</span></div>
              <div className="mockannotationlane"><b>Exon composition</b><span className="mockutr">5′ UTR</span><span className="mockcds">Exon 1 · CDS</span></div>
              <div className="mockannotationlane"><b>Transcript ★</b><span className="mocktranscript"><i /><i /><i /></span></div>
            </div>
          </div>
        </section>
        <span className="tutorialflow" aria-hidden="true">→</span>
        <aside className="tutorialmock tutorialright">
          <div className="tutorialpanel">
            <div className="tutorialstep compact">
              <span className="tutorialnumber">4</span>
              <div><h3>Select sgRNA</h3><p>Compare efficiency, distance, off-target matches, and re-cut disruption.</p></div>
            </div>
            <div className="mockguides" aria-hidden="true"><i /><i /><i /></div>
          </div>
          <div className="tutorialpanel">
            <div className="tutorialstep compact">
              <span className="tutorialnumber">5</span>
              <div><h3>Select repair template(s)</h3><p>Review donor strand, homology arms, and the disrupting mutation.</p></div>
            </div>
            <div className="mockdonor" aria-hidden="true"><i /><i /><i /></div>
          </div>
          <div className="tutorialpanel export">
            <div className="tutorialstep compact">
              <span className="tutorialnumber">6</span>
              <div><h3>Export designs</h3><p>Check completed designs and export FASTA or TSV.</p></div>
            </div>
          </div>
        </aside>
      </div>
      <div className="tutorialfinish">
        <span className="tutorialnumber">7</span>
        <div>
          <h3>Order reagents and edit in the lab</h3>
          <p>Use your exported designs to order oligos or gBlocks, then take your precise-editing experiment into the lab.</p>
        </div>
      </div>
    </main>
  )
}

function Rs3Badge({ status, scorable }) {
  const ok = status.rs3
  return (
    <div className={`rs3badge ${ok ? 'on' : 'off'}`} title={status.detail ?? ''}>
      <span className="dot" />
      RS3 {ok ? 'online' : 'offline'}
      {!scorable && ok && <em> · needs 20 nt spacer + 3 nt PAM</em>}
    </div>
  )
}
