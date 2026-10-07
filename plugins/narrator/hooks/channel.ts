// The session's channel on the relay: utterances are sealed with a key that
// only this mod and the page URL's fragment hold, so the relay sees ciphertext.
import nacl from './vendor/nacl.js'

export type Priority = 'urgent' | 'normal'

export type ChannelCredentials = {
  id: string
  token: string
  key: string
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): Uint8Array => {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}

const randomBase64Url = (size: number): string => toBase64Url(crypto.getRandomValues(new Uint8Array(size)))

export const isCredentials = (value: unknown): value is ChannelCredentials => {
  if (typeof value !== 'object' || value === null) return false
  const { id, token, key } = value as Record<string, unknown>
  return typeof id === 'string' && typeof token === 'string' && typeof key === 'string'
}

export const createCredentials = (): ChannelCredentials => ({
  id: randomBase64Url(16),
  token: randomBase64Url(32),
  key: toBase64Url(nacl.randomBytes(nacl.secretbox.keyLength)),
})

export const pageUrl = (serviceUrl: string, channel: ChannelCredentials): string =>
  `${serviceUrl}/s/${channel.id}#k=${channel.key}`

export const authHeaders = (channel: ChannelCredentials): Record<string, string> => ({
  Authorization: `Bearer ${channel.token}`,
  'Content-Type': 'application/json',
})

export const channelUrl = (serviceUrl: string, channel: ChannelCredentials, suffix = ''): string =>
  `${serviceUrl}/api/channels/${channel.id}${suffix}`

export type OutboundKind = 'narration' | 'reply' | 'confirm' | 'heard'

export type OutboundMessage = {
  text: string
  priority: Priority
  kind: OutboundKind
  ref?: string
}

export const sealMessage = (channel: ChannelCredentials, message: OutboundMessage, ts: number) => {
  const plaintext = new TextEncoder().encode(JSON.stringify({ c: channel.id, ts, ...message }))
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const sealed = nacl.secretbox(plaintext, nonce, fromBase64Url(channel.key))
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(sealed) }
}

export const sealUtterance = (channel: ChannelCredentials, text: string, priority: Priority, ts: number) =>
  sealMessage(channel, { text, priority, kind: 'narration' }, ts)

// Opens a message the page sealed with the channel key; null when it is forged,
// corrupted or addressed to another channel.
export const openSealed = (channel: ChannelCredentials, nonce: string, ciphertext: string): unknown => {
  try {
    const opened = nacl.secretbox.open(fromBase64Url(ciphertext), fromBase64Url(nonce), fromBase64Url(channel.key))
    if (opened === null) return null
    const message: unknown = JSON.parse(new TextDecoder().decode(opened))
    const isOwn = typeof message === 'object' && message !== null && (message as { c?: unknown }).c === channel.id
    return isOwn ? message : null
  } catch {
    return null
  }
}
