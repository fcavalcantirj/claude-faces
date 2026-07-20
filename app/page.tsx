'use client'

// The Agent Faces home screen — the full conversation UI wired around the
// orchestrator. It mounts the selected FaceSkin, hands it to the orchestrator to
// drive, and surfaces the controls for a spoken turn:
//
//   • Talk — press-and-hold (push-to-talk) OR tap to toggle hands-free VAD,
//     depending on the selected input mode. Space also works for PTT.
//   • A text box to type a turn when you'd rather not speak.
//   • Interrupt (Esc) — global barge-in that aborts the reply and stops speech.
//   • A live transcript panel that updates token-by-token as the brain streams.
//   • The 12-emotion HUD (manual override) + the settings drawer.
//
// The face shows THINKING while the brain streams and SPEAKING synced to the
// real audio; a resting `[[face:x]]` directive (or reply sentiment) settles it
// when the turn ends. All the heavy pipeline wiring lives in useOrchestrator so
// this file stays a thin shell; the FSM itself is headlessly tested.

import { useState } from 'react'
import { Settings } from 'lucide-react'
import { FaceSkinHost } from '@/components/face-skin'
import { FaceHud } from '@/components/face-hud'
import { SettingsPanel } from '@/components/settings-panel'
import { useConversation } from '@/lib/use-conversation'
import { useEmotion } from '@/lib/face/use-emotion'
import { useOrchestrator } from '@/lib/use-orchestrator'
import { useCapabilities } from '@/lib/use-capabilities'
import { formatLatencyReadout } from '@/lib/latency'

/** Short, human label for the active lifecycle phase (HUD readout). */
const PHASE_LABEL: Record<string, string> = {
  idle: 'READY',
  listening: 'LISTENING',
  transcribing: 'TRANSCRIBING',
  waiting: 'THINKING',
  streaming: 'THINKING',
  speaking: 'SPEAKING',
  error: 'ERROR',
}

