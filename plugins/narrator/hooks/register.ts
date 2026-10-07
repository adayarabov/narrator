import type { EngineInterface, Register } from 'claude-code'

import {
  authHeaders,
  channelUrl,
  createCredentials,
  isCredentials,
  openSealed,
  pageUrl,
  sealMessage,
  type ChannelCredentials,
  type OutboundMessage,
  type Priority,
} from './channel'
import {
  addUsage,
  buildForkPrompt,
  describeUsage,
  emptyState,
  emptyUsage,
  isForkUsage,
  isSideChatState,
  noteForMainThread,
  parseForkReply,
  parseInbound,
  remember,
  type Inbound,
  type SideChatState,
} from './sidechat'

type Level = 'off' | 'quiet' | 'normal' | 'chatty'

const LEVELS: readonly Level[] = ['off', 'quiet', 'normal', 'chatty']
const DEFAULT_LEVEL: Level = 'normal'
const LEVEL_KEY = 'level'
const MAX_UTTERANCE = 400
const SAY_TOOL = 'mcp__narrator__say'
const DEFAULT_SERVICE_URL = 'https://narrator.trq.one'
const INBOX_POLL_MS = 1500
const STOP_QUESTION = 'Прервать текущую задачу?'

// The running turn's id, for a confirmed stop; a reload happens between turns, so it is not lost mid-turn.
let runningTurnId: string | undefined
let isPolling = false
let pollTimer: { cancel: () => void } | undefined

// Turned on and off with /narrator; kept across sessions.
const ENABLED_KEY = 'enabled'

const isEnabled = async ($: EngineInterface): Promise<boolean> => (await $.store.get(ENABLED_KEY)) !== false

const SPOKEN_NOTIFICATIONS: Record<string, string> = {
  permission_prompt: 'Мне нужно твоё разрешение.',
  elicitation_dialog: 'У меня к тебе вопрос.',
}

const BASE_RULES = `# Speaking aloud

The developer listens to you through a voice channel while you work, like a colleague on a call.
Call the \`${SAY_TOOL}\` tool to say something aloud. It returns at once; keep working.

How to speak:
- In the language the developer writes in, first person, conversational, one or two short sentences.
- Never read out code, file paths, line numbers, commands, or long identifiers: say what they mean.
- Speech is a side channel. Your written answer stays as complete as it would be without it.`

const LEVEL_RULES: Record<Exclude<Level, 'off'>, string> = {
  quiet: `When to speak: only to say you are blocked or need a decision, and once at the end with the outcome in a sentence. Nothing else.`,
  normal: `When to speak:
- At the start: the plan in one sentence.
- When a hypothesis changes, something surprising turns up, or you find the cause.
- At a real fork where you pick one way over another, and why.
- At the end: the outcome in one or two sentences.
Stay silent for routine reads, searches, and commands, and when nothing has changed since you last spoke. Several minutes of silence during routine work is fine.`,
  chatty: `When to speak: think aloud. Say what you are looking at and why, what you expect, what you just learned, and the outcome at the end. Still skip trivial steps and never repeat yourself.`,
}

const isLevel = (value: unknown): value is Level =>
  typeof value === 'string' && (LEVELS as readonly string[]).includes(value)

const readLevel = async ($: EngineInterface): Promise<Level> => {
  const stored = await $.store.get(LEVEL_KEY)
  return isLevel(stored) ? stored : DEFAULT_LEVEL
}

const channelStoreKey = async ($: EngineInterface): Promise<string> => `channel:${await $.session.id()}`

const loadChannel = async ($: EngineInterface): Promise<ChannelCredentials> => {
  const key = await channelStoreKey($)
  const stored = await $.store.get(key)
  if (isCredentials(stored)) return stored

  const created = createCredentials()
  await $.store.set(key, created)
  return created
}

