// Shared viseme vocabulary so wawa-lipsync output maps consistently onto EVERY
// face skin. wawa-lipsync emits the 15 Oculus/Reallusion viseme labels; the
// EIDOLON particle skin turns them into mouth-particle deformation
// (see lib/mouth-shape.ts) while the TalkingHead/RPM skin turns them into
// morph-target (blendshape) weights. This module is the single source of truth
// for that vocabulary and the viseme -> blendshape conversion. Pure, no DOM /
// Three.js dependency, so it is unit-testable headlessly.

/** The 15 Oculus visemes emitted by wawa-lipsync, in a stable order. */
export const VISEMES = [
  'viseme_sil',
  'viseme_PP',
  'viseme_FF',
  'viseme_TH',
  'viseme_DD',
  'viseme_kk',
  'viseme_CH',
  'viseme_SS',
  'viseme_nn',
  'viseme_RR',
  'viseme_aa',
  'viseme_E',
  'viseme_I',
  'viseme_O',
  'viseme_U',
] as const

export type Viseme = (typeof VISEMES)[number]

/** The resting/closed viseme; the mouth holds shut here regardless of amplitude. */
export const SILENCE_VISEME: Viseme = 'viseme_sil'

/** label -> weight map (a subset of VISEMES is fine; absent labels are 0). */
export type VisemeScores = Record<string, number>

const VISEME_SET: ReadonlySet<string> = new Set(VISEMES)

/** True when `label` is one of the 15 canonical visemes. */
export function isViseme(label: string): label is Viseme {
  return VISEME_SET.has(label)
}

/** A fresh scores object with every canonical viseme at 0. */
export function emptyVisemeScores(): Record<Viseme, number> {
  const out = {} as Record<Viseme, number>
  for (const v of VISEMES) out[v] = 0
  return out
}

/**
 * Pick the highest-scoring viseme from a scores map. Returns SILENCE_VISEME when
 * the map is empty or every score is <= 0, so callers always get a valid label.
 */
export function dominantViseme(scores: VisemeScores | undefined | null): Viseme {
  if (!scores) return SILENCE_VISEME
  let best: string = SILENCE_VISEME
  let bestScore = 0
  for (const label in scores) {
    const s = scores[label]
    if (Number.isFinite(s) && s > bestScore) {
      bestScore = s
      best = label
    }
  }
  return isViseme(best) ? best : SILENCE_VISEME
}

// ── Blendshape systems ──────────────────────────────────────────────────────
// TalkingHead.js drives a Ready Player Me avatar; RPM avatars ship BOTH the
// Oculus visemes (morph targets literally named `viseme_aa`, `viseme_O`, …) and
// the Apple ARKit blendshapes (`jawOpen`, `mouthPucker`, …). We support both so
// the TalkingHead skin can pick whichever the loaded GLB exposes.

export type BlendshapeSystem = 'oculus' | 'arkit'

/**
 * Oculus mapping is an identity: RPM's Oculus visemes share wawa-lipsync's
 * labels, so a score map is already a blendshape-weight map.
 */
function toOculusBlendshapes(scores: VisemeScores): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of VISEMES) {
    const s = scores[v]
    if (Number.isFinite(s) && s! > 0) out[v] = Math.min(1, s!)
  }
  return out
}

/**
 * Approximate ARKit blendshape recipe per viseme (weights at full score). Used
 * when the RPM avatar exposes ARKit shapes instead of Oculus visemes. These are
 * deliberately coarse — good enough to read as speech, tunable later.
 */
const VISEME_TO_ARKIT: Record<Viseme, Record<string, number>> = {
  viseme_sil: {},
  viseme_PP: { mouthClose: 0.9, mouthPressLeft: 0.4, mouthPressRight: 0.4 },
  viseme_FF: { jawOpen: 0.15, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3, mouthFunnel: 0.2 },
  viseme_TH: { jawOpen: 0.25, tongueOut: 0.2 },
  viseme_DD: { jawOpen: 0.3, tongueOut: 0.1 },
  viseme_kk: { jawOpen: 0.3 },
  viseme_CH: { jawOpen: 0.25, mouthFunnel: 0.5, mouthPucker: 0.3 },
  viseme_SS: { jawOpen: 0.15, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 },
  viseme_nn: { jawOpen: 0.2, tongueOut: 0.1 },
  viseme_RR: { jawOpen: 0.25, mouthFunnel: 0.3 },
  viseme_aa: { jawOpen: 0.9 },
  viseme_E: { jawOpen: 0.4, mouthStretchLeft: 0.4, mouthStretchRight: 0.4 },
  viseme_I: { jawOpen: 0.3, mouthSmileLeft: 0.3, mouthSmileRight: 0.3, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  viseme_O: { jawOpen: 0.5, mouthFunnel: 0.6, mouthPucker: 0.4 },
  viseme_U: { jawOpen: 0.3, mouthPucker: 0.8, mouthFunnel: 0.4 },
}

function toArkitBlendshapes(scores: VisemeScores): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of VISEMES) {
    const s = scores[v]
    if (!Number.isFinite(s) || s! <= 0) continue
    const recipe = VISEME_TO_ARKIT[v]
    for (const shape in recipe) {
      out[shape] = Math.min(1, (out[shape] ?? 0) + recipe[shape] * Math.min(1, s!))
    }
  }
  return out
}

/**
 * Convert wawa-lipsync viseme scores into morph-target weights for the given
 * blendshape system. Only non-zero weights are returned so the caller can set
 * exactly the driven shapes and leave the rest at rest.
 */
export function visemeScoresToBlendshapes(
  scores: VisemeScores | undefined | null,
  system: BlendshapeSystem = 'oculus',
): Record<string, number> {
  if (!scores) return {}
  return system === 'arkit' ? toArkitBlendshapes(scores) : toOculusBlendshapes(scores)
}
