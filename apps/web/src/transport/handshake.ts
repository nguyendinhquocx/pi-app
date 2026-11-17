import { base64UrlDecode, Hs2Schema, HsErrSchema, type Hs1, type Hs2Payload, type Role } from '@shared/remote'
import {
  clientFinishHs2,
  clientHs1,
  keyPairFromPrivate,
  SecureChannel,
  type KeyPair,
} from '@shared/remote/crypto'
import { decodeHostPub, type DeviceKeyRecord } from './device-keys'

/**
 * Browser-side Noise-IK handshake (spec T3): byte-for-byte the same hs1/hs2 exchange the
 * Android client performs, because both share `packages/shared/remote/crypto`. Plaintext JSON
 * text frames until hs2 lands; after that the socket carries only encrypted binary frames.
 */

export type HandshakeOutcome =
  | { ok: true; payload: Hs2Payload; role: Role; channel: SecureChannel }
  | { ok: false; code: 'hs_err' | 'bad'; code_detail?: string }

export type HandshakeInput = {
  /** Already-open WebSocket (readyState CONNECTING or OPEN). */
  ws: WebSocket
  device: Pick<DeviceKeyRecord, 'priv' | 'pub'>
  /** base64url host static public key pinned from the pair offer / stored record. */
  hostPub: string
  /** Pairing token — only sent on the very first pairing of this key. */
  pairToken?: string
  deviceName?: string
  devicePlatform?: string
  /** Test seam: fixed ephemeral key for deterministic vectors. */
  ephemeral?: Parameters<typeof clientHs1>[0]['ephemeral']
}

/** Wire-comparable client name/platform defaults for the PWA. */
export function webDeviceIdentity(): { name: string; platform: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let browser = 'Browser'
  if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Safari\//.test(ua)) browser = 'Safari'
  return { name: 'Li Web', platform: browser.slice(0, 40) }
}

function clientStaticFromRecord(device: Pick<DeviceKeyRecord, 'priv'>): KeyPair {
  return keyPairFromPrivate(base64UrlDecode(device.priv))
}

/** Build and send hs1; returns the finisher that consumes the host's hs2 (or hs_err). */
export function sendHs1(input: HandshakeInput): { finish: (hs2: unknown) => HandshakeOutcome } {
  const prepared = prepareHs1(input)
  input.ws.send(JSON.stringify(prepared.msg))
  return { finish: prepared.finish }
}

/**
 * Build hs1 WITHOUT sending. The finisher must be installed on the connection BEFORE the hs1
 * bytes hit the socket: a same-process host simulator (and a fast host) can answer hs2
 * synchronously inside `send`, and the reply must not arrive before the finisher exists.
 */
export function prepareHs1(input: HandshakeInput): { msg: Hs1; finish: (hs2: unknown) => HandshakeOutcome } {
  const hostStatic = decodeHostPub(input.hostPub)
  const identity = webDeviceIdentity()
  const { msg, state } = clientHs1({
    hostPub: hostStatic,
    clientStatic: clientStaticFromRecord(input.device),
    payload: {
      name: (input.deviceName ?? identity.name).slice(0, 80),
      platform: (input.devicePlatform ?? identity.platform).slice(0, 40),
      ...(input.pairToken ? { pair: input.pairToken } : {}),
    },
    ...(input.ephemeral ? { ephemeral: input.ephemeral } : {}),
  })
  return {
    msg,
    finish: (hs2: unknown): HandshakeOutcome => {
      const err = HsErrSchema.safeParse(hs2)
      if (err.success) return { ok: false, code: 'hs_err', code_detail: err.data.code }
      try {
        const parsed = Hs2Schema.parse(hs2)
        const { payload, keys } = clientFinishHs2(state, parsed)
        // Wrong-host guard: hs2 only decrypts when the peer holds the pinned host static key.
        return { ok: true, payload, role: payload.role, channel: SecureChannel.forClient(keys) }
      } catch {
        return { ok: false, code: 'bad' }
      }
    },
  }
}
