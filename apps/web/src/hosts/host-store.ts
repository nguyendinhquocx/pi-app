import { IdbDeviceKeyStore, type DeviceKeyRecord, type DeviceKeyStore } from '../transport/device-keys'
import type { PairOffer } from '@shared/remote'
/**
 * Paired-host registry for the web PWA (spec T3): one IndexedDB record per host (device key +
 * pinned host public key + endpoints). Host sessions never merge — every connection instance is
 * host-scoped and the UI groups state per host id.
 */

export type PairedHost = {
  hostId: string
  hostName: string
  endpoints: string[]
  createdAt: number
  lastConnectedAt: number | null
  deviceId: string | null
}

export class HostStore {
  private readonly store: DeviceKeyStore

  constructor(store: DeviceKeyStore = new IdbDeviceKeyStore()) {
    this.store = store
  }

  async list(): Promise<PairedHost[]> {
    const records = await this.store.list()
    return records
      .map((r) => ({
        hostId: r.hostId,
        hostName: r.hostName,
        endpoints: r.endpoints,
        createdAt: r.createdAt,
        lastConnectedAt: r.lastConnectedAt,
        deviceId: r.deviceId,
      }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Full key record for a host (to build a connection). */
  async record(hostId: string): Promise<DeviceKeyRecord | null> {
    return this.store.get(hostId)
  }

  /** Create (or refresh endpoints of) a paired host from a valid pair offer. Returns the key record to handshake with. */
  async pairWith(offer: PairOffer, endpoint: string, createDeviceKey: (offer: { hostId: string; hostName: string; hostPub: string; endpoints: readonly string[] }) => Promise<DeviceKeyRecord>): Promise<DeviceKeyRecord> {
    const record = await createDeviceKey({
      hostId: offer.hostId,
      hostName: offer.hostName,
      hostPub: offer.hostPub,
      endpoints: offer.endpoints,
    })
    record.endpoints = [...new Set([endpoint, ...record.endpoints])]
    await this.store.put(record)
    return record
  }

  async markConnected(hostId: string, deviceId: string): Promise<void> {
    const record = await this.store.get(hostId)
    if (!record) return
    record.lastConnectedAt = Date.now()
    record.deviceId = deviceId
    await this.store.put(record)
  }

  /** Remove the local device key for a host (server-side revoke happens on the LiX desktop). */
  async forget(hostId: string): Promise<boolean> {
    const record = await this.store.get(hostId)
    if (!record) return false
    await this.store.delete(hostId)
    return true
  }
}
