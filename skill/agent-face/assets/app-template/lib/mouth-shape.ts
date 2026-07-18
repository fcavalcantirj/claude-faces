// Viseme -> mouth deformation mapping for the particle renderer.
//
// Converts a lip-sync {viseme, amplitude} pair into vertical (jaw) and
// horizontal (width) scale factors that the renderer applies to the mouth
// particle group about MOUTH_Y and the mouth's horizontal centre. Pure math,
// no Three.js / DOM dependency, so it is unit-testable headlessly and stays the
// single source of truth for how each viseme shapes the mouth.

export interface MouthShape {
  /** Vertical scale about MOUTH_Y. 1 = resting/closed, >1 = jaw dropped open. */
  openY: number;
  /** Horizontal scale about the mouth centre. <1 narrows (O/U), >1 widens (aa). */
  widthX: number;
}

interface VisemeGeom {
  /** Relative jaw drop 0..1 reached at full amplitude. */
  jaw: number;
  /** Target horizontal width factor at full amplitude (1 = unchanged). */
  width: number;
}

// Per-viseme mouth geometry. `jaw` is how far the mouth opens vertically at full
// amplitude; `width` is the horizontal spread — rounded/pursed vowels (O, U)
// pull below 1 to narrow, spread vowels (aa, E, I) push above 1 to widen.
const VISEME_GEOM: Record<string, VisemeGeom> = {
  viseme_sil: { jaw: 0.0, width: 1.0 }, // closed, no motion on amplitude
  viseme_PP: { jaw: 0.05, width: 0.92 }, // bilabial: lips together
  viseme_FF: { jaw: 0.15, width: 1.0 },
  viseme_TH: { jaw: 0.28, width: 1.0 },
  viseme_DD: { jaw: 0.32, width: 1.0 },
  viseme_kk: { jaw: 0.36, width: 1.0 },
  viseme_CH: { jaw: 0.3, width: 0.85 },
  viseme_SS: { jaw: 0.2, width: 1.08 },
  viseme_nn: { jaw: 0.26, width: 1.0 },
  viseme_RR: { jaw: 0.34, width: 0.95 },
  viseme_aa: { jaw: 1.0, width: 1.32 }, // open + wide
  viseme_E: { jaw: 0.58, width: 1.2 },
  viseme_I: { jaw: 0.42, width: 1.26 },
  viseme_O: { jaw: 0.72, width: 0.74 }, // open + rounded/narrow
  viseme_U: { jaw: 0.5, width: 0.64 }, // pursed/narrow
};

// Fallback for any viseme label not in the table: a moderate neutral open.
const DEFAULT_GEOM: VisemeGeom = { jaw: 0.4, width: 1.0 };

// Maximum extra vertical scale added on top of the resting mouth (1.0) at full
// amplitude on a fully-open viseme, so `aa` at volume 1 reaches ~2.15x.
const MAX_OPEN = 1.15;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Map a lip-sync viseme + smoothed amplitude (0..1) to mouth scale factors.
 * At amplitude 0 the mouth rests (openY=1, widthX=1) regardless of viseme; as
 * amplitude rises the jaw drops per the viseme and the width spreads/narrows.
 */
export function mouthShapeForViseme(viseme: string, open: number): MouthShape {
  const o = clamp01(open);
  const geom = VISEME_GEOM[viseme] ?? DEFAULT_GEOM;
  const openY = 1 + o * geom.jaw * MAX_OPEN;
  const widthX = 1 + o * (geom.width - 1);
  return { openY, widthX };
}
