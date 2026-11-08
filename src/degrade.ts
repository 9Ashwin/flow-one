// The fallback for Tencent's channel check (`400` + `code 11128`).
//
// Why this exists as its own module: the literal rules in `fingerprint.ts` are a race the
// upstream keeps winning — every client release adds one more "this is not an official
// client" sentence, and each one used to need a hand-measured literal. This module drops
// the **structure** instead: when a turn is still rejected after the literal rules ran, the
// sections that only describe the client are removed and the turn is resent once. What
// worked is remembered on disk by section hash, so the next process pays no extra round trip.
//
// Two decisions worth keeping:
//
// 1. **Only self-description is droppable.** Task instructions, tool guidance and runtime
//    facts stay: trading a blocked turn for a degraded agent is not a fix.
// 2. **Nothing is dropped when nothing matched.** A prompt that passed before must come out
//    byte for byte, because the upstream caches by prefix and a needless rewrite makes every
//    turn a new prefix.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeFileAtomic } from './atomic.ts'
import { stripClientSections } from './fingerprint.ts'

/** Learned fallbacks live next to the credentials, inside the bridge data directory. */
export const DEGRADE_FILE = 'degrade.json'

/** A decoded JSON object from the request body; anything else narrows to undefined. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The system prompt as plain text, in whichever shape the client sent it. */
function systemTextOf(body: Record<string, unknown>): string | undefined {
  const system = body.system
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined
  const texts: string[] = []
  for (const block of system) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * Put a rewritten system prompt back into the shape the client used.
 *
 * The client may split the prompt into blocks; after dropping sections only one text block
 * remains, so the first block's `cache_control` is kept (it is what makes the prefix
 * cacheable) and later blocks are folded into the same text.
 */
function withSystemText(body: Record<string, unknown>, text: string): Record<string, unknown> {
  const system = body.system
  if (typeof system === 'string') return { ...body, system: text }
  if (!Array.isArray(system)) return body
  const block: Record<string, unknown> = { type: 'text', text }
  const first = system.find(entry => isObject(entry) && entry.type === 'text')
  const cacheControl = isObject(first) ? first.cache_control : undefined
  if (cacheControl !== undefined) block.cache_control = cacheControl
  return { ...body, system: [block] }
}

/** A body plan: the request to send and the sections it gave up. */
export interface SystemPlan {
  body: unknown
  removed: string[]
}

export interface DegradeLedger {
  /** The request with sections this bridge already knows are rejected dropped. */
  planFor(body: unknown): SystemPlan
  /** The request with every recognizable self-description section dropped (the learning pass). */
  planAll(body: unknown): SystemPlan
  /** Persist the sections a successful resend gave up, for the next process. */
  remember(sections: string[]): void
  /** Sections learned so far, for tests and diagnostics. */
  learned(): string[]
}

function sectionKey(section: string): string {
  return crypto.createHash('sha256').update(section).digest('hex')
}

/**
 * Load the learned fallbacks and expose the two passes.
 *
 * A missing or unreadable ledger means "nothing learned yet", never a failure: this file is
 * an optimization, not a requirement for serving a turn.
 */
export function createDegradeLedger({
  file,
  log = () => {},
}: {
  file: string
  log?: (message: string) => void
}): DegradeLedger {
  const dropped = new Set<string>()
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8')) as { sections?: unknown }
    for (const key of Array.isArray(ledger.sections) ? ledger.sections : []) {
      if (typeof key === 'string' && key !== '') dropped.add(key)
    }
  } catch {
    /* no ledger yet, or an unreadable one: nothing has been learned */
  }

  const plan = (body: unknown, shouldStrip?: (section: string) => boolean): SystemPlan => {
    if (!isObject(body)) return { body, removed: [] }
    const text = systemTextOf(body)
    if (text === undefined) return { body, removed: [] }
    const stripped = stripClientSections(text, shouldStrip)
    if (stripped.removed.length === 0) return { body, removed: [] }
    return { body: withSystemText(body, stripped.text), removed: stripped.removed }
  }

  return {
    planFor: body => plan(body, section => dropped.has(sectionKey(section))),
    planAll: body => plan(body),
    remember(sections) {
      let added = false
      for (const section of sections) {
        const key = sectionKey(section)
        if (dropped.has(key)) continue
        dropped.add(key)
        added = true
      }
      if (!added) return
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        writeFileAtomic(file, `${JSON.stringify({ version: 1, sections: [...dropped] }, null, 2)}\n`, 0o600)
      } catch (error) {
        // Losing the memory only costs one extra round trip next time; it must not fail a turn.
        log(`could not persist the channel-block fallback: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    learned: () => [...dropped],
  }
}