const openChannel = async ($: EngineInterface, serviceUrl: string, channel: ChannelCredentials) => {
  const response = await $.http.fetch(channelUrl(serviceUrl, channel), { method: 'PUT', headers: authHeaders(channel) })
  if (!response.ok) throw new Error(`narrator relay refused to open the channel: HTTP ${response.status}`)
}

// Closes the relay channel but keeps its key, so turning narrator back on reuses the same page link.
const releaseChannel = async ($: EngineInterface, serviceUrl: string) => {
  const channel = await loadChannel($)
  await $.http.fetch(channelUrl(serviceUrl, channel), { method: 'DELETE', headers: authHeaders(channel) })
}

const closeChannel = async ($: EngineInterface, serviceUrl: string) => {
  await releaseChannel($, serviceUrl)
  await $.store.delete(await channelStoreKey($))
}

const publish = async ($: EngineInterface, serviceUrl: string, message: OutboundMessage) => {
  const channel = await loadChannel($)
  const post = () =>
    $.http.fetch(channelUrl(serviceUrl, channel, '/messages'), {
      method: 'POST',
      headers: authHeaders(channel),
      body: JSON.stringify(sealMessage(channel, message, Date.now())),
    })
  let response = await post()
  if (response.status === 404) {
    // The relay keeps channels in memory; after its restart the channel is reopened under the same key.
    await openChannel($, serviceUrl, channel)
    response = await post()
  }
  if (!response.ok) throw new Error(`narrator relay refused the message: HTTP ${response.status}`)
}

const enqueue = async ($: EngineInterface, serviceUrl: string, text: string, priority: Priority) => {
  const utterance = text.trim().slice(0, MAX_UTTERANCE)
  if (utterance === '' || !(await isEnabled($)) || (await readLevel($)) === 'off') return

  await publish($, serviceUrl, { text: utterance, priority, kind: 'narration' })
}

const sideChatKey = async ($: EngineInterface): Promise<string> => `sidechat:${await $.session.id()}`

const loadSideChat = async ($: EngineInterface): Promise<SideChatState> => {
  const stored = await $.store.get(await sideChatKey($))
  return isSideChatState(stored) ? stored : emptyState()
}

const saveSideChat = async ($: EngineInterface, state: SideChatState) => {
  await $.store.set(await sideChatKey($), state)
}

const usageKey = async ($: EngineInterface): Promise<string> => `usage:${await $.session.id()}`

const recordForkUsage = async ($: EngineInterface, usage: Record<string, unknown> | undefined) => {
  const key = await usageKey($)
  const stored = await $.store.get(key)
  await $.store.set(key, addUsage(isForkUsage(stored) ? stored : emptyUsage(), usage))
}

