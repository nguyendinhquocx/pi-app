import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { base64UrlDecode, base64UrlEncode, Hs2Schema } from '@shared/remote'
import { clientFinishHs2, clientHs1, keyPairFromPrivate, SecureChannel } from '@shared/remote/crypto'
import { sendHs1, webDeviceIdentity } from './handshake'

/**
 * Browser crypto conformance (spec T3 verify): the SAME golden vectors the Android app runs
 * (packages/shared/remote/fixtures/crypto-vectors.json, regenerated in T2 for the isomorphic
 * crypto). The web client must produce byte-identical hs1 and derive identical session keys.
 */

const vectors = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/shared/remote/fixtures/crypto-vectors.json'), 'utf8'),
) as {
  hostStaticPriv: string
  hostStaticPub: string
  clientStaticPriv: string
  clientStaticPub: string
  clientEphemeralPriv: string
  hostEphemeralPriv: string
  hs1Payload: { name: string; platform: string; pair: string }
  hs1: { t: 'hs1'; v: number; e: string; ct: string }
  hs2Payload: { deviceId: string; hostId: string; hostName: string; epoch: string; role: 'viewer' | 'operator' }
  hs2: { t: 'hs2'; e: string; ct: string }
  keys: { c2s: string; s2c: string }
  c2sFrames: { plaintext: unknown; frame: string }[]
  s2cFrames: { plaintext: unknown; frame: string }[]
}

describe('browser crypto conformance vs Android golden vectors', () => {
  it('hs1 bytes match the shared vector', () => {
    const clientStatic = keyPairFromPrivate(base64UrlDecode(vectors.clientStaticPriv))
    const ephemeral = keyPairFromPrivate(base64UrlDecode(vectors.clientEphemeralPriv))
    const hostPub = base64UrlDecode(vectors.hostStaticPub)
    const { msg } = clientHs1({
      hostPub,
      clientStatic,
      payload: { ...vectors.hs1Payload },
      ephemeral,
    })
    expect(msg.t).toBe('hs1')
    expect(msg.v).toBe(vectors.hs1.v)
    expect(msg.e).toBe(vectors.hs1.e)
    expect(msg.ct).toBe(vectors.hs1.ct)
  })

  it('sendHs1 emits the vector hs1 over the socket and finishes with the vector hs2', () => {
    const sentLog: string[] = []
    const fakeWs = {
      send(data: string) {
        sentLog.push(data)
      },
    } as unknown as WebSocket
    const device = { priv: vectors.clientStaticPriv, pub: vectors.clientStaticPub }
    const outcome = sendHs1({
      ws: fakeWs,
      device,
      hostPub: vectors.hostStaticPub,
      pairToken: vectors.hs1Payload.pair,
      deviceName: vectors.hs1Payload.name,
      devicePlatform: vectors.hs1Payload.platform,
      ephemeral: keyPairFromPrivate(base64UrlDecode(vectors.clientEphemeralPriv)),
    })
    // Byte-for-byte hs1 on the wire (spec: handshake interoperates with Android).
    expect(sentLog[0]).toBe(JSON.stringify(vectors.hs1))
    expect(JSON.parse(sentLog[0])).toEqual(vectors.hs1)

    // hs2 verification + channel keys vs the shared vector.
    const parsed = Hs2Schema.parse(vectors.hs2)
    const finished = (() => {
      // clientFinishHs2 needs the same state sendHs1 built; run the standalone path for keys.
      const clientStatic = keyPairFromPrivate(base64UrlDecode(vectors.clientStaticPriv))
      const ephemeral = keyPairFromPrivate(base64UrlDecode(vectors.clientEphemeralPriv))
      const { state } = clientHs1({
        hostPub: base64UrlDecode(vectors.hostStaticPub),
        clientStatic,
        payload: { ...vectors.hs1Payload },
        ephemeral,
      })
      return clientFinishHs2(state, parsed)
    })()
    expect(finished.payload).toEqual(vectors.hs2Payload)
    expect(base64UrlEncode(finished.keys.c2s)).toBe(vectors.keys.c2s)
    expect(base64UrlEncode(finished.keys.s2c)).toBe(vectors.keys.s2c)

    // And the outcome wrapper agrees on payload + role.
    const viaSend = outcome.finish(vectors.hs2)
    expect(viaSend.ok).toBe(true)
    if (viaSend.ok) expect(viaSend.payload).toEqual(vectors.hs2Payload)
  })

  it('wrong host key: hs2 fails to decrypt (wrong-host guard, spec acceptance)', () => {
    const clientStatic = keyPairFromPrivate(base64UrlDecode(vectors.clientStaticPriv))
    const ephemeral = keyPairFromPrivate(base64UrlDecode(vectors.clientEphemeralPriv))
    const { state } = clientHs1({
      // A DIFFERENT host public key than the one that produced vectors.hs2.
      hostPub: base64UrlDecode(vectors.clientStaticPub),
      clientStatic,
      payload: { ...vectors.hs1Payload },
      ephemeral,
    })
    expect(() => clientFinishHs2(state, vectors.hs2)).toThrow()
  })

  it('secure channel frames match the vectors in both directions (client + host sides)', () => {
    const keys = { c2s: base64UrlDecode(vectors.keys.c2s), s2c: base64UrlDecode(vectors.keys.s2c) }
    const client = SecureChannel.forClient(keys) // send c2s, recv s2c
    const host = SecureChannel.forHost(keys) // send s2c, recv c2s
    for (const v of vectors.c2sFrames) {
      const encrypted = client.encrypt(v.plaintext)
      expect(base64UrlEncode(encrypted)).toBe(v.frame)
      expect(host.decrypt(base64UrlDecode(v.frame))).toEqual(v.plaintext)
    }
    for (const v of vectors.s2cFrames) {
      expect(client.decrypt(base64UrlDecode(v.frame))).toEqual(v.plaintext)
    }
  })

  it('web device identity is stable and bounded (max 80/40 chars)', () => {
    const id = webDeviceIdentity()
    expect(id.name.length).toBeGreaterThan(0)
    expect(id.name.length).toBeLessThanOrEqual(80)
    expect(id.platform.length).toBeLessThanOrEqual(40)
  })
})
