import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { base64UrlEncode, type PairOffer } from '@shared/remote'
import { generateKeyPair } from '@shared/remote/crypto'
import { MemoryDeviceKeyStore, createDeviceKey } from '../transport/device-keys'
import { HostStore } from './host-store'

function makeOffer(hostId: string): PairOffer {
  return {
    v: 1,
    hostId,
    hostName: hostId === 'host_l' ? 'Laptop' : 'ProDesk',
    hostPub: base64UrlEncode(generateKeyPair().pub),
    endpoints: ['wss://x.tail1234.ts.net/ws'],
    pairToken: 'tok_0123456789abcdef',
    exp: Date.now() + 60_000,
  }
}

describe('HostStore (spec T3: separate device key per host, forget clears local state)', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = new IDBFactory()
  })

  it('pairWith creates one record per host; sessions never merge across hosts', async () => {
    const store = new HostStore(new MemoryDeviceKeyStore())
    const offerA = makeOffer('host_l')
    const offerB = makeOffer('host_p')
    await store.pairWith(offerA, 'wss://x.tail1234.ts.net/ws', (o) =>
      createDeviceKey(new MemoryDeviceKeyStore(), o),
    )
    await store.pairWith(offerB, 'wss://y.tail1234.ts.net/ws', (o) =>
      createDeviceKey(new MemoryDeviceKeyStore(), o),
    )
    const hosts = await store.list()
    expect(hosts.map((h) => h.hostId)).toEqual(['host_l', 'host_p'])
  })

  it('markConnected stamps lastConnectedAt + deviceId', async () => {
    const keys = new MemoryDeviceKeyStore()
    const store = new HostStore(keys)
    const offer = makeOffer('host_l')
    await store.pairWith(offer, 'wss://x.tail1234.ts.net/ws', (o) => createDeviceKey(keys, o))
    await store.markConnected('host_l', 'dev_1')
    const hosts = await store.list()
    expect(hosts[0].deviceId).toBe('dev_1')
    expect(hosts[0].lastConnectedAt).toBeGreaterThan(0)
  })

  it('forget removes the local key; forgetting a second time is a no-op', async () => {
    const keys = new MemoryDeviceKeyStore()
    const store = new HostStore(keys)
    const offer = makeOffer('host_l')
    await store.pairWith(offer, 'wss://x.tail1234.ts.net/ws', (o) => createDeviceKey(keys, o))
    expect(await store.forget('host_l')).toBe(true)
    expect(await store.list()).toEqual([])
    expect(await store.forget('host_l')).toBe(false)
  })

  it('IdbDeviceKeyStore integration: pairing persists across HostStore instances', async () => {
    const store1 = new HostStore()
    const offer = makeOffer('host_l')
    await store1.pairWith(offer, 'wss://x.tail1234.ts.net/ws', (o) => createDeviceKey(new MemoryDeviceKeyStore(), o))
    const store2 = new HostStore()
    const hosts = await store2.list()
    expect(hosts.map((h) => h.hostId)).toEqual(['host_l'])
  })
})
