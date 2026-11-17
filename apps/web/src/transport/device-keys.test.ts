import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { base64UrlDecode, base64UrlEncode } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import {
  createDeviceKey,
  decodeHostPub,
  IdbDeviceKeyStore,
  MemoryDeviceKeyStore,
  encodeKeyPair,
  decodeKeyPair,
  type DeviceKeyRecord,
} from './device-keys'

function makeRecord(hostId = 'host_a'): DeviceKeyRecord {
  const kp = encodeKeyPair(generateKeyPair())
  return {
    hostId,
    hostName: 'Host A',
    hostPub: base64UrlEncode(generateKeyPair().pub),
    ...kp,
    endpoints: ['wss://a.tail1234.ts.net/ws'],
    createdAt: 1_000,
    lastConnectedAt: null,
    deviceId: null,
  }
}

describe('device key stores (spec T3: per-host keys in IndexedDB)', () => {
  it('memory store: put/get/delete/list round-trip and isolation by hostId', async () => {
    const store = new MemoryDeviceKeyStore()
    const a = makeRecord('host_a')
    const b = makeRecord('host_b')
    await store.put(a)
    await store.put(b)
    expect(await store.get('host_a')).toEqual(a)
    expect((await store.list()).map((r) => r.hostId).sort()).toEqual(['host_a', 'host_b'])
    await store.delete('host_a')
    expect(await store.get('host_a')).toBeNull()
    expect(await store.get('host_b')).not.toBeNull()
  })

  it('idb store: per-host keys survive store instances (browser persistence semantics)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = new IDBFactory()
    const db1 = new IdbDeviceKeyStore()
    const record = makeRecord('host_x')
    await db1.put(record)
    // A second store instance = a fresh page load sharing the same origin DB.
    const db2 = new IdbDeviceKeyStore()
    expect(await db2.get('host_x')).toEqual(record)
    await db2.delete('host_x')
    expect(await db1.get('host_x')).toBeNull()
  })

  it('createDeviceKey reuses an existing key for the same host (per-host stability)', async () => {
    const store = new MemoryDeviceKeyStore()
    const first = await createDeviceKey(store, {
      hostId: 'host_k',
      hostName: 'K',
      hostPub: base64UrlEncode(generateKeyPair().pub),
      endpoints: ['wss://k.tail1234.ts.net/ws'],
    })
    const second = await createDeviceKey(store, {
      hostId: 'host_k',
      hostName: 'K (renamed)',
      hostPub: base64UrlEncode(generateKeyPair().pub),
      endpoints: ['ws://100.64.0.9:47900/ws'],
    })
    expect(second.priv).toBe(first.priv)
    expect(second.pub).toBe(first.pub)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.hostName).toBe('K (renamed)')
    expect(second.endpoints).toContain('ws://100.64.0.9:47900/ws')
  })

  it('decodeKeyPair/decodeHostPub round-trip and validate lengths', async () => {
    const kp = generateKeyPair()
    const encoded = encodeKeyPair(kp)
    const decoded = decodeKeyPair(encoded)
    expect(base64UrlEncode(decoded.pub)).toBe(encoded.pub)
    expect(base64UrlEncode(decoded.priv)).toBe(encoded.priv)
    expect(decodeHostPub(encoded.pub).length).toBe(32)
    expect(() => decodeHostPub(base64UrlEncode(new Uint8Array(8)))).toThrow()
  })
})
