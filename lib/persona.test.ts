import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PERSONA_PROMPT,
  PERSONA_EMOTION_LIST,
  buildSystemPrompt,
} from '@/lib/persona'
import { EMOTIONS } from '@/lib/face-points'

describe('persona', () => {
  it('is a non-empty, spoken-first, emotion-aware prompt', () => {
    expect(DEFAULT_PERSONA_PROMPT.length).toBeGreaterThan(50)
    // Speaks its guidance: concise + no markdown.
    expect(DEFAULT_PERSONA_PROMPT.toLowerCase()).toContain('concise')
    // Teaches the exact directive form.
    expect(DEFAULT_PERSONA_PROMPT).toContain('[[face:<emotion>]]')
    // Lists every one of the 12 emotions so the model has the full vocabulary.
    for (const e of EMOTIONS) {
      expect(DEFAULT_PERSONA_PROMPT).toContain(e)
    }
  })

  it('is vendor-neutral (no Hermes/Claude/Anthropic/OpenAI wording)', () => {
    expect(DEFAULT_PERSONA_PROMPT).not.toMatch(/hermes|claude|anthropic|openai|gpt/i)
  })

  it('teaches acknowledge-first for tool/multi-step work (no silent gaps in speech)', () => {
    // A tool-using brain (agent bridge) can work for many seconds before its
    // first token. The persona must ask for a short spoken acknowledgment
    // BEFORE the work starts, so the face is never silently "stuck" (live
    // finding, 2026-07-19: it built the HTML fine but said nothing until done).
    expect(DEFAULT_PERSONA_PROMPT.toLowerCase()).toContain('acknowledg')
    expect(DEFAULT_PERSONA_PROMPT.toLowerCase()).toMatch(/then do the work/i)
  })

  it('exposes the emotion vocabulary as a joined list', () => {
    expect(PERSONA_EMOTION_LIST).toBe(EMOTIONS.join(', '))
  })

  it('buildSystemPrompt appends extra guidance and honors a base override', () => {
    expect(buildSystemPrompt()).toBe(DEFAULT_PERSONA_PROMPT)
    expect(buildSystemPrompt({ extra: 'You are a pirate.' })).toBe(
      `${DEFAULT_PERSONA_PROMPT}\n\nYou are a pirate.`,
    )
    expect(buildSystemPrompt({ base: 'Base only.' })).toBe('Base only.')
  })
})
