import { base64UrlDecode, base64UrlEncode } from '@shared/remote'
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from '@shared/remote/crypto'

/**
 * Per-host device keys for the browser PWA (spec T3).
 *
 * Every paired host gets its OWN X25519 static key, stored in IndexedDB under the host id.
 * Forgetting a host removes the key locally; the host-side device entry must be revoked from
 * the LiX desktop (Auth → devices) to cut server-side access — the web app has no revoke RPC.
 * No auth token, transcript or provider secret ever touches this store.
 */

export type DeviceKeyRecord = {
  hostId: string
  hostName: string
  /** Host static public key (base64url) from the pair offer — pinned for this key. */
  hostPub: string
  /** Client static key (base64url) — generated per host, never leaves this browser except hs1. */
  priv: string
  pub: string
  /** Endpoints as offered at pairing time; refreshed from host.hello on connect. */
  endpoints: string[]
  createdAt: number
  lastConnectedAt: number | null
  /** Server-assigned device id from the last successful handshake (for the host UI revoke list). */
  deviceId: string | null
}

export interface DeviceKeyStore {
  get(hostId: string): Promise<DeviceKeyRecord | null>
  put(record: DeviceKeyRecord): Promise<void>
  delete(hostId: string): Promise<void>
  list(): Promise<DeviceKeyRecord[]>
}

/** Convert a KeyPair to base64url for storage. */
export function encodeKeyPair(kp: KeyPair): { priv: string; pub: string } {
  return { priv: base64UrlEncode(kp.priv), pub: base64UrlEncode(kp.pub) }
}

export function decodeKeyPair(record: Pick<DeviceKeyRecord, 'priv' | 'pub'>): KeyPair {
  return keyPairFromPrivate(base64UrlDecode(record.priv))
}

export function decodeHostPub(hostPub: string): Uint8Array {
  const pub = base64UrlDecode(hostPub)
  if (pub.length !== 32) throw new Error('host public key must be 32 bytes')
  return pub
}

const DB_NAME = 'lix-web'
const DB_VERSION = 1
const STORE = 'device-keys'

export class IdbDeviceKeyStore implements DeviceKeyStore {
  private db: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'hostId' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
      })
    }
    return this.db
  }

  private tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const t = db.transaction(STORE, mode)
          const req = fn(t.objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'))
        }),
    )
  }

  get(hostId: string): Promise<DeviceKeyRecord | null> {
    return this.tx<DeviceKeyRecord | undefined>('readonly', (s) => s.get(hostId)).then((r) => r ?? null)
  }

  put(record: DeviceKeyRecord): Promise<void> {
    return this.tx('readwrite', (s) => s.put(record)).then(() => undefined)
  }

  delete(hostId: string): Promise<void> {
    return this.tx('readwrite', (s) => s.delete(hostId)).then(() => undefined)
  }

  list(): Promise<DeviceKeyRecord[]> {
    return this.tx<DeviceKeyRecord[]>('readonly', (s) => s.getAll())
  }
}

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private map = new Map<string, DeviceKeyRecord>()

  constructor(seed?: DeviceKeyRecord[]) {
    for (const r of seed ?? []) this.map.set(r.hostId, { ...r })
  }

  get(hostId: string): Promise<DeviceKeyRecord | null> {
    const r = this.map.get(hostId)
    return Promise.resolve(r ? { ...r } : null)
  }

  put(record: DeviceKeyRecord): Promise<void> {
    this.map.set(record.hostId, { ...record })
    return Promise.resolve()
  }

  delete(hostId: string): Promise<void> {
    this.map.delete(hostId)
    return Promise.resolve()
  }

  list(): Promise<DeviceKeyRecord[]> {
    return Promise.resolve([...this.map.values()].map((r) => ({ ...r })))
  }
}

/** Generate a fresh per-host key and return both the keypair and the storable record. */
export async function createDeviceKey(
  store: DeviceKeyStore,
  offer: { hostId: string; hostName: string; hostPub: string; endpoints: readonly string[] },
): Promise<DeviceKeyRecord> {
  const existing = await store.get(offer.hostId)
  const kp = generateKeyPair()
  const encoded = encodeKeyPair(kp)
  const record: DeviceKeyRecord = {
    hostId: offer.hostId,
    hostName: offer.hostName,
    hostPub: offer.hostPub,
    endpoints: [...offer.endpoints],
    priv: existing?.priv ?? encoded.priv,
    pub: existing?.pub ?? encoded.pub,
    createdAt: existing?.createdAt ?? Date.now(),
    lastConnectedAt: existing?.lastConnectedAt ?? null,
    deviceId: existing?.deviceId ?? null,
  }
  await store.put(record)
  return record
}
