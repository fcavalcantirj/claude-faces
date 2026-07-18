'use client'

import { useEffect } from 'react'
import { EMOTION_META, EMOTIONS, TOTAL, type Emotion } from '@/lib/face-points'

interface FaceHudProps {
  emotion: Emotion
  onEmotionChange: (emotion: Emotion) => void
  /** Neutral, configurable HUD title. Defaults to 'AGENT FACE'. */
  title?: string
  /** Secondary line under the title. */
  subtitle?: string
  /**
   * Optional speech-to-text readout (e.g. "BROWSER WHISPER · WEBGPU") surfaced
   * so users see the active STT engine/backend — i.e. that $0/private mode is on.
   */
  sttReadout?: string
}

export function FaceHud({
  emotion,
  onEmotionChange,
  title = 'AGENT FACE',
  subtitle = 'VOICE FACE INTERFACE',
  sttReadout,
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
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between font-mono">
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
        <div className="flex items-center gap-2 pt-1">
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

      {/* side readouts */}
      <div className="flex items-end justify-between px-4 pb-3 md:px-6">
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
        </dl>
        <p className="hidden text-right text-[10px] leading-relaxed tracking-wider text-muted-foreground/60 md:block">
          DRAG TO ORBIT
          <br />
          KEYS 1&ndash;0 / Q / W TO SWITCH STATE
        </p>
      </div>

      {/* emotion controls */}
      <nav
        aria-label="Emotion states"
        className="pointer-events-auto flex flex-wrap justify-center gap-1 border-t border-border/60 px-2 py-3 md:gap-2"
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
