'use client'

// FaceSkinHost — selects a face skin by id (from settings) and mounts it,
// defaulting to EIDOLON. This is the ONLY place that knows which concrete skin
// exists; the orchestrator just receives the mounted FaceSkin (via onReady) and
// drives it through the interface, so swapping skins never touches orchestrator
// code. Requesting the 'talkinghead' stretch skin when it isn't available
// degrades to EIDOLON with a console warning (see resolveSkinId) rather than
// crashing.

import { useEffect, useRef } from 'react'
import { createEidolonSkin } from '@/components/skins/eidolon-skin'
import { createTalkingHeadSkin, isTalkingHeadAvailable } from '@/components/skins/talkinghead-skin'
import {
  DEFAULT_SKIN_ID,
  resolveSkinId,
  type FaceSkin,
  type FaceSkinId,
} from '@/lib/face/skin'

/** Build the concrete controller for an already-resolved skin id. */
export function createFaceSkin(id: FaceSkinId): FaceSkin {
  return id === 'talkinghead' ? createTalkingHeadSkin() : createEidolonSkin()
}

export interface FaceSkinHostProps {
  /** Which skin to render; defaults to EIDOLON. */
  skinId?: FaceSkinId
  /**
   * Whether the TalkingHead skin is usable. Defaults to a runtime probe
   * (model URL configured); pass explicitly to override.
   */
  talkingHeadAvailable?: boolean
  /** Receives the mounted FaceSkin so the orchestrator can drive it. */
  onReady?: (skin: FaceSkin) => void
  className?: string
}

export function FaceSkinHost({
  skinId = DEFAULT_SKIN_ID,
  talkingHeadAvailable,
  onReady,
  className,
}: FaceSkinHostProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const available = talkingHeadAvailable ?? isTalkingHeadAvailable()
    const resolved = resolveSkinId(skinId, { talkingHeadAvailable: available })
    const skin = createFaceSkin(resolved)

    let disposed = false
    Promise.resolve(skin.mount(el)).then(() => {
      if (!disposed) onReadyRef.current?.(skin)
    })

    return () => {
      disposed = true
      skin.dispose()
    }
  }, [skinId, talkingHeadAvailable])

  return <div ref={containerRef} className={className ?? 'h-full w-full'} />
}
