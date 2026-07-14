// Grayscale ramp for RS3 on-target scores: darker = stronger guide.
// High RS3 renders near-black, low RS3 renders pale grey.

const DARK = [23, 33, 43] // strong guide
const LIGHT = [214, 221, 228] // weak guide
const NEUTRAL = '#c2ccd6' // unscored

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

// RS3 sequence scores are roughly z-scored around 0; this domain spreads the
// usable range across the ramp without clipping typical guides.
export const RS3_DOMAIN = [-1.5, 1.5]

export function rs3Norm(score) {
  const [lo, hi] = RS3_DOMAIN
  return Math.max(0, Math.min(1, (score - lo) / (hi - lo)))
}

/** t in [0,1] (0 = weak, 1 = strong) → grey along the ramp (strong = dark). */
export function grayscale(t) {
  const x = Math.max(0, Math.min(1, t))
  return `rgb(${lerp(LIGHT[0], DARK[0], x)}, ${lerp(LIGHT[1], DARK[1], x)}, ${lerp(LIGHT[2], DARK[2], x)})`
}

/** Fill for a guide bar/letter: grey by RS3, or a flat neutral when unscored. */
export function rs3Fill(score) {
  return typeof score === 'number' ? grayscale(rs3Norm(score)) : NEUTRAL
}

/** True when the fill is dark enough (strong guide) to need light text. */
export function rs3NeedsLightText(score) {
  return typeof score === 'number' && rs3Norm(score) > 0.45
}
