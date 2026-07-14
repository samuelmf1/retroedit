// Genome + provider registries.
//
// A genome is a named coordinate system ("Human GRCh38") bound to a provider
// that knows how to serve sequence, gene lookups, and features for it. Adding a
// build, an organism, or a custom genome means calling `registerGenome` with a
// provider name; adding a new backend means `registerProvider`.

const providers = new Map()
const genomes = new Map()

export function registerProvider(name, impl) {
  for (const method of ['lookupGene', 'fetchSequence', 'fetchFeatures']) {
    if (typeof impl[method] !== 'function') {
      throw new Error(`Provider "${name}" is missing ${method}()`)
    }
  }
  providers.set(name, impl)
  return impl
}

export function getProvider(name) {
  const impl = providers.get(name)
  if (!impl) throw new Error(`Unknown genome provider "${name}"`)
  return impl
}

/**
 * @param {object} def
 * @param {string} def.id           stable key, e.g. "human-grch38"
 * @param {string} def.organism     grouping label, e.g. "Human"
 * @param {string} def.assembly     build name, e.g. "GRCh38"
 * @param {string} def.provider     registered provider name
 * @param {number} [def.maxRegionBp]
 * @param {string} [def.note]       shown next to the picker
 * Any extra keys are passed through to the provider (host, species, data, ...).
 */
export function registerGenome(def) {
  if (!def?.id) throw new Error('Genome needs an id')
  if (!providers.has(def.provider)) throw new Error(`Unknown provider "${def.provider}"`)
  const genome = {
    label: `${def.organism} · ${def.assembly}`,
    maxRegionBp: 300_000,
    maxFeatureBp: 120_000,
    ...def,
  }
  genomes.set(genome.id, genome)
  return genome
}

export function listGenomes() {
  return [...genomes.values()]
}

export function getGenome(id) {
  const g = genomes.get(id)
  if (!g) throw new Error(`Unknown genome "${id}"`)
  return g
}

/** `[["Human", [grch38, grch37]], ["Mouse", [...]]]` — for grouped <optgroup>s. */
export function genomesByOrganism() {
  const groups = new Map()
  for (const g of genomes.values()) {
    if (!groups.has(g.organism)) groups.set(g.organism, [])
    groups.get(g.organism).push(g)
  }
  return [...groups.entries()]
}

/** "chr13" / "13" / "chrM" -> the token the providers expect. */
export function normalizeChrom(chrom) {
  const bare = String(chrom).replace(/^chr/i, '')
  if (/^(M|MT)$/i.test(bare)) return 'MT'
  return /^[xy]$/i.test(bare) ? bare.toUpperCase() : bare
}
