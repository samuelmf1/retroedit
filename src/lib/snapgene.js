const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function packet(type, data) {
  const payload = data instanceof Uint8Array ? data : encoder.encode(data)
  const out = new Uint8Array(5 + payload.length)
  const view = new DataView(out.buffer)
  out[0] = type
  view.setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

function parseRange(spec, sequenceLength) {
  const match = /^(\d+)-(\d+)$/.exec(spec ?? '')
  if (!match) return []
  const start = Number(match[1])
  const end = Number(match[2])
  if (start < 1 || end < 1 || start > sequenceLength || end > sequenceLength) return []
  return start <= end ? [{ start, end }] : [{ start, end: sequenceLength }, { start: 1, end }]
}

function directChildren(element, tagName) {
  return [...element.children].filter((child) => child.tagName === tagName)
}

function parseFeaturesXml(xmlText, sequenceLength) {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('The SnapGene feature packet contains invalid XML.')
  const features = []
  const cds = []
  ;[...document.getElementsByTagName('Feature')].forEach((feature, featureIndex) => {
    const type = feature.getAttribute('type') || 'misc_feature'
    const baseName = feature.getAttribute('name') || `${type} ${featureIndex + 1}`
    const strand = feature.getAttribute('directionality') === '2' ? -1 : 1
    directChildren(feature, 'Segment').forEach((segment, segmentIndex) => {
      if ((segment.getAttribute('type') || 'standard') === 'gap') return
      const colorValue = segment.getAttribute('color')
      const color = /^#[0-9a-f]{6}$/i.test(colorValue ?? '') ? colorValue : '#526b7b'
      const segmentName = segment.getAttribute('name')
      parseRange(segment.getAttribute('range'), sequenceLength).forEach((range, rangeIndex) => {
        const name = segmentName || baseName
        const id = `snapgene-${featureIndex}-${segmentIndex}-${rangeIndex}`
        const imported = {
          id, name, type, level: 'imported', start: range.start, end: range.end,
          strand, color, source: `SnapGene · ${type.replaceAll('_', ' ')}`,
        }
        features.push(imported)
        if (type.toLowerCase() === 'cds') {
          cds.push({
            id: `${id}-cds`, transcript: `snapgene-cds-${featureIndex}`,
            start: range.start, end: range.end, strand, phase: 0,
          })
        }
      })
    })
  })
  const cdsByTranscript = new Map()
  for (const segment of cds) {
    if (!cdsByTranscript.has(segment.transcript)) cdsByTranscript.set(segment.transcript, [])
    cdsByTranscript.get(segment.transcript).push(segment)
  }
  for (const segments of cdsByTranscript.values()) {
    const strand = segments[0]?.strand ?? 1
    segments.sort((a, b) => strand === 1 ? a.start - b.start : b.start - a.start)
    let codingLength = 0
    for (const segment of segments) {
      segment.phase = (3 - (codingLength % 3)) % 3
      codingLength += segment.end - segment.start + 1
    }
  }
  return { features, cds }
}

export function isSnapGeneBuffer(buffer) {
  const bytes = new Uint8Array(buffer)
  return bytes.length >= 19 && bytes[0] === 0x09 && decoder.decode(bytes.slice(5, 13)) === 'SnapGene'
}

export function parseSnapGeneFile(buffer, filename = 'sequence.dna') {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let sawCookie = false
  let sequence = ''
  let topology = 'linear'
  let featureXml = null
  let notesName = ''
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) throw new Error('Unexpected end of SnapGene packet header.')
    const type = bytes[offset]
    const length = view.getUint32(offset + 1, false)
    const start = offset + 5
    const end = start + length
    if (end > bytes.length) throw new Error('Unexpected end of SnapGene packet.')
    const payload = bytes.slice(start, end)
    if (offset === 0) {
      if (type !== 0x09 || length !== 14 || decoder.decode(payload.slice(0, 8)) !== 'SnapGene') {
        throw new Error('The file is not a valid SnapGene DNA file.')
      }
      sawCookie = true
    } else if (type === 0x00) {
      if (length < 2) throw new Error('The SnapGene DNA packet is empty.')
      topology = payload[0] & 1 ? 'circular' : 'linear'
      sequence = decoder.decode(payload.slice(1)).replace(/\s/g, '').toUpperCase()
    } else if (type === 0x0a) {
      featureXml = decoder.decode(payload)
    } else if (type === 0x06) {
      const notes = decoder.decode(payload)
      notesName = /<Comments>([^<]+)<\/Comments>/.exec(notes)?.[1] ?? ''
    }
    offset = end
  }
  if (!sawCookie || !sequence) throw new Error('The SnapGene file does not contain a DNA sequence.')
  const invalid = [...new Set(sequence.replace(/[ACGTRYSWKMBDHVN]/g, ''))]
  if (invalid.length) throw new Error(`Unsupported DNA character${invalid.length === 1 ? '' : 's'} in SnapGene file: ${invalid.slice(0, 12).join(' ')}`)
  const fallbackName = filename.replace(/\.dna$/i, '') || 'SnapGene sequence'
  const name = (notesName || fallbackName).trim().split(/\s+/)[0]
  const annotations = featureXml ? parseFeaturesXml(featureXml, sequence.length) : { features: [], cds: [] }
  return { name, seq: sequence, length: sequence.length, topology, ...annotations }
}

export function buildSnapGeneFile({ name = 'RetroEdit', sequence, features = [], circular = false }) {
  const seq = String(sequence ?? '').replace(/\s/g, '').toUpperCase()
  if (!seq) throw new Error('Cannot export an empty sequence.')
  const cookie = new Uint8Array(14)
  cookie.set(encoder.encode('SnapGene'), 0)
  const cookieView = new DataView(cookie.buffer)
  cookieView.setUint16(8, 1, false)
  cookieView.setUint16(10, 15, false)
  cookieView.setUint16(12, 20, false)

  const dna = new Uint8Array(1 + seq.length)
  dna[0] = circular ? 1 : 0
  dna.set(encoder.encode(seq), 1)

  const validFeatures = features.filter((feature) => (
    Number.isInteger(feature.start) && Number.isInteger(feature.end) &&
    feature.start >= 0 && feature.end > feature.start && feature.end <= seq.length
  ))
  const featureXml = `<?xml version="1.0"?><Features nextValidID="${validFeatures.length}">` +
    validFeatures.map((feature, index) => {
      const directionality = feature.strand === -1 ? 2 : 1
      const type = feature.type || (feature.level === 'promoter' ? 'promoter' : 'misc_feature')
      const color = /^#[0-9a-f]{6}$/i.test(feature.color ?? '') ? feature.color : '#526b7b'
      const note = feature.source ? `<Q name="note"><V text="${xmlEscape(feature.source)}"/></Q>` : ''
      return `<Feature recentID="${index}" name="${xmlEscape(feature.name || `Feature ${index + 1}`)}" directionality="${directionality}" type="${xmlEscape(type)}" allowSegmentOverlaps="0" consecutiveTranslationNumbering="1">` +
        `<Segment range="${feature.start + 1}-${feature.end}" color="${color}" type="standard"/>${note}</Feature>`
    }).join('') + '</Features>'

  const now = new Date()
  const date = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`
  const notes = `<Notes><Type>Synthetic</Type><LastModified>${date}</LastModified><Comments>${xmlEscape(name)}</Comments><Description>Edited and annotated in RetroEdit.</Description></Notes>`
  return concatBytes([packet(0x09, cookie), packet(0x00, dna), packet(0x0a, featureXml), packet(0x06, notes)])
}
