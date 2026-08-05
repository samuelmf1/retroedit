let templateRequest = null

export function loadPlasmidTemplate() {
  if (!templateRequest) {
    templateRequest = fetch('/api/plasmid/template').then(async (response) => {
      if (!response.ok) {
        throw new Error((await response.json().catch(() => null))?.detail || 'Plasmid template is unavailable')
      }
      return response.json()
    }).catch((error) => {
      templateRequest = null
      throw error
    })
  }
  return templateRequest
}

export function assemblePlasmid(template, spacer, scaffold, scaffoldLabel, repairTemplate) {
  const guideAt = template.anchors.guide_insert_after
  const repairAt = template.anchors.repair_insert_after
  const guideInsert = `${spacer}${scaffold}`.toUpperCase()
  const repairInsert = repairTemplate.toUpperCase()
  const sequence = template.sequence.slice(0, guideAt) + guideInsert +
    template.sequence.slice(guideAt, repairAt) + repairInsert + template.sequence.slice(repairAt)
  const guideDelta = guideInsert.length
  const repairStart = repairAt + guideDelta

  const mapStart = (position) => position + (position >= guideAt ? guideDelta : 0) +
    (position >= repairAt ? repairInsert.length : 0)
  const mapEnd = (position) => position + (position > guideAt ? guideDelta : 0) +
    (position > repairAt ? repairInsert.length : 0)

  const features = template.features.map((feature) => ({
    ...feature,
    start: mapStart(feature.start),
    end: mapEnd(feature.end),
  }))
  features.push(
    { id: 'user-spacer', label: 'Spacer', type: 'guide', strand: 1, start: guideAt, end: guideAt + spacer.length, inserted: true },
    { id: 'user-scaffold', label: 'Scaffold', detail: scaffoldLabel, type: 'guide', strand: 1, start: guideAt + spacer.length, end: guideAt + guideInsert.length, inserted: true },
    { id: 'user-repair', label: 'Repair template', type: 'repair', strand: 1, start: repairStart, end: repairStart + repairInsert.length, inserted: true },
  )
  return {
    name: `${template.name}_designed`,
    sequence,
    features,
    insertions: features.filter((feature) => feature.inserted),
  }
}
