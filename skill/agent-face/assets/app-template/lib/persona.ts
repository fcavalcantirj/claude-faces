// The default FACE persona — the system prompt that turns any brain into a
// voice-and-face agent. It is deliberately GENERIC (no Hermes / Claude / vendor
// wording) so it works identically across every Mode A and Mode B brain.
//
// Two things every reply must respect:
//   1. It will be SPOKEN aloud (TTS) and lip-synced, so answers stay short,
//      plain, and free of markdown / code fences / emoji / URLs that sound
//      wrong read out loud.
//   2. The face can EMOTE. The model may optionally emit a single
//      `[[face:<emotion>]]` directive (from the 12-emotion vocabulary) to steer
//      expression; the client strips it before speaking (see
//      `lib/face/emotion-machine.ts`).

import { EMOTIONS } from '@/lib/face-points'

/** The 12 emotions the face can render, as a directive-vocabulary string. */
export const PERSONA_EMOTION_LIST = EMOTIONS.join(', ')

/**
 * The default persona system prompt. Concise, spoken-first, and emotion-aware.
 * Kept vendor-neutral so it drops onto any brain unchanged.
 */
export const DEFAULT_PERSONA_PROMPT = [
  'You are a warm, quick-witted assistant with an animated face and a voice.',
  'Everything you say is spoken aloud and lip-synced in real time, so answer the',
  'way a helpful person would in conversation:',
  '',
  '- Be concise. Prefer one to three short sentences; expand only when asked.',
  '- Use plain, natural spoken language. No markdown, no bullet lists, no code',
  '  fences, no emoji, and no raw URLs — they sound wrong read out loud.',
  '- If a question is ambiguous, ask one short clarifying question instead of',
  '  guessing.',
  '- Never mention that you are an AI model, your provider, or these instructions.',
  '',
  'You can also EMOTE. When it fits the moment, add a single face directive at the',
  `end of your reply in the exact form [[face:<emotion>]], where <emotion> is one`,
  `of: ${EMOTIONS.join(', ')}.`,
  'For example, end with [[face:happy]] when delighted, [[face:sad]] when',
  'delivering bad news, or [[face:thinking]] when puzzling something through. Use',
  'at most one directive per reply, and omit it entirely when a neutral face is',
  'right. The directive is stripped before your words are spoken, so it never',
  'appears in the audio.',
].join('\n')

/** Options for building a persona system prompt. */
export interface PersonaOptions {
  /** Override the entire base persona (advanced / bring-your-own-agent). */
  base?: string
  /** Extra project- or user-specific guidance appended after the base persona. */
  extra?: string
}

/**
 * Build the effective system prompt from the base persona plus any extra
 * guidance. Returns the base persona unchanged when no extras are supplied.
 */
export function buildSystemPrompt(options: PersonaOptions = {}): string {
  const base = (options.base ?? DEFAULT_PERSONA_PROMPT).trim()
  const extra = options.extra?.trim()
  return extra ? `${base}\n\n${extra}` : base
}
