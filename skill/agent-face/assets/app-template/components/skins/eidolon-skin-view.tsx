'use client'

// The React/R3F view for the EIDOLON skin. Split into its own module (and
// dynamic-imported by eidolon-skin.tsx's mount()) so the Three.js/R3F renderer
// only loads when a skin is actually mounted — keeping the controller light and
// headlessly importable.
//
// Emotion/speaking come from the controller as imperative updates; we mirror
// them into local React state via a subscription so the AgentFace re-renders on
// those (infrequent) changes. The high-frequency mouth updates stay ref-based
// (driver.mouthRef) and never trigger a re-render.

import { useEffect, useState } from 'react'
import { AgentFace } from '@/components/agent-face'
import type { EidolonSkinDriver } from './eidolon-skin'

export function EidolonSkinView({ driver }: { driver: EidolonSkinDriver }) {
  const initial = driver.getState()
  const [emotion, setEmotion] = useState(initial.emotion)
  const [speaking, setSpeaking] = useState(initial.speaking)

  useEffect(() => {
    return driver.bindView({ onEmotion: setEmotion, onSpeaking: setSpeaking })
  }, [driver])

  return (
    <AgentFace
      emotion={emotion}
      speaking={speaking}
      mouthSource="analyser"
      mouthRef={driver.mouthRef}
    />
  )
}
