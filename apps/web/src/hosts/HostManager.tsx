import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PairOffer } from '@shared/remote'
import { chooseEndpoint, pagePolicy } from '../transport/endpoint'
import { createDeviceKey, IdbDeviceKeyStore, type DeviceKeyStore } from '../transport/device-keys'
import { HostConnection, type ConnState } from '../transport/host-connection'
import type { HostConnectionOptions } from '../transport/host-connection'
import { HostStore } from './host-store'
import { pairFromFragment, parsePairLink } from './pair'
import { QrScanner, qrScanSupported } from './QrScanner'
import { Workbench, type WorkbenchConnection } from '../workbench/Workbench'

/**
 * Host manager shell (spec T3/T4): one IndexedDB-backed device key per host, pairing by QR or
 * pasted link, then hands live host connections to the workbench. The pairing token remains only
 * in memory until a successful handshake; it is never written to IndexedDB or static hosting.
 */

type HostView = { hostId: string; hostName: string }
type HostStateView = { state: ConnState; detail: string | null }

export function HostManager({ keyStore, socketFactory }: { keyStore?: DeviceKeyStore; socketFactory?: HostConnectionOptions['socketFactory'] }) {
  // Use the SAME persistent key store for HostStore and createDeviceKey. A fresh Memory store
  // per render/pair would lose the private key at reload and rotate identity on every re-pair.
  const deviceKeys = useMemo(() => keyStore ?? new IdbDeviceKeyStore(), [keyStore])
  const store = useMemo(() => new HostStore(deviceKeys), [deviceKeys])
  const [hosts, setHosts] = useState<HostView[]>([])
  const [connStates, setConnStates] = useState<Record<string, HostStateView>>({})
  const [pairText, setPairText] = useState('')
  const [pairError, setPairError] = useState<string | null>(null)
  const [pairSuccess, setPairSuccess] = useState<string | null>(null)
  const [connections, setConnections] = useState<WorkbenchConnection[]>([])
  const connectionsByHost = useRef(new Map<string, HostConnection>())
  const mounted = useRef(true)

  const refreshHosts = useCallback(async () => {
    const list = await store.list()
    setHosts(list.map((h) => ({ hostId: h.hostId, hostName: h.hostName })))
    return list
  }, [store])

  const syncConnections = useCallback(() => {
    if (!mounted.current) return
    setConnections([...connectionsByHost.current].map(([hostId, conn]) => ({ hostId, conn })))
  }, [])

  const connectHost = useCallback(
    async (hostId: string, pairToken?: string): Promise<void> => {
      const existing = connectionsByHost.current.get(hostId)
      if (existing) {
        existing.start()
        return
      }
      const record = await store.record(hostId)
      if (!record) return
      const choice = chooseEndpoint(record.endpoints, pagePolicy())
      if (!choice.ok) {
        setConnStates((s) => ({
          ...s,
          [hostId]: {
            state: 'error',
            detail: choice.reason === 'mixed_content'
              ? 'Host chưa có wss:// — bật Tailscale Serve để kết nối từ HTTPS.'
              : 'Không có endpoint riêng/tailnet hợp lệ trong pair link.',
          },
        }))
        return
      }

      const connection = new HostConnection({
        endpoint: choice.endpoint,
        device: record,
        ...(socketFactory ? { socketFactory } : {}),
        ...(pairToken ? { pairToken } : {}),
        events: {
          onState: (state, detail) => {
            setConnStates((s) => ({ ...s, [hostId]: { state, detail: detail ?? null } }))
          },
          onHello: (hello) => {
            // HostConnection verifies the pinned hostId before this event; persist only the
            // server-assigned device id + lastConnectedAt, never the pair token.
            void store.markConnected(hostId, hello.deviceId)
          },
        },
      })
      connectionsByHost.current.set(hostId, connection)
      syncConnections()
      connection.start()
    },
    [store, socketFactory, syncConnections],
  )

  const closeHost = useCallback((hostId: string) => {
    connectionsByHost.current.get(hostId)?.dispose()
    connectionsByHost.current.delete(hostId)
    setConnStates((s) => ({ ...s, [hostId]: { state: 'closed', detail: null } }))
    syncConnections()
  }, [syncConnections])

  useEffect(() => {
    mounted.current = true
    void refreshHosts().then((list) => {
      // Restore each paired host independently. An unreachable/off-tailnet host remains a
      // per-host disconnected state; it never blocks other hosts or merges their session data.
      for (const host of list) void connectHost(host.hostId)
    }).catch(() => undefined)

    // Pair offer pre-fill from the URL fragment; clear it immediately because the token is
    // single-use and should not survive a reload in browser history.
    const offer = pairFromFragment(window.location.hash)
    if (offer) {
      setPairText(`https://li.quoc.app/#pair=${window.location.hash.slice('#pair='.length)}`)
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }

    return () => {
      mounted.current = false
      for (const conn of connectionsByHost.current.values()) conn.dispose()
      connectionsByHost.current.clear()
    }
  }, [connectHost, refreshHosts])

  const doPair = useCallback(
    async (text: string) => {
      setPairError(null)
      setPairSuccess(null)
      const parsed = parsePairLink(text)
      if (!parsed.ok) {
        setPairError(parsed.error)
        return
      }
      const offer: PairOffer = parsed.offer
      try {
        await store.pairWith(offer, parsed.endpoint, (o) => createDeviceKey(deviceKeys, o))
        await refreshHosts()
        setPairText('')
        setPairSuccess(`Đã ghép nối với ${offer.hostName}. Đang xác thực host…`)
        // Pass the one-time token in memory to the first Noise-IK handshake. It is never stored.
        await connectHost(offer.hostId, offer.pairToken)
      } catch (error) {
        setPairError(error instanceof Error ? error.message : String(error))
      }
    },
    [store, deviceKeys, refreshHosts, connectHost],
  )

  const doForget = useCallback(
    async (hostId: string) => {
      closeHost(hostId)
      await store.forget(hostId)
      setConnStates((s) => {
        const { [hostId]: _removed, ...rest } = s
        void _removed
        return rest
      })
      await refreshHosts()
    },
    [closeHost, store, refreshHosts],
  )

  const policy = pagePolicy()
  const managerPanel = (
    <div className="host-manager-panel">
      <section className="card" aria-labelledby="hosts-heading">
        <h2 id="hosts-heading">Máy chủ đã ghép nối</h2>
        {hosts.length === 0 ? (
          <div className="empty">Chưa có host. Quét QR hoặc dán pair link từ LiX desktop để bắt đầu.</div>
        ) : (
          hosts.map((host) => {
            const cs = connStates[host.hostId]
            const dotClass = cs?.state === 'online' ? 'online' : cs?.state === 'error' || cs?.state === 'closed' ? 'error' : cs?.state === 'connecting' || cs?.state === 'handshaking' || cs?.state === 'reconnecting' ? 'connecting' : ''
            const label = cs?.state === 'online' ? 'Trực tuyến' : cs?.state === 'reconnecting' ? 'Đang kết nối lại…' : cs?.state === 'error' ? 'Không kết nối được' : cs?.state === 'closed' ? 'Đã ngắt' : cs?.state ? 'Đang kết nối…' : 'Chưa kết nối'
            return (
              <div key={host.hostId} className="host-row">
                <span className={`host-dot ${dotClass}`} aria-hidden="true" />
                <div className="host-main">
                  <div className="host-name">{host.hostName}</div>
                  <div className="host-meta" title={cs?.detail ?? undefined}>
                    {label}{cs?.detail ? ` — ${cs.detail}` : ''}
                  </div>
                </div>
                <button onClick={() => void connectHost(host.hostId)}>Kết nối</button>
                <button className="danger" onClick={() => void doForget(host.hostId)}>Quên</button>
              </div>
            )
          })
        )}
        <p className="notice">“Quên” xoá khoá thiết bị trên trình duyệt này. Muốn thu hồi quyền từ host, xoá thiết bị trong LiX desktop → Auth → Devices.</p>
      </section>

      <section className="card" aria-labelledby="pair-heading">
        <h2 id="pair-heading">Ghép nối host mới</h2>
        <p className="notice">
          Mở Remote/Pair trên LiX desktop, rồi quét QR hoặc dán link. Pair link xác định host bằng khoá công khai và chỉ dùng một lần trong 5 phút.
        </p>
        <QrScanner onResult={(text) => void doPair(text)} onError={(message) => setPairError(`Camera: ${message}`)} />
        <textarea
          value={pairText}
          onChange={(e) => setPairText(e.target.value)}
          placeholder="pidesk://pair#… hoặc https://li.quoc.app/#pair=…"
          aria-label="Pair link"
        />
        {pairError && <p className="notice error" role="alert">{pairError}</p>}
        {pairSuccess && <p className="notice success" role="status">{pairSuccess}</p>}
        <div className="pair-actions">
          <button className="primary" disabled={!pairText.trim()} onClick={() => void doPair(pairText)}>Ghép nối</button>
          {!qrScanSupported() && <span className="notice">Trình duyệt này không hỗ trợ quét QR — dán link vẫn dùng được.</span>}
          {!policy.secure && <span className="notice">HTTP dev cho phép ws:// nội bộ; bản HTTPS production chỉ dùng wss:// qua Tailscale Serve.</span>}
        </div>
      </section>
    </div>
  )

  return (
    <div className={connections.length > 0 ? 'li-web-root connected' : 'li-web-root'}>
      <header className="app-header app-header-root">
        <h1>Li Web</h1>
        {connections.length === 0 && <p>Pi workbench trên các host LiX trong tailnet của mày.</p>}
      </header>
      {connections.length > 0 ? (
        <>
          <details className="host-manager-disclosure">
            <summary>Hosts &amp; ghép nối</summary>
            {managerPanel}
          </details>
          <Workbench connections={connections} onCloseHost={closeHost} />
        </>
      ) : (
        <main className="app-shell">{managerPanel}</main>
      )}
    </div>
  )
}