export default function Home() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const { turns, state, setInputMode } = useConversation()
  const { emotion, setEmotion } = useEmotion()
  const {
    status,
    handsFree,
    listening,
    attachSkin,
    pttHandlers,
    toggleHandsFree,
    sendText,
    interrupt,
  } = useOrchestrator()

  // Graceful degradation: probe server keys + browser abilities on load and
  // reconcile settings to a working path. The face stays interactive regardless;
  // we surface a "configure a brain" banner (no chat) and any voice-in/out hints.
  const { matrix, hasBrain, loading: capsLoading } = useCapabilities()
  const voiceHints = matrix.features.filter(
    (f) => f.key !== 'chat' && !f.available && f.message,
  )

  const busy =
    status.phase !== 'idle' && status.phase !== 'error' && status.phase !== 'listening'

  const sttReadout = status.sttEngine
    ? `${status.sttEngine.toUpperCase()}${status.sttBackend ? ` · ${status.sttBackend.toUpperCase()}` : ''}`
    : undefined
  // Last turn's speak-stop → first-word timeline (VAD share is the redemption
  // constant, estimated — see lib/latency.ts).
  const latReadout = status.latency ? formatLatencyReadout(status.latency) : undefined

  function submitDraft(e: React.FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    sendText(text)
    setDraft('')
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background">
      {/* The face renderer (selected skin) — handed to the orchestrator on ready. */}
      <FaceSkinHost
        skinId={state.settings.faceSkin}
        onReady={attachSkin}
        className="absolute inset-0 h-full w-full"
      />

      {/* HUD: emotion controls + status readouts. */}
      <FaceHud
        emotion={emotion}
        onEmotionChange={setEmotion}
        subtitle={PHASE_LABEL[status.phase] ?? 'VOICE FACE INTERFACE'}
        sttReadout={sttReadout}
        latReadout={latReadout}
      />

      {/* Settings button. */}
      <button
        type="button"
        aria-label="Open settings"
        onClick={() => setSettingsOpen(true)}
        className="pointer-events-auto absolute right-4 top-3 z-40 rounded-sm border border-border/60 p-2 text-muted-foreground transition-colors hover:text-foreground md:right-6"
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* Live transcript panel (updates token-by-token during the stream) —
          top-left, its original home, allowed up to half the screen. */}
      {turns.length > 0 ? (
        <div className="pointer-events-none absolute left-4 top-20 z-30 flex max-h-[50vh] w-72 flex-col gap-2 overflow-y-auto font-mono text-xs md:left-6">
          {turns.slice(-6).map((t) => (
            <div
              key={t.id}
              className={
                t.role === 'user'
                  ? 'text-muted-foreground'
                  : 'text-foreground'
              }
            >
              <span className="mr-1 text-[10px] tracking-widest text-muted-foreground/50">
                {t.role === 'user' ? 'YOU' : 'FACE'}
              </span>
              {t.content}
              {t.pending ? <span className="animate-pulse">▍</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Error toast. */}
      {status.error ? (
        <div className="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded-sm border border-red-500/50 bg-red-950/60 px-3 py-1.5 font-mono text-xs text-red-300">
          {status.error}
        </div>
      ) : null}

      {/* Graceful-degradation notices. The face is never gated — only chat/voice.
          With no brain reachable we explain what to configure; voice-in/out
          shortfalls (no mic, no STT, no Web Speech) show as actionable hints. */}
      {!capsLoading && (!hasBrain || voiceHints.length > 0) ? (
        <div className="pointer-events-none absolute left-1/2 top-16 z-30 flex w-[min(92vw,32rem)] -translate-x-1/2 flex-col gap-2">
          {!hasBrain ? (
            <div className="rounded-sm border border-amber-500/50 bg-amber-950/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-amber-200">
              <span className="mr-1 tracking-widest text-amber-400/70">NO BRAIN</span>
              {matrix.chat.message}
            </div>
          ) : null}
          {voiceHints.map((f) => (
            <div
              key={f.key}
              className="rounded-sm border border-border/60 bg-card/80 px-3 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
            >
              <span className="mr-1 tracking-widest text-muted-foreground/50">
                {f.label.toUpperCase()}
              </span>
              {f.message}
            </div>
          ))}
        </div>
      ) : null}

      {/* Fast hands-free: one tap switches to hands-free AND starts listening;
          tap again returns to push-to-talk (the input-mode store subscription in
          use-orchestrator pauses the VAD and resets `listening` — no duplicate
          teardown here). Mirrors the settings INPUT control through the same
          store, so the two can never disagree. */}
      <button
        type="button"
        aria-pressed={handsFree && listening}
        disabled={!matrix.voiceIn.available}
        title={matrix.voiceIn.available ? undefined : matrix.voiceIn.message}
        onClick={() => {
          if (!matrix.voiceIn.available) return
          if (handsFree && listening) {
            setInputMode('push-to-talk')
          } else if (handsFree) {
            toggleHandsFree()
          } else {
            setInputMode('hands-free')
            toggleHandsFree()
          }
        }}
        className={`pointer-events-auto absolute bottom-24 left-4 z-40 flex select-none items-center gap-2 rounded-sm border px-3 py-2 font-mono text-[10px] tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-40 md:left-6 ${
          handsFree && listening
            ? 'border-accent bg-accent/20 text-accent'
            : 'border-border/60 text-muted-foreground hover:border-accent hover:text-foreground'
        }`}
      >
        {/* The LINK ACTIVE idiom: a small pulsing accent dot makes the pill
            findable at a glance without breaking the quiet look & feel. */}
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            handsFree && listening ? 'bg-accent' : 'animate-pulse bg-accent/80'
          }`}
        />
        {handsFree && listening ? 'SPEAK FREELY — TAP TO STOP' : 'SPEAK FREELY'}
      </button>

      {/* Control cluster — bottom-RIGHT so nothing sits on top of the face. */}
      <div className="pointer-events-none absolute bottom-24 right-4 z-40 flex w-72 flex-col gap-2 md:right-6">
        <div className="pointer-events-auto flex w-full items-center gap-2">
          <button
            type="button"
            aria-pressed={handsFree ? listening : status.phase === 'listening'}
            disabled={!matrix.voiceIn.available}
            onPointerDown={handsFree || !matrix.voiceIn.available ? undefined : pttHandlers.onPointerDown}
            onPointerUp={handsFree || !matrix.voiceIn.available ? undefined : pttHandlers.onPointerUp}
            onPointerLeave={handsFree || !matrix.voiceIn.available ? undefined : pttHandlers.onPointerLeave}
            onClick={handsFree && matrix.voiceIn.available ? toggleHandsFree : undefined}
            className={`flex-1 select-none rounded-sm border px-4 py-3 font-mono text-xs tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              (handsFree && listening) || status.speaking
                ? 'border-accent bg-accent/20 text-accent'
                : 'border-border/60 text-foreground hover:border-accent'
            }`}
          >
            {!matrix.voiceIn.available
              ? 'VOICE UNAVAILABLE — TYPE BELOW'
              : handsFree
                ? listening
                  ? 'LISTENING — TAP TO STOP'
                  : 'TAP TO LISTEN (HANDS-FREE)'
                : 'HOLD TO TALK (OR SPACE)'}
          </button>
          <button
            type="button"
            onClick={interrupt}
            disabled={!busy && !status.speaking}
            className="pointer-events-auto rounded-sm border border-border/60 px-3 py-3 font-mono text-xs tracking-widest text-muted-foreground transition-colors hover:border-red-400 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            STOP
          </button>
        </div>

        <form
          onSubmit={submitDraft}
          className="pointer-events-auto flex w-full items-center gap-2"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="…or type a message"
            className="flex-1 rounded-sm border border-border/60 bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-sm border border-border/60 px-3 py-2 font-mono text-xs tracking-widest text-foreground transition-colors hover:border-accent"
          >
            SEND
          </button>
        </form>
      </div>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </main>
  )
}
