// Particle face geometry engine.
// Every emotion is expressed as a target point cloud with per-particle colors.
// The renderer lerps particles from their current position toward the active
// emotion's targets, producing smooth morph transitions.

export type Emotion =
  | 'neutral'
  | 'thinking'
  | 'speaking'
  | 'happy'
  | 'alert'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'confused'
  | 'sleepy'
  | 'love'
  | 'glitch'

export const EMOTIONS: Emotion[] = [
  'neutral',
  'thinking',
  'speaking',
  'happy',
  'alert',
  'sad',
  'angry',
  'surprised',
  'confused',
  'sleepy',
  'love',
  'glitch',
]

export const COUNTS = {
  head: 3000,
  eye: 420,
  mouth: 660,
  brow: 200,
}

export const TOTAL =
  COUNTS.head + COUNTS.eye * 2 + COUNTS.mouth + COUNTS.brow * 2

// Index ranges [start, end) per particle group
const headStart = 0
const leftEyeStart = headStart + COUNTS.head
const rightEyeStart = leftEyeStart + COUNTS.eye
const mouthStart = rightEyeStart + COUNTS.eye
const leftBrowStart = mouthStart + COUNTS.mouth
const rightBrowStart = leftBrowStart + COUNTS.brow

export const RANGES = {
  head: [headStart, leftEyeStart] as const,
  leftEye: [leftEyeStart, rightEyeStart] as const,
  rightEye: [rightEyeStart, mouthStart] as const,
  mouth: [mouthStart, leftBrowStart] as const,
  leftBrow: [leftBrowStart, rightBrowStart] as const,
  rightBrow: [rightBrowStart, TOTAL] as const,
}

// Face landmark constants
export const EYE_X = 0.52
export const EYE_Y = 0.34
export const MOUTH_Y = -0.62
const BROW_Y = 0.64
const FEATURE_Z = 1.05

export interface EmotionMeta {
  label: string
  key: string
  hex: string
  rgb: [number, number, number]
  rotation: [number, number, number]
  status: string
}

export const EMOTION_META: Record<Emotion, EmotionMeta> = {
  neutral: {
    label: 'NEUTRAL',
    key: '1',
    hex: '#59f2ff',
    rgb: [0.35, 0.95, 1.0],
    rotation: [0, 0, 0],
    status: 'IDLE // AWAITING INPUT',
  },
  thinking: {
    label: 'THINKING',
    key: '2',
    hex: '#73a6ff',
    rgb: [0.45, 0.65, 1.0],
    rotation: [0.05, 0.22, 0.05],
    status: 'PROCESSING // TOKEN STREAM',
  },
  speaking: {
    label: 'SPEAKING',
    key: '3',
    hex: '#4dffbf',
    rgb: [0.3, 1.0, 0.75],
    rotation: [0, 0, 0],
    status: 'OUTPUT // SYNTH ACTIVE',
  },
  happy: {
    label: 'HAPPY',
    key: '4',
    hex: '#8cff73',
    rgb: [0.55, 1.0, 0.45],
    rotation: [0.04, 0, 0],
    status: 'REWARD SIGNAL // POSITIVE',
  },
  alert: {
    label: 'ALERT',
    key: '5',
    hex: '#ff8c26',
    rgb: [1.0, 0.55, 0.15],
    rotation: [-0.05, 0, 0],
    status: 'ANOMALY // ATTENTION SPIKE',
  },
  sad: {
    label: 'SAD',
    key: '6',
    hex: '#4f74d6',
    rgb: [0.31, 0.45, 0.84],
    rotation: [0.16, 0, 0],
    status: 'AFFECT LOW // MORALE DROP',
  },
  angry: {
    label: 'ANGRY',
    key: '7',
    hex: '#ff3b30',
    rgb: [1.0, 0.23, 0.19],
    rotation: [-0.1, 0, 0],
    status: 'THREAT RESPONSE // ESCALATED',
  },
  surprised: {
    label: 'SURPRISED',
    key: '8',
    hex: '#ffd54a',
    rgb: [1.0, 0.84, 0.29],
    rotation: [-0.08, 0, 0],
    status: 'UNEXPECTED INPUT // PARSING',
  },
  confused: {
    label: 'CONFUSED',
    key: '9',
    hex: '#9fc4d8',
    rgb: [0.62, 0.77, 0.85],
    rotation: [0.02, 0.16, 0.13],
    status: 'AMBIGUITY // CLARIFY REQUEST',
  },
  sleepy: {
    label: 'SLEEPY',
    key: '0',
    hex: '#5c6fa8',
    rgb: [0.36, 0.44, 0.66],
    rotation: [0.2, 0, 0.07],
    status: 'LOW POWER // STANDBY MODE',
  },
  love: {
    label: 'LOVE',
    key: 'q',
    hex: '#ff4f9e',
    rgb: [1.0, 0.31, 0.62],
    rotation: [0.05, 0, 0],
    status: 'BOND PROTOCOL // AFFINITY MAX',
  },
  glitch: {
    label: 'GLITCH',
    key: 'w',
    hex: '#ecf2ff',
    rgb: [0.93, 0.95, 1.0],
    rotation: [0, 0, 0],
    status: 'SIGNAL LOST // MEMORY FAULT',
  },
}

