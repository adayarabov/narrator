// Side chat: the developer talks to a fork of the session while the main thread
// keeps working. Pure logic only; the hooks module does every call through $.

export type ChatTurn = { role: 'developer' | 'assistant'; text: string }

export type SideChatState = {
  after: number
  history: ChatTurn[]
  pendingStops: Record<string, string>
}

export type Inbound =
  | { kind: 'say'; id: string; text: string; ts: number }
  | { kind: 'confirm'; id: string; ref: string; isConfirmed: boolean; ts: number }

export type ForkDecision = {
  reply: string
  action: 'none' | 'note' | 'stop'
  note: string
}

const HISTORY_LIMIT = 12
const MAX_AGE_MS = 10 * 60 * 1000
const MAX_TEXT = 2000

export const emptyState = (): SideChatState => ({ after: 0, history: [], pendingStops: {} })

export const isSideChatState = (value: unknown): value is SideChatState => {
  if (typeof value !== 'object' || value === null) return false
  const { after, history, pendingStops } = value as Record<string, unknown>
  return typeof after === 'number' && Array.isArray(history) && typeof pendingStops === 'object' && pendingStops !== null
}

// Accepts only well-formed, recent messages; the relay's numbering plus `after`
// already keeps a message from being handled twice.
export const parseInbound = (message: unknown, now: number): Inbound | null => {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  if (typeof m.id !== 'string' || typeof m.ts !== 'number' || now - m.ts > MAX_AGE_MS) return null
  if (m.kind === 'say' && typeof m.text === 'string' && m.text.trim() !== '') {
    return { kind: 'say', id: m.id, text: m.text.trim().slice(0, MAX_TEXT), ts: m.ts }
  }
  if (m.kind === 'confirm' && typeof m.ref === 'string' && typeof m.ok === 'boolean') {
    return { kind: 'confirm', id: m.id, ref: m.ref, isConfirmed: m.ok, ts: m.ts }
  }
  return null
}

export const remember = (history: readonly ChatTurn[], ...turns: ChatTurn[]): ChatTurn[] =>
  [...history, ...turns].slice(-HISTORY_LIMIT)

export const buildForkPrompt = (history: readonly ChatTurn[], text: string): string => {
  const transcript = history.length === 0
    ? '(this is the first message)'
    : history.map(turn => `${turn.role === 'developer' ? 'Developer' : 'You'}: ${turn.text}`).join('\n')

  return `[Side chat - this is not a new task]
The developer is talking to you in a side chat, by voice, while your main thread keeps working on the current task. You are a fork of that main thread: you see everything it has done so far, but you cannot use tools, and nothing you say here reaches it except through "action" below.

Side chat so far:
${transcript}

The developer now says:
<message>${text}</message>

Answer with one JSON object and nothing else:
{"reply": "...", "action": "none" | "note" | "stop", "note": "..."}

- "reply": what you say back aloud: one to three short conversational sentences in the developer's language, no code, paths or commands.
- "action": "note" when the developer asks the main thread to do, avoid or change something in the ongoing work; "stop" only when they want the current work halted right now; otherwise "none".
- "note": for "note" and "stop", the instruction for the main thread, faithful to the developer's words; otherwise "".`
}

const extractJson = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

// A reply that is not the requested JSON is still spoken, with no action taken.
export const parseForkReply = (text: string): ForkDecision => {
  const parsed = extractJson(text)
  if (typeof parsed !== 'object' || parsed === null) return { reply: text.trim(), action: 'none', note: '' }
  const { reply, action, note } = parsed as Record<string, unknown>
  const safeAction = action === 'note' || action === 'stop' ? action : 'none'
  const safeNote = typeof note === 'string' ? note.trim() : ''
  return {
    reply: typeof reply === 'string' ? reply.trim() : '',
    action: safeAction !== 'none' && safeNote === '' ? 'none' : safeAction,
    note: safeNote,
  }
}

export const noteForMainThread = (note: string): string =>
  `[Side chat] While you were working, the developer said in the side chat: "${note}". ` +
  'Take it into account from your next step; do not reply in the side chat.'

export type ForkUsage = {
  forks: number
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

export const emptyUsage = (): ForkUsage => ({
  forks: 0,
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
})

export const isForkUsage = (value: unknown): value is ForkUsage =>
  typeof value === 'object' && value !== null && typeof (value as { forks?: unknown }).forks === 'number'

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export const addUsage = (total: ForkUsage, usage: Record<string, unknown> | undefined): ForkUsage => ({
  forks: total.forks + 1,
  input_tokens: total.input_tokens + count(usage?.input_tokens),
  cache_creation_input_tokens: total.cache_creation_input_tokens + count(usage?.cache_creation_input_tokens),
  cache_read_input_tokens: total.cache_read_input_tokens + count(usage?.cache_read_input_tokens),
  output_tokens: total.output_tokens + count(usage?.output_tokens),
})

// USD per million tokens. Claude Code writes its cache with the 1-hour TTL (2x input).
const PRICES: Record<string, { input: number; cacheWrite: number; cacheRead: number; output: number }> = {
  'claude-opus-5-5': { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 },
}

export const usageCost = (usage: ForkUsage, model: string): number | undefined => {
  const price = Object.entries(PRICES).find(([id]) => model.startsWith(id))?.[1]
  if (price === undefined) return undefined
  return (
    (usage.input_tokens * price.input +
      usage.cache_creation_input_tokens * price.cacheWrite +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  )
}

export const describeUsage = (usage: ForkUsage, model: string): string => {
  const cost = usageCost(usage, model)
  const lines = [
    `Side chat forks: ${usage.forks}`,
    `  input (uncached): ${usage.input_tokens.toLocaleString('en-US')}`,
    `  cache write:      ${usage.cache_creation_input_tokens.toLocaleString('en-US')}`,
    `  cache read:       ${usage.cache_read_input_tokens.toLocaleString('en-US')}`,
    `  output:           ${usage.output_tokens.toLocaleString('en-US')}`,
    cost === undefined ? `  cost: no price table for ${model}` : `  cost: $${cost.toFixed(2)} (${model})`,
  ]
  return lines.join('\n')
}
