'use client'

import { useEffect } from 'react'
import { EMOTION_META, EMOTIONS, TOTAL, type Emotion } from '@/lib/face-points'

interface FaceHudProps {
  emotion: Emotion
  onEmotionChange: (emotion: Emotion) => void
  /** Neutral, configurable HUD title. Defaults to 'AGENT FACES'. */
  title?: string
  /** Secondary line under the title. */
  subtitle?: string
  /**
   * Optional speech-to-text readout (e.g. "BROWSER WHISPER · WEBGPU") surfaced
   * so users see the active STT engine/backend — i.e. that $0/private mode is on.
   */
  sttReadout?: string
  /**
   * Optional last-turn latency readout (e.g. "VAD 1.4 · STT 0.9 · TTFT 8.2 ·
   * TTS 0.4 · TTFW 10.9s") — the per-stage speak-stop → first-word timeline.
   */
  latReadout?: string
}

export function FaceHud({
  emotion,
  onEmotionChange,
  title = 'AGENT FACES',
  subtitle = 'VOICE FACE INTERFACE',
  sttReadout,
  latReadout,
}: FaceHudProps) {
  const meta = EMOTION_META[emotion]

  // keyboard shortcuts 1-0, Q, W
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const found = EMOTIONS.find((em) => EMOTION_META[em].key === e.key.toLowerCase())
      if (found) onEmotionChange(found)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEmotionChange])

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col font-mono">
      {/* top bar */}
      <header className="flex items-start justify-between border-b border-border/60 px-4 py-3 md:px-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-bold tracking-widest text-foreground">
            {title}
          </span>
          <span className="text-[10px] tracking-wider text-muted-foreground">
            {subtitle}
          </span>
        </div>
        {/* mr clears the settings gear (absolute right-4/md:right-6 in page.tsx)
            so LINK ACTIVE sits fully LEFT of it — they overlapped before. pt
            centers the label on the gear's vertical midline (gear: top-3 + p-2). */}
        <div className="mr-10 flex items-center gap-2 pt-2.5 md:mr-12">
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ backgroundColor: meta.hex }}
            aria-hidden="true"
          />
          <span className="text-[10px] tracking-widest text-muted-foreground">
            LINK ACTIVE
          </span>
        </div>
      </header>

      {/* side readouts — TOP-RIGHT under the header, mirroring the transcript
          panel top-left; the bottom corners belong to SPEAK FREELY (left) and
          the control cluster (right). */}
      <div className="flex justify-end px-4 pt-4 md:px-6">
        <div className="flex flex-col gap-2">
        <dl className="flex flex-col gap-1 text-[10px] tracking-wider text-muted-foreground">
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground/60">STATE</dt>
            <dd style={{ color: meta.hex }}>{meta.label}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground/60">SIGNAL</dt>
            <dd>{meta.status}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground/60">PARTICLES</dt>
            <dd>{TOTAL.toLocaleString()}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground/60">RENDER</dt>
            <dd>WEBGL // POINT CLOUD</dd>
          </div>
          {sttReadout ? (
            <div className="flex gap-2">
              <dt className="w-20 text-muted-foreground/60">STT</dt>
              <dd>{sttReadout}</dd>
            </div>
          ) : null}
          {latReadout ? (
            <div className="flex gap-2">
              <dt className="w-20 text-muted-foreground/60">LAT</dt>
              <dd>{latReadout}</dd>
            </div>
          ) : null}
        </dl>
        {/* Lives under the readout now — its old bottom-right corner belongs
            to the control cluster. */}
        <p className="hidden text-[10px] leading-relaxed tracking-wider text-muted-foreground/60 md:block">
          DRAG TO ORBIT
          <br />
          KEYS 1&ndash;0 / Q / W TO SWITCH STATE
        </p>
        </div>
      </div>

      {/* emotion controls */}
      <nav
        aria-label="Emotion states"
        className="pointer-events-auto mt-auto flex flex-wrap justify-center gap-1 border-t border-border/60 px-2 py-3 md:gap-2"
      >
        {EMOTIONS.map((em) => {
          const m = EMOTION_META[em]
          const active = em === emotion
          return (
            <button
              key={em}
              type="button"
              onClick={() => onEmotionChange(em)}
              aria-pressed={active}
              className={`group flex flex-col items-center gap-1 rounded-sm border px-2.5 py-2 text-[10px] tracking-widest transition-colors md:px-3.5 ${
                active
                  ? 'border-current bg-card'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
              }`}
              style={active ? { color: m.hex } : undefined}
            >
              <span className="text-muted-foreground/50 group-hover:text-muted-foreground">
                {m.key}
              </span>
              <span>{m.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