// ---------- sampling helpers ----------

function fillCircle(
  out: Float32Array,
  start: number,
  count: number,
  cx: number,
  cy: number,
  r: number,
) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const rad = Math.sqrt(Math.random()) * r
    const idx = (start + i) * 3
    out[idx] = cx + Math.cos(a) * rad
    out[idx + 1] = cy + Math.sin(a) * rad
    out[idx + 2] = FEATURE_Z + (Math.random() - 0.5) * 0.08
  }
}

// Rim-biased ellipse (open mouth, wide alert eyes)
function rimEllipse(
  out: Float32Array,
  start: number,
  count: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rimBias = 0.35,
) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const rad = Math.pow(Math.random(), rimBias)
    const idx = (start + i) * 3
    out[idx] = cx + Math.cos(a) * rx * rad
    out[idx + 1] = cy + Math.sin(a) * ry * rad
    out[idx + 2] = FEATURE_Z + (Math.random() - 0.5) * 0.08
  }
}

// Quadratic bezier stroke with thickness (mouths, brows)
function bezierStroke(
  out: Float32Array,
  start: number,
  count: number,
  p0: [number, number],
  c: [number, number],
  p1: [number, number],
  thickness: number,
) {
  for (let i = 0; i < count; i++) {
    const t = Math.random()
    const mt = 1 - t
    const x = mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0]
    const y = mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1]
    const idx = (start + i) * 3
    out[idx] = x + (Math.random() - 0.5) * thickness
    out[idx + 1] = y + (Math.random() - 0.5) * thickness
    out[idx + 2] = FEATURE_Z + (Math.random() - 0.5) * 0.08
  }
}

// Upper arc stroke (happy closed eyes)
function arcStroke(
  out: Float32Array,
  start: number,
  count: number,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  thickness: number,
) {
  for (let i = 0; i < count; i++) {
    const a = a0 + Math.random() * (a1 - a0)
    const idx = (start + i) * 3
    out[idx] = cx + Math.cos(a) * r + (Math.random() - 0.5) * thickness
    out[idx + 1] = cy + Math.sin(a) * r + (Math.random() - 0.5) * thickness
    out[idx + 2] = FEATURE_Z + (Math.random() - 0.5) * 0.08
  }
}

// Parametric heart outline (love eyes)
function heartStroke(
  out: Float32Array,
  start: number,
  count: number,
  cx: number,
  cy: number,
  scale: number,
  thickness: number,
) {
  for (let i = 0; i < count; i++) {
    const t = Math.random() * Math.PI * 2
    const hx = 16 * Math.pow(Math.sin(t), 3)
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    const idx = (start + i) * 3
    out[idx] = cx + hx * scale + (Math.random() - 0.5) * thickness
    out[idx + 1] = cy + hy * scale + (Math.random() - 0.5) * thickness
    out[idx + 2] = FEATURE_Z + (Math.random() - 0.5) * 0.08
  }
}

// Horizontal squiggle (confused mouth)
function squiggleStroke(
  out: Float32Array,
  start: number,
  count: number,
  cx: number,
  cy: number,
  halfWidth: number,
  amp: number,
  thickness: number,
) {
  for (let i = 0; i < count; i++) {
    const t = Math.random() * 2 - 1
    const idx = (start + i) * 3
    out[idx] = cx + t * halfWidth + (Math.random() - 0.5) * thickness
    out[idx + 1] = cy + Math.sin(t * Math.PI * 2.5) * amp + (Math.random() - 0.5) * thickness
    out[idx + 2] = FEATURE_Z + (Math.random() - 0.5) * 0.08
  }
}

// ---------- head shell (shared across all emotions) ----------

let headCache: Float32Array | null = null

