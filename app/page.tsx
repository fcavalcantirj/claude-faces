'use client'

// TEMPORARY demo mount for the ported EIDOLON particle face + HUD.
// Lets a human confirm the face renders, all 12 emotions cycle via the
// 1-0/Q/W keys or the on-screen controls, and the mouth is now driven by real
// lip-sync features (not the old fake sine). Replaced by the full conversation
// orchestrator UI in the "Wire the full conversation orchestrator" task.
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { FaceHud } from '@/components/face-hud'
import { SettingsPanel } from '@/components/settings-panel'
import type { MouthState } from '@/components/agent-face'
import type { Emotion } from '@/lib/face-points'
import { estimateFeatures } from '@/lib/lipsync'

// The R3F renderer touches browser-only APIs (canvas 2D sprite, WebGL), so
// load it client-only to avoid running document.createElement during SSR.
const AgentFace = dynamic(
  () => import('@/components/agent-face').then((m) => m.AgentFace),
  { ssr: false },
)

export default function Home() {
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Ref-based mouth state so the 60fps particle loop never re-renders React.
  const mouthRef = useRef<MouthState>({ open: 0, viseme: 'viseme_sil' })

  // DEMO driver: while the "speaking" emotion is active, feed the real
  // estimated lip-sync envelope (the Web Speech fallback path in lib/lipsync)
  // into the mouth ref on each frame so a human can watch audio-shaped visemes
  // open/close/widen the mouth. The orchestrator task swaps this for real
  // analyser/estimated features straight from the TTS layer.
  useEffect(() => {
    if (emotion !== 'speaking') {
      mouthRef.current.open = 0
      mouthRef.current.viseme = 'viseme_sil'
      return
    }
    const phrase = 'hello, i am your agent face and i am speaking to you now'
    const periodMs = 3400
    let raf = 0
    let start = 0
    const tick = (ts: number) => {
      if (!start) start = ts
      const f = estimateFeatures(phrase, (ts - start) % periodMs)
      mouthRef.current.open = f.volume
      mouthRef.current.viseme = f.viseme
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emotion])

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background">
      <AgentFace
        emotion={emotion}
        speaking={emotion === 'speaking'}
        mouthSource="estimated"
        mouthRef={mouthRef}
      />
      <FaceHud emotion={emotion} onEmotionChange={setEmotion} />
      <button
        type="button"
        aria-label="Open settings"
        onClick={() => setSettingsOpen(true)}
        className="pointer-events-auto absolute right-4 top-3 z-40 rounded-sm border border-border/60 p-2 text-muted-foreground transition-colors hover:text-foreground md:right-6"
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </main>
  )
}
