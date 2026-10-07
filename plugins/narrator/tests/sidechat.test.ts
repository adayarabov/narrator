import { describe, expect, test } from 'claude-code/testing'

import { createCredentials, openSealed, sealMessage } from '../hooks/channel'
import { addUsage, buildForkPrompt, emptyUsage, parseForkReply, parseInbound, remember, usageCost } from '../hooks/sidechat'

const NOW = 1_800_000_000_000

describe('parseInbound', () => {
  test('accepts a recent spoken message', () => {
    const parsed = parseInbound({ kind: 'say', id: 'a1', text: '  сколько ещё?  ', ts: NOW - 1000 }, NOW)

    expect(parsed).toEqual({ kind: 'say', id: 'a1', text: 'сколько ещё?', ts: NOW - 1000 })
  })

  test('rejects stale, empty and malformed messages', () => {
    expect(parseInbound({ kind: 'say', id: 'a', text: 'hi', ts: NOW - 11 * 60 * 1000 }, NOW)).toBeNull()
    expect(parseInbound({ kind: 'say', id: 'a', text: '   ', ts: NOW }, NOW)).toBeNull()
    expect(parseInbound({ kind: 'run', id: 'a', text: 'rm -rf', ts: NOW }, NOW)).toBeNull()
    expect(parseInbound('say hi', NOW)).toBeNull()
  })

  test('reads a stop confirmation', () => {
    const parsed = parseInbound({ kind: 'confirm', id: 'b', ref: 'a1', ok: true, ts: NOW }, NOW)

    expect(parsed).toEqual({ kind: 'confirm', id: 'b', ref: 'a1', isConfirmed: true, ts: NOW })
  })
})

describe('parseForkReply', () => {
  test('reads the requested JSON even with text around it', () => {
    const decision = parseForkReply('Sure: {"reply": "Понял.", "action": "note", "note": "прогнать линтер"} done')

    expect(decision).toEqual({ reply: 'Понял.', action: 'note', note: 'прогнать линтер' })
  })

  test('falls back to speaking plain text with no action', () => {
    expect(parseForkReply('Ещё минуты две.')).toEqual({ reply: 'Ещё минуты две.', action: 'none', note: '' })
  })

  test('drops an action that carries no instruction', () => {
    expect(parseForkReply('{"reply": "Ок", "action": "stop", "note": ""}').action).toBe('none')
  })

  test('treats an unknown action as none', () => {
    expect(parseForkReply('{"reply": "Ок", "action": "deploy", "note": "x"}').action).toBe('none')
  })
})

test('the fork prompt carries the side chat history and the new message', () => {
  const history = remember([], { role: 'developer', text: 'что делаешь?' }, { role: 'assistant', text: 'Гоняю тесты.' })

  const prompt = buildForkPrompt(history, 'а линтер?')

  expect(prompt).toContain('Developer: что делаешь?')
  expect(prompt).toContain('You: Гоняю тесты.')
  expect(prompt).toContain('<message>а линтер?</message>')
})

test('history keeps only the most recent turns', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: 'developer' as const, text: `m${i}` }))

  const kept = remember([], ...turns)

  expect(kept.length).toBe(12)
  expect(kept[0]?.text).toBe('m8')
})

describe('openSealed', () => {
  test('opens what the channel key sealed', () => {
    const channel = createCredentials()
    const sealed = sealMessage(channel, { text: 'привет', priority: 'normal', kind: 'reply' }, NOW)

    expect(openSealed(channel, sealed.nonce, sealed.ciphertext)).toMatchObject({ c: channel.id, text: 'привет' })
  })

  test('rejects another channel key and garbage', () => {
    const channel = createCredentials()
    const sealed = sealMessage(createCredentials(), { text: 'чужое', priority: 'normal', kind: 'reply' }, NOW)

    expect(openSealed(channel, sealed.nonce, sealed.ciphertext)).toBeNull()
    expect(openSealed(channel, 'AAAA', 'not-base64!')).toBeNull()
  })
})

describe('fork usage', () => {
  test('adds each fork and prices it at Opus 5.5 rates', () => {
    const usage = addUsage(addUsage(emptyUsage(), { cache_read_input_tokens: 1_000_000, output_tokens: 1000 }), {
      input_tokens: 2000,
      cache_read_input_tokens: 500_000,
      output_tokens: 500,
    })

    expect(usage).toEqual({
      forks: 2,
      input_tokens: 2000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_500_000,
      output_tokens: 1500,
    })
    // 1.5M cache read * $0.20 + 2k input * $4 + 1.5k output * $20 per 1M tokens
    expect(Math.abs((usageCost(usage, 'claude-opus-5-5') ?? 0) - 0.338) < 1e-9).toBe(true)
  })

  test('has no price for an unknown model', () => {
    expect(usageCost(emptyUsage(), 'some-other-model')).toBeUndefined()
  })
})
