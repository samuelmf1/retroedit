const FEATURE_KEYS = new Set([
  'CDS', 'exon', 'gene', 'intron', 'misc_binding', 'misc_feature',
  'promoter', 'regulatory', 'repeat_region', 'source', 'variation',
])

function cleanText(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim()
}

function featureKey(feature) {
  const requested = String(feature.type ?? '')
  if (FEATURE_KEYS.has(requested)) return requested
  if (feature.level === 'promoter') return 'promoter'
  return 'misc_feature'
}

function qualifier(name, value) {
  const text = cleanText(value)
  if (!text) return []
  const prefix = `                     /${name}="`
  const continuation = '                     '
  const maxFirst = 79 - prefix.length
  const maxNext = 79 - continuation.length
  const lines = []
  let remaining = text
  let first = true
  while (remaining.length) {
    const width = first ? maxFirst : maxNext
    let take = Math.min(width, remaining.length)
    if (take < remaining.length) {
      const boundary = remaining.lastIndexOf(' ', take)
      if (boundary > Math.floor(width * 0.55)) take = boundary
    }
    lines.push(`${first ? prefix : continuation}${remaining.slice(0, take)}`)
    remaining = remaining.slice(take).replace(/^\s+/, '')
    first = false
  }
  lines[lines.length - 1] += '"'
  return lines
}

function formatDate(date = new Date()) {
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][date.getUTCMonth()]
  return `${String(date.getUTCDate()).padStart(2, '0')}-${month}-${date.getUTCFullYear()}`
}

function locusName(name) {
  const cleaned = String(name ?? 'RetroEdit').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '')
  return (cleaned || 'RetroEdit').slice(0, 16)
}

/** Build a broadly compatible GenBank flat file from 0-based, half-open features. */
export function buildGenBankFile({ name = 'RetroEdit', sequence, features = [], circular = false }) {
  const seq = String(sequence ?? '').replace(/\s/g, '').toUpperCase()
  if (!seq) throw new Error('Cannot export an empty sequence.')
  const topology = circular ? 'circular' : 'linear'
  const lines = [
    `LOCUS       ${locusName(name).padEnd(16)}${String(seq.length).padStart(12)} bp    DNA     ${topology.padEnd(8)} SYN ${formatDate()}`,
    `DEFINITION  ${cleanText(name)}; edited and annotated in RetroEdit.`,
    'ACCESSION   .',
    'VERSION     .',
    'KEYWORDS    .',
    'SOURCE      synthetic DNA construct',
    '  ORGANISM  synthetic DNA construct',
    '            other sequences; artificial sequences.',
    'FEATURES             Location/Qualifiers',
    `     source          1..${seq.length}`,
    '                     /organism="synthetic DNA construct"',
    '                     /mol_type="other DNA"',
  ]

  const validFeatures = features.filter((feature) => (
    Number.isInteger(feature.start) && Number.isInteger(feature.end) &&
    feature.start >= 0 && feature.end > feature.start && feature.end <= seq.length
  ))
  for (const feature of validFeatures) {
    const range = `${feature.start + 1}..${feature.end}`
    const location = feature.strand === -1 ? `complement(${range})` : range
    lines.push(`     ${featureKey(feature).padEnd(16)}${location}`)
    lines.push(...qualifier('label', feature.name || 'Feature'))
    if (feature.source) lines.push(...qualifier('note', feature.source))
    const color = /^#[0-9a-f]{6}$/i.test(feature.color ?? '') ? feature.color : '#526b7b'
    lines.push(...qualifier('ApEinfo_fwdcolor', color))
    lines.push(...qualifier('ApEinfo_revcolor', color))
  }

  lines.push('ORIGIN')
  for (let offset = 0; offset < seq.length; offset += 60) {
    const groups = seq.slice(offset, offset + 60).toLowerCase().match(/.{1,10}/g)?.join(' ') ?? ''
    lines.push(`${String(offset + 1).padStart(9)} ${groups}`)
  }
  lines.push('//')
  return `${lines.join('\n')}\n`
}
