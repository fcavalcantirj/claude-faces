// Shared Web Audio graph.
//
// The whole app uses ONE AudioContext so the lipsync AnalyserNode taps exactly
// the audio the user hears: every audible source is wired
//   source -> analyser -> destination
// through this single context. Creating multiple contexts would let the mouth
// animate off audio nobody hears (or vice-versa), so route everything here.

type AudioContextCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function resolveCtor(): AudioContextCtor {
  if (typeof window !== "undefined") {
    const w = window as unknown as {
      AudioContext?: AudioContextCtor;
      webkitAudioContext?: AudioContextCtor;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (Ctor) return Ctor;
  }
  if (typeof AudioContext !== "undefined") return AudioContext;
  throw new Error("Web Audio API is not available in this environment");
}

/** Lazily create (once) and return the app-wide AudioContext singleton. */
export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new (resolveCtor())();
  return ctx;
}

/**
 * Replace (or clear) the singleton. Primarily a dependency-injection hook for
 * tests and advanced embeds that already own an AudioContext.
 */
export function setAudioContext(next: AudioContext | null): void {
  ctx = next;
}

/**
 * Resume the AudioContext. MUST be invoked from within a user gesture
 * (click/tap/keydown) — browsers start the context "suspended" under the
 * autoplay policy and only a gesture-initiated resume() unlocks playback.
 */
export async function resumeAudio(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      // A failed resume (e.g. not in a gesture) is non-fatal; the next gesture
      // can retry. Swallow so callers don't have to guard every play path.
    }
  }
  return c;
}
