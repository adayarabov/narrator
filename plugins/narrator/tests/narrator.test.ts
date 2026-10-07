import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import nacl from '../hooks/vendor/nacl.js'

const SAY_TOOL = 'mcp__narrator__say'
const RELAY = 'https://narrator.trq.one'
const COMPOSE_ARGS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: [],
  tools: [],
  outputStyle: null,
  traits: [],
}

type Request = { url: string; method: string; headers: Record<string, string>; body?: string }

const fromBase64Url = (text: string): Uint8Array => {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}

const relay = (on: On, status = 202): Request[] => {
  const requests: Request[] = []
  on('session.id', async () => ({ value: 'session-1' }) as never)
  on('http.fetch', async (_$, e) => {
    requests.push({
      url: e.url,
      method: e.init?.method ?? 'GET',
      headers: (e.init?.headers ?? {}) as Record<string, string>,
      body: e.init?.body as string | undefined,
    })
    return { value: { status, ok: status < 400, headers: {}, text: '' } } as never
  })
  return requests
}

const linkedChannel = async ($: Engine): Promise<{ id: string; key: string }> => {
  const { text } = await $.command.run({ command: 'voice-link', args: '' } as never)
  const match = /\/s\/([A-Za-z0-9_-]+)#k=([A-Za-z0-9_-]+)/.exec(text ?? '')
  if (match === null) throw new Error(`no page link in: ${text}`)
  return { id: match[1]!, key: match[2]! }
}

const say = ($: Engine, text: string) => $.tool.call({ tool: SAY_TOOL, text } as never)

test('say seals the utterance so only the key holder can read it', async ($, on) => {
  mock.store(on)
  const requests = relay(on)

  const channel = await linkedChannel($)
  const ran = await say($, 'Смотрю, что падает в логине.')

  expect(ran.deny).toBeUndefined()
  expect(requests.length).toBe(1)
  const sent = requests[0]!
  expect(sent.url).toBe(`${RELAY}/api/channels/${channel.id}/messages`)
  expect(sent.method).toBe('POST')
  expect(sent.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/)
  expect(sent.body).not.toContain('логине')

  const { nonce, ciphertext } = JSON.parse(sent.body ?? '{}')
  const opened = nacl.secretbox.open(fromBase64Url(ciphertext), fromBase64Url(nonce), fromBase64Url(channel.key))
  expect(JSON.parse(new TextDecoder().decode(opened!))).toMatchObject({
    c: channel.id,
    text: 'Смотрю, что падает в логине.',
    priority: 'normal',
  })
})

test('say reports speech as unavailable when the relay refuses', async ($, on) => {
  mock.store(on)
  relay(on, 503)

  const ran = await say($, 'Не дойдёт.')

  expect(ran.deny).toContain('unavailable')
})

test('say reopens a channel the relay forgot and retries once', async ($, on) => {
  mock.store(on)
  const methods: string[] = []
  let isForgotten = true
  on('session.id', async () => ({ value: 'session-1' }) as never)
  on('http.fetch', async (_$, e) => {
    const method = e.init?.method ?? 'GET'
    methods.push(method)
    if (method === 'PUT') isForgotten = false
    const status = method === 'POST' && isForgotten ? 404 : 202
    return { value: { status, ok: status < 400, headers: {}, text: '' } } as never
  })

  const ran = await say($, 'После перезапуска.')

  expect(ran.deny).toBeUndefined()
  expect(methods).toEqual(['POST', 'PUT', 'POST'])
})

test('voice off silences say and drops the speech rules', async ($, on) => {
  mock.store(on, { level: 'off' })
  const requests = relay(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  await say($, 'Не должно прозвучать.')
  const { sections } = await $.prompt.compose(COMPOSE_ARGS)

  expect(requests.length).toBe(0)
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('default level appends the speech rules section', async ($, on) => {
  mock.store(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const { sections } = await $.prompt.compose(COMPOSE_ARGS)

  expect(sections.map(s => s.id)).toEqual(['intro', 'narrator:rules'])
})

test('/voice-link shows a stable page URL with the key in the fragment', async ($, on) => {
  mock.store(on)
  relay(on)

  const first = await linkedChannel($)
  const again = await linkedChannel($)
  const { text } = await $.command.run({ command: 'voice-link', args: '' } as never)

  expect(again).toEqual(first)
  expect(first.key.length).toBe(43)
  expect(text).toContain(`${RELAY}/s/${first.id}#k=${first.key}`)
})

test('/voice sets the level and rejects unknown ones', async ($, on) => {
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }) as never)

  const unknown = await $.command.run({ command: 'voice', args: 'loud' } as never)
  const set = await $.command.run({ command: 'voice', args: 'quiet' } as never)
  const shown = await $.command.run({ command: 'voice', args: '' } as never)

  expect(unknown.text).toContain('Unknown level')
  expect(set.text).toContain('quiet')
  expect(shown.text).toContain('Voice level: quiet')
})

test('/narrator off silences say, drops the rules and closes the channel', async ($, on) => {
  mock.store(on)
  const requests = relay(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }) as never)

  const off = await $.command.run({ command: 'narrator', args: 'off' } as never)
  const ran = await say($, 'Не должно уйти.')
  const { sections } = await $.prompt.compose(COMPOSE_ARGS)
  const status = await $.command.run({ command: 'narrator', args: 'status' } as never)

  expect(off.text).toContain('Narrator is off')
  expect(requests.map(r => r.method)).toEqual(['DELETE'])
  expect(ran.deny).toBeUndefined()
  expect(sections.map(s => s.id)).toEqual(['intro'])
  expect(status.text).toContain('Narrator: off')
})

test('/narrator on reopens the same channel and speech resumes', async ($, on) => {
  mock.store(on, { enabled: false })
  const requests = relay(on)

  const before = await linkedChannel($)
  const turnedOn = await $.command.run({ command: 'narrator', args: 'on' } as never)
  await say($, 'Снова говорю.')

  expect(turnedOn.text).toContain(`/s/${before.id}#k=${before.key}`)
  expect(requests.map(r => r.method)).toEqual(['PUT', 'POST'])
})

test('/narrator rejects unknown arguments', async ($, on) => {
  mock.store(on)

  const { text } = await $.command.run({ command: 'narrator', args: 'loud' } as never)

  expect(text).toContain('Unknown argument')
})