// An instruction reaches the main thread before its next step, or starts a turn when idle.
const deliverNote = async ($: EngineInterface, note: string) => {
  const text = noteForMainThread(note)
  if (runningTurnId === undefined) {
    void $.prompt.submit({ text })
    return
  }
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

const answer = async (
  $: EngineInterface,
  serviceUrl: string,
  state: SideChatState,
  message: Extract<Inbound, { kind: 'say' }>,
): Promise<SideChatState> => {
  await publish($, serviceUrl, { text: message.text, priority: 'normal', kind: 'heard', ref: message.id })
  const forked = await $.model.fork({ prompt: buildForkPrompt(state.history, message.text) })
  if ('usage' in forked) await recordForkUsage($, forked.usage as Record<string, unknown> | undefined)
  if (!forked.isAnswered) {
    const reply = `Не смог ответить: ${forked.reason}.`
    await publish($, serviceUrl, { text: reply, priority: 'normal', kind: 'reply', ref: message.id })
    return state
  }

  const decision = parseForkReply(forked.text)
  const history = remember(state.history, { role: 'developer', text: message.text }, { role: 'assistant', text: decision.reply })
  if (decision.action === 'stop') {
    const text = `${decision.reply} ${STOP_QUESTION}`.trim()
    await publish($, serviceUrl, { text, priority: 'urgent', kind: 'confirm', ref: message.id })
    return { ...state, history, pendingStops: { ...state.pendingStops, [message.id]: decision.note } }
  }
  if (decision.action === 'note') await deliverNote($, decision.note)
  await publish($, serviceUrl, { text: decision.reply, priority: 'normal', kind: 'reply', ref: message.id })
  return { ...state, history }
}

const confirmStop = async (
  $: EngineInterface,
  serviceUrl: string,
  state: SideChatState,
  message: Extract<Inbound, { kind: 'confirm' }>,
): Promise<SideChatState> => {
  const note = state.pendingStops[message.ref]
  if (note === undefined) return state
  const { [message.ref]: _, ...pendingStops } = state.pendingStops
  if (!message.isConfirmed) {
    await publish($, serviceUrl, { text: 'Хорошо, продолжаю.', priority: 'normal', kind: 'reply', ref: message.ref })
    return { ...state, pendingStops }
  }
  if (runningTurnId !== undefined) await $.turn.abort({ turnId: runningTurnId })
  void $.prompt.submit({ text: noteForMainThread(note) })
  await publish($, serviceUrl, { text: 'Прервал, переключаюсь.', priority: 'urgent', kind: 'reply', ref: message.ref })
  return { ...state, pendingStops }
}

const pollInbox = async ($: EngineInterface, serviceUrl: string) => {
  const channel = await loadChannel($)
  let state = await loadSideChat($)
  const response = await $.http.fetch(channelUrl(serviceUrl, channel, `/inbox?after=${state.after}`), {
    headers: authHeaders(channel),
  })
  if (response.status === 404) {
    await openChannel($, serviceUrl, channel)
    return
  }
  if (!response.ok) return

  const items = (JSON.parse(response.text) as { items?: { seq: number; nonce: string; ciphertext: string }[] }).items ?? []
  for (const item of items) {
    state = { ...state, after: Math.max(state.after, item.seq) }
    const message = parseInbound(openSealed(channel, item.nonce, item.ciphertext), Date.now())
    if (message === null) continue
    state = message.kind === 'say'
      ? await answer($, serviceUrl, state, message)
      : await confirmStop($, serviceUrl, state, message)
    await saveSideChat($, state)
  }
  await saveSideChat($, state)
}

// Opens the channel, shows the page link and starts reading the side chat.
const startNarrator = async ($: EngineInterface, serviceUrl: string): Promise<string> => {
  const channel = await loadChannel($)
  await openChannel($, serviceUrl, channel)
  pollTimer ??= $.clock.every(INBOX_POLL_MS, async () => {
    if (isPolling) return
    isPolling = true
    try {
      await pollInbox($, serviceUrl)
    } catch (error) {
      $.ui.log(`narrator side chat: ${String(error)}`)
    } finally {
      isPolling = false
    }
  })
  return pageUrl(serviceUrl, channel)
}

const stopNarrator = async ($: EngineInterface, serviceUrl: string) => {
  pollTimer?.cancel()
  pollTimer = undefined
  await releaseChannel($, serviceUrl)
}

export const register: Register = (on, options) => {
  const configured = options.serviceUrl
  const serviceUrl = (typeof configured === 'string' && configured !== '' ? configured : DEFAULT_SERVICE_URL).replace(/\/+$/, '')

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'say',
      description:
        'Say one or two short conversational sentences aloud to the developer, who listens while you work. ' +
        'Returns immediately. Follow the "Speaking aloud" rules for when to use it.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'What to say: plain speech, no code or paths.' } },
        required: ['text'],
      },
    })
    // One command for everything: Claude Code has a built-in /voice, and a refused
    // registration must not stop the channel from opening.
    try {
      await $.command.register({
        name: 'narrator',
        description: 'Narrator: on, off, status, link, usage, or level off|quiet|normal|chatty',
        argumentHint: '[on|off|status|link|usage|level <off|quiet|normal|chatty>]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`narrator: /narrator is unavailable: ${String(error)}`)
    }
    if (await isEnabled($)) {
      try {
        $.ui.toast(`Narrator: ${await startNarrator($, serviceUrl)}`)
      } catch (error) {
        $.ui.toast(`Narrator relay is unreachable, speech is off: ${String(error)}`)
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    runningTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    runningTurnId = undefined
    return next(e)
  })

  on('command.run', { command: 'narrator' }, async ($, e) => {
    const [action = 'status', argument = ''] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (action === 'on') {
      await $.store.set(ENABLED_KEY, true)
      try {
        const link = await startNarrator($, serviceUrl)
        return { text: `Narrator is on: speech, side chat and the page channel.\nPage: ${link}` }
      } catch (error) {
        return { text: `Narrator is on, but the relay is unreachable: ${String(error)}` }
      }
    }
    if (action === 'off') {
      await $.store.set(ENABLED_KEY, false)
      await stopNarrator($, serviceUrl).catch(() => undefined)
      return { text: 'Narrator is off: no speech, the side chat is not read and the page channel is closed. /narrator on brings it back with the same link.' }
    }
    if (action === 'link') {
      return { text: `Open this page to hear the session (the key after # never reaches the server):\n${pageUrl(serviceUrl, await loadChannel($))}` }
    }
    if (action === 'usage') {
      const stored = await $.store.get(await usageKey($))
      return { text: describeUsage(isForkUsage(stored) ? stored : emptyUsage(), await $.session.model()) }
    }
    if (action === 'level') {
      if (argument === '') return { text: `Voice level: ${await readLevel($)}. Options: ${LEVELS.join(', ')}.` }
      if (!isLevel(argument)) return { text: `Unknown level "${argument}". Options: ${LEVELS.join(', ')}.` }
      await $.store.set(LEVEL_KEY, argument)
      return { text: `Voice level set to ${argument}; it applies from the next request.` }
    }
    if (action !== 'status') {
      return { text: `Unknown argument "${action}". Use /narrator on, off, status, link, usage or level <off|quiet|normal|chatty>.` }
    }

    const usage = await $.store.get(await usageKey($))
    const lines = [
      `Narrator: ${(await isEnabled($)) ? 'on' : 'off'}`,
      `Voice level: ${await readLevel($)}`,
      `Side chat: ${pollTimer === undefined ? 'not read' : 'read every 1.5 s'}`,
      `Relay: ${serviceUrl}`,
      `Page: ${pageUrl(serviceUrl, await loadChannel($))}`,
      describeUsage(isForkUsage(usage) ? usage : emptyUsage(), await $.session.model()),
    ]
    return { text: lines.join('\n') }
  })

  on('session.end', async ($, e, next) => {
    await closeChannel($, serviceUrl)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: SAY_TOOL }, async ($, e) => {
    const input = e as { text?: unknown }
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim() === '') return { deny: 'Nothing to say: pass non-empty text.' }
    if (!(await isEnabled($))) return { result: 'Narrator is off; nothing was spoken. Continue without speaking.' }

    await enqueue($, serviceUrl, text, 'normal')
    return { result: 'Queued for speech.' }
  }).catch(() => ({ deny: 'Speech is unavailable right now; continue without it.' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const level = await readLevel($)
    if (level === 'off' || !(await isEnabled($))) return composed

    const section = { id: 'narrator:rules', text: `${BASE_RULES}\n\n${LEVEL_RULES[level]}`, scope: 'session' } as const
    return { sections: [...composed.sections, section] }
  })

  on('classic.Notification', async ($, e, next) => {
    const phrase = SPOKEN_NOTIFICATIONS[e.notification_type]
    if (phrase !== undefined) await enqueue($, serviceUrl, phrase, 'urgent')
    return next(e)
  }).catch(($, e, next) => next(e))
}
