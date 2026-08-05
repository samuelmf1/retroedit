import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchProteinStructure } from '../lib/genomics.js'

function residueSelection(residues, chainId = 'A') {
  const positions = [...new Set(residues.map((residue) => Number(residue.position)).filter(Number.isInteger))]
  if (!positions.length) return ''
  return positions.map((position) => `(${position} and :${chainId})`).join(' or ')
}

function sideChainSelection(selection) {
  return selection ? `(${selection}) and sidechainAttached` : ''
}

function residueLabelSelection(selection) {
  return selection ? `(${selection}) and .CA` : ''
}

function mutationLabel(residue) {
  const reference = residue.referenceAa || '?'
  const alternate = residue.alternateAa || '?'
  if (alternate === reference) return `${reference}${residue.position} (synonymous DNA edit)`
  if (alternate === 'Δ') return `${reference}${residue.position} deletion`
  return `${reference}${residue.position}${alternate}`
}

export default function ProteinStructureModal({ gene, assembly, residues, onClose }) {
  const hostRef = useRef(null)
  const stageRef = useRef(null)
  const componentRef = useRef(null)
  const [metadata, setMetadata] = useState(null)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const selection = useMemo(
    () => residueSelection(residues, metadata?.chainId),
    [residues, metadata?.chainId],
  )
  const highlightedSideChains = useMemo(() => sideChainSelection(selection), [selection])
  const highlightedLabels = useMemo(() => residueLabelSelection(selection), [selection])

  useEffect(() => {
    document.body.classList.add('protein-modal-open')
    return () => document.body.classList.remove('protein-modal-open')
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    setStatus('loading')
    setError('')
    fetchProteinStructure({ assembly, gene }, controller.signal)
      .then((payload) => {
        if (disposed) return
        setMetadata(payload)
        if (!payload.available) {
          setError(payload.reason || 'No AlphaFold model is available for this protein.')
          setStatus('error')
        }
      })
      .catch((reason) => {
        if (disposed || reason.name === 'AbortError') return
        setError(reason.message || 'The protein structure could not be loaded.')
        setStatus('error')
      })
    return () => {
      disposed = true
      controller.abort()
    }
  }, [assembly, gene])

  useEffect(() => {
    if (!metadata?.available || !hostRef.current) return undefined
    let disposed = false
    let resizeObserver
    const dark = document.documentElement.dataset.theme === 'dark'

    import('ngl').then(async (module) => {
      if (disposed || !hostRef.current) return
      // NGL's package entry exposes a CommonJS-style default in Node, while
      // Vite's browser bundle exposes named ESM exports. Support both shapes.
      const Stage = module.Stage || module.default?.Stage
      if (typeof Stage !== 'function') throw new Error('The molecular viewer did not expose its Stage renderer.')
      const stage = new Stage(hostRef.current, {
        backgroundColor: dark ? '#101b20' : '#f3f8fb',
        tooltip: true,
        quality: 'high',
      })
      stageRef.current = stage
      resizeObserver = new ResizeObserver(() => stage.handleResize())
      resizeObserver.observe(hostRef.current)
      try {
        const component = await stage.loadFile(metadata.modelUrl, {
          ext: 'pdb', defaultRepresentation: false,
        })
        if (disposed) return
        componentRef.current = component
        component.addRepresentation('cartoon', {
          color: dark ? '#78a9e8' : '#507fb8',
          opacity: 0.94,
          quality: 'high',
        })
        if (selection) {
          component.addRepresentation('ball+stick', {
            // Show each reference side chain plus its attached alpha carbon.
            // Glycine has no side-chain heavy atom, so its alpha carbon remains
            // visible as the biologically accurate reference representation.
            sele: highlightedSideChains,
            color: '#ed3b34',
            aspectRatio: 1.8,
            scale: 2.1,
            quality: 'high',
          })
          component.addRepresentation('label', {
            // Label only the alpha carbon so each edited residue gets one label,
            // rather than repeating the residue name on every displayed atom.
            sele: highlightedLabels,
            labelType: 'residue',
            color: dark ? '#fff5f3' : '#7f1d1d',
            backgroundColor: dark ? '#7f1d1d' : '#fff7f6',
            backgroundOpacity: 0.9,
            borderColor: '#ef6a62',
            borderWidth: 1,
            radiusScale: 0.7,
            attachment: 'middle-center',
          })
          component.autoView(highlightedSideChains, 700)
        } else {
          component.autoView(700)
        }
        setStatus('ready')
      } catch (reason) {
        if (disposed) return
        setError(reason.message || 'The AlphaFold model could not be rendered.')
        setStatus('error')
      }
    }).catch((reason) => {
      if (disposed) return
      setError(reason.message || 'The molecular viewer could not be loaded.')
      setStatus('error')
    })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      stageRef.current?.dispose()
      stageRef.current = null
      componentRef.current = null
    }
  }, [metadata, selection, highlightedSideChains, highlightedLabels])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const focusMutations = () => {
    if (highlightedSideChains) componentRef.current?.autoView(highlightedSideChains, 500)
  }
  const showWholeProtein = () => componentRef.current?.autoView(500)

  return (
    <div className="proteinmodal" role="dialog" aria-modal="true" aria-labelledby="protein-structure-title">
      <header className="proteinmodalhead">
        <button type="button" className="proteinclose" onClick={onClose} aria-label="Close protein structure">
          <span aria-hidden="true">←</span> Exit structure
        </button>
        <div>
          <strong id="protein-structure-title">Protein structure</strong>
          <span>{metadata?.description || gene}</span>
        </div>
        <nav aria-label="Structure view controls">
          <button type="button" onClick={showWholeProtein} disabled={status !== 'ready'}>Whole protein</button>
          <button type="button" className="primary" onClick={focusMutations} disabled={status !== 'ready' || !selection}>
            Focus mutation{residues.length === 1 ? '' : 's'}
          </button>
        </nav>
      </header>
      <div className="proteinmodalbody">
        <section className="proteinviewport" aria-label="Interactive three-dimensional protein structure">
          <div ref={hostRef} className="proteinngl" />
          {status === 'loading' && (
            <div className="proteinloading" role="status">
              <i aria-hidden="true" />
              <strong>Loading AlphaFold structure…</strong>
              <span>Resolving the reviewed protein and mapping edited residues.</span>
            </div>
          )}
          {status === 'error' && <div className="proteinerror" role="alert"><strong>Structure unavailable</strong><span>{error}</span></div>}
          {status === 'ready' && <small className="proteinhint">Drag to rotate · scroll or pinch to zoom · click atoms to inspect</small>}
        </section>
        <aside className="proteininspector">
          <div className="proteinsource">
            <span>AlphaFold DB model</span>
            <strong>{metadata?.entryId || 'Resolving…'}</strong>
            {metadata?.confidence != null && <small>Mean pLDDT {Number(metadata.confidence).toFixed(1)}</small>}
          </div>
          <section>
            <h3>Highlighted residue{residues.length === 1 ? '' : 's'} <b>{residues.length}</b></h3>
            <div className="proteinmutations">
              {residues.map((residue) => {
                const modelAa = metadata?.sequence?.[residue.position - 1]
                const verified = !modelAa || !residue.referenceAa || modelAa === residue.referenceAa
                return (
                  <button type="button" key={residue.position} onClick={() => {
                    const residueAtoms = residueSelection([residue], metadata?.chainId || 'A')
                    componentRef.current?.autoView(sideChainSelection(residueAtoms), 450)
                  }}>
                    <i aria-hidden="true" />
                    <span><strong>{mutationLabel(residue)}</strong><small>Residue {residue.position}{verified ? '' : ' · isoform mismatch'}</small></span>
                  </button>
                )
              })}
            </div>
          </section>
          <p className="proteinreference">The structure remains the AlphaFold reference prediction; red side chains mark where your coding edits act. Glycine has no side-chain heavy atom.</p>
          {metadata?.sourceUrl && (
            <a className="proteinalphafold" href={metadata.sourceUrl} target="_blank" rel="noreferrer">
              Open source entry in AlphaFold DB <span aria-hidden="true">↗</span>
            </a>
          )}
        </aside>
      </div>
    </div>
  )
}