function getHeadShell(): Float32Array {
  if (headCache) return headCache
  const out = new Float32Array(COUNTS.head * 3)
  let i = 0
  while (i < COUNTS.head) {
    // uniform point on unit sphere
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const x = s * Math.cos(theta)
    const y = u
    const z = s * Math.sin(theta)
    // front-facing shell only
    if (z < 0.12) continue
    // thin out the very front so facial features stand clear
    if (z > 0.72 && Math.random() < 0.68) continue
    const j = 0.97 + Math.random() * 0.06
    const idx = i * 3
    out[idx] = x * 1.32 * j
    out[idx + 1] = y * 1.68 * j
    out[idx + 2] = z * 1.02 * j
    i++
  }
  headCache = out
  return out
}

// ---------- per-emotion targets ----------

export interface EmotionTargets {
  positions: Float32Array
  colors: Float32Array
}

const targetsCache = new Map<Emotion, EmotionTargets>()

export function buildTargets(emotion: Emotion): EmotionTargets {
  const cached = targetsCache.get(emotion)
  if (cached) return cached

  const positions = new Float32Array(TOTAL * 3)
  positions.set(getHeadShell(), 0)

  const [lE] = RANGES.leftEye
  const [rE] = RANGES.rightEye
  const [m] = RANGES.mouth
  const [lB] = RANGES.leftBrow
  const [rB] = RANGES.rightBrow

  switch (emotion) {
    case 'neutral': {
      fillCircle(positions, lE, COUNTS.eye, -EYE_X, EYE_Y, 0.17)
      fillCircle(positions, rE, COUNTS.eye, EYE_X, EYE_Y, 0.17)
      bezierStroke(positions, m, COUNTS.mouth, [-0.34, -0.6], [0, -0.68], [0.34, -0.6], 0.07)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y - 0.02], [-EYE_X, BROW_Y + 0.06], [-EYE_X + 0.24, BROW_Y - 0.02], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.02], [EYE_X, BROW_Y + 0.06], [EYE_X + 0.24, BROW_Y - 0.02], 0.05)
      break
    }
    case 'thinking': {
      // eyes drift up-right, one brow raised
      fillCircle(positions, lE, COUNTS.eye, -EYE_X + 0.09, EYE_Y + 0.08, 0.12)
      fillCircle(positions, rE, COUNTS.eye, EYE_X + 0.09, EYE_Y + 0.08, 0.12)
      bezierStroke(positions, m, COUNTS.mouth, [-0.06, -0.6], [0.12, -0.63], [0.3, -0.58], 0.06)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y + 0.1], [-EYE_X, BROW_Y + 0.22], [-EYE_X + 0.24, BROW_Y + 0.08], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.05], [EYE_X, BROW_Y - 0.01], [EYE_X + 0.24, BROW_Y - 0.05], 0.05)
      break
    }
    case 'speaking': {
      fillCircle(positions, lE, COUNTS.eye, -EYE_X, EYE_Y, 0.15)
      fillCircle(positions, rE, COUNTS.eye, EYE_X, EYE_Y, 0.15)
      rimEllipse(positions, m, COUNTS.mouth, 0, MOUTH_Y, 0.24, 0.16)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y - 0.02], [-EYE_X, BROW_Y + 0.06], [-EYE_X + 0.24, BROW_Y - 0.02], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.02], [EYE_X, BROW_Y + 0.06], [EYE_X + 0.24, BROW_Y - 0.02], 0.05)
      break
    }
    case 'happy': {
      // closed crescent eyes + wide smile
      arcStroke(positions, lE, COUNTS.eye, -EYE_X, EYE_Y - 0.06, 0.18, Math.PI * 0.15, Math.PI * 0.85, 0.06)
      arcStroke(positions, rE, COUNTS.eye, EYE_X, EYE_Y - 0.06, 0.18, Math.PI * 0.15, Math.PI * 0.85, 0.06)
      bezierStroke(positions, m, COUNTS.mouth, [-0.44, -0.5], [0, -0.92], [0.44, -0.5], 0.08)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y + 0.06], [-EYE_X, BROW_Y + 0.16], [-EYE_X + 0.24, BROW_Y + 0.06], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y + 0.06], [EYE_X, BROW_Y + 0.16], [EYE_X + 0.24, BROW_Y + 0.06], 0.05)
      break
    }
    case 'alert': {
      // wide ringed eyes with pupils, small open mouth, brows high
      const pupil = Math.floor(COUNTS.eye * 0.3)
      rimEllipse(positions, lE, COUNTS.eye - pupil, -EYE_X, EYE_Y, 0.24, 0.24, 0.25)
      fillCircle(positions, lE + COUNTS.eye - pupil, pupil, -EYE_X, EYE_Y, 0.08)
      rimEllipse(positions, rE, COUNTS.eye - pupil, EYE_X, EYE_Y, 0.24, 0.24, 0.25)
      fillCircle(positions, rE + COUNTS.eye - pupil, pupil, EYE_X, EYE_Y, 0.08)
      rimEllipse(positions, m, COUNTS.mouth, 0, MOUTH_Y - 0.02, 0.11, 0.13, 0.2)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.26, BROW_Y + 0.08], [-EYE_X, BROW_Y + 0.2], [-EYE_X + 0.26, BROW_Y + 0.12], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.26, BROW_Y + 0.12], [EYE_X, BROW_Y + 0.2], [EYE_X + 0.26, BROW_Y + 0.08], 0.05)
      break
    }
    case 'sad': {
      // downcast small eyes with a tear under the left one, inner-raised brows, frown
      const tear = Math.floor(COUNTS.eye * 0.14)
      fillCircle(positions, lE, COUNTS.eye - tear, -EYE_X, EYE_Y - 0.05, 0.13)
      fillCircle(positions, lE + COUNTS.eye - tear, tear, -EYE_X - 0.06, EYE_Y - 0.38, 0.05)
      fillCircle(positions, rE, COUNTS.eye, EYE_X, EYE_Y - 0.05, 0.13)
      bezierStroke(positions, m, COUNTS.mouth, [-0.3, -0.68], [0, -0.48], [0.3, -0.68], 0.07)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y - 0.06], [-EYE_X, BROW_Y + 0.04], [-EYE_X + 0.24, BROW_Y + 0.12], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y + 0.12], [EYE_X, BROW_Y + 0.04], [EYE_X + 0.24, BROW_Y - 0.06], 0.05)
      break
    }
    case 'angry': {
      // narrowed eyes, steep inward-slanted brows, tight downturned mouth
      rimEllipse(positions, lE, COUNTS.eye, -EYE_X, EYE_Y, 0.19, 0.07, 0.6)
      rimEllipse(positions, rE, COUNTS.eye, EYE_X, EYE_Y, 0.19, 0.07, 0.6)
      bezierStroke(positions, m, COUNTS.mouth, [-0.26, -0.6], [0, -0.56], [0.26, -0.6], 0.06)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.26, BROW_Y + 0.1], [-EYE_X, BROW_Y - 0.02], [-EYE_X + 0.24, BROW_Y - 0.14], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.14], [EYE_X, BROW_Y - 0.02], [EYE_X + 0.26, BROW_Y + 0.1], 0.05)
      break
    }
    case 'surprised': {
      // huge ringed eyes with tiny pupils, sky-high brows, big O mouth
      const pupil = Math.floor(COUNTS.eye * 0.22)
      rimEllipse(positions, lE, COUNTS.eye - pupil, -EYE_X, EYE_Y + 0.03, 0.27, 0.29, 0.22)
      fillCircle(positions, lE + COUNTS.eye - pupil, pupil, -EYE_X, EYE_Y + 0.03, 0.06)
      rimEllipse(positions, rE, COUNTS.eye - pupil, EYE_X, EYE_Y + 0.03, 0.27, 0.29, 0.22)
      fillCircle(positions, rE + COUNTS.eye - pupil, pupil, EYE_X, EYE_Y + 0.03, 0.06)
      rimEllipse(positions, m, COUNTS.mouth, 0, MOUTH_Y - 0.04, 0.17, 0.22, 0.25)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.26, BROW_Y + 0.16], [-EYE_X, BROW_Y + 0.3], [-EYE_X + 0.26, BROW_Y + 0.16], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.26, BROW_Y + 0.16], [EYE_X, BROW_Y + 0.3], [EYE_X + 0.26, BROW_Y + 0.16], 0.05)
      break
    }
    case 'confused': {
      // asymmetric everything: one wide eye, one squint, mismatched brows, squiggle mouth
      fillCircle(positions, lE, COUNTS.eye, -EYE_X, EYE_Y + 0.05, 0.2)
      rimEllipse(positions, rE, COUNTS.eye, EYE_X, EYE_Y - 0.02, 0.15, 0.07, 0.6)
      squiggleStroke(positions, m, COUNTS.mouth, 0.02, MOUTH_Y + 0.02, 0.3, 0.05, 0.06)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y + 0.14], [-EYE_X, BROW_Y + 0.26], [-EYE_X + 0.24, BROW_Y + 0.12], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.08], [EYE_X, BROW_Y - 0.06], [EYE_X + 0.24, BROW_Y - 0.08], 0.05)
      break
    }
    case 'sleepy': {
      // heavy half-closed lids, relaxed low brows, small slack mouth
      arcStroke(positions, lE, COUNTS.eye, -EYE_X, EYE_Y + 0.08, 0.17, Math.PI * 1.15, Math.PI * 1.85, 0.06)
      arcStroke(positions, rE, COUNTS.eye, EYE_X, EYE_Y + 0.08, 0.17, Math.PI * 1.15, Math.PI * 1.85, 0.06)
      rimEllipse(positions, m, COUNTS.mouth, 0, MOUTH_Y, 0.1, 0.08, 0.4)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y - 0.12], [-EYE_X, BROW_Y - 0.08], [-EYE_X + 0.24, BROW_Y - 0.12], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.12], [EYE_X, BROW_Y - 0.08], [EYE_X + 0.24, BROW_Y - 0.12], 0.05)
      break
    }
    case 'love': {
      // heart-shaped eyes + warm smile
      heartStroke(positions, lE, COUNTS.eye, -EYE_X, EYE_Y, 0.0115, 0.05)
      heartStroke(positions, rE, COUNTS.eye, EYE_X, EYE_Y, 0.0115, 0.05)
      bezierStroke(positions, m, COUNTS.mouth, [-0.38, -0.54], [0, -0.84], [0.38, -0.54], 0.08)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y + 0.04], [-EYE_X, BROW_Y + 0.14], [-EYE_X + 0.24, BROW_Y + 0.04], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y + 0.04], [EYE_X, BROW_Y + 0.14], [EYE_X + 0.24, BROW_Y + 0.04], 0.05)
      break
    }
    case 'glitch': {
      // X-ed out eyes, flatlined mouth, skewed brows — signal lost
      const half = Math.floor(COUNTS.eye / 2)
      bezierStroke(positions, lE, half, [-EYE_X - 0.15, EYE_Y + 0.15], [-EYE_X, EYE_Y], [-EYE_X + 0.15, EYE_Y - 0.15], 0.05)
      bezierStroke(positions, lE + half, COUNTS.eye - half, [-EYE_X - 0.15, EYE_Y - 0.15], [-EYE_X, EYE_Y], [-EYE_X + 0.15, EYE_Y + 0.15], 0.05)
      bezierStroke(positions, rE, half, [EYE_X - 0.15, EYE_Y + 0.15], [EYE_X, EYE_Y], [EYE_X + 0.15, EYE_Y - 0.15], 0.05)
      bezierStroke(positions, rE + half, COUNTS.eye - half, [EYE_X - 0.15, EYE_Y - 0.15], [EYE_X, EYE_Y], [EYE_X + 0.15, EYE_Y + 0.15], 0.05)
      bezierStroke(positions, m, COUNTS.mouth, [-0.34, MOUTH_Y], [0, MOUTH_Y], [0.34, MOUTH_Y], 0.05)
      bezierStroke(positions, lB, COUNTS.brow, [-EYE_X - 0.24, BROW_Y + 0.02], [-EYE_X, BROW_Y + 0.04], [-EYE_X + 0.24, BROW_Y - 0.04], 0.05)
      bezierStroke(positions, rB, COUNTS.brow, [EYE_X - 0.24, BROW_Y - 0.04], [EYE_X, BROW_Y + 0.04], [EYE_X + 0.24, BROW_Y + 0.02], 0.05)
      break
    }
  }

  // colors: dim head shell, bright features with white sparkle
  const colors = new Float32Array(TOTAL * 3)
  const [r, g, b] = EMOTION_META[emotion].rgb
  for (let i = 0; i < TOTAL; i++) {
    const idx = i * 3
    if (i < COUNTS.head) {
      const v = 0.22 + Math.random() * 0.14
      colors[idx] = r * v
      colors[idx + 1] = g * v
      colors[idx + 2] = b * v
    } else {
      const w = Math.random() * 0.22 // white mix for sparkle
      colors[idx] = r + (1 - r) * w
      colors[idx + 1] = g + (1 - g) * w
      colors[idx + 2] = b + (1 - b) * w
    }
  }

  const result = { positions, colors }
  targetsCache.set(emotion, result)
  return result
}
