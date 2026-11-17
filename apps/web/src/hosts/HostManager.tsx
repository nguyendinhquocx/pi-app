import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PairOffer } from '@shared/remote'
import { chooseEndpoint, pagePolicy } from '../transport/endpoint'
import { createDeviceKey, MemoryDeviceKeyStore, type DeviceKeyStore } from '../transport/device-keys'
import { HostConnection, type ConnState } from '../transport/host-connection'
import { HostStore } from './host-store'
import { pairFromFragment, parsePairLink } from './pair'
import { QrScanner, qrScanSupported } from './QrScanner'

/**
 * Host manager shell (spec T3 UX contract): first view lists paired hosts and their online
 * state; the pair flow offers QR scan and paste on the same screen and explains host identity,
 * not network internals. Forget removes the local key; server-side revoke stays on the desktop.
 *
 * T3 scope: transport + host manager only. The Pi workbench timeline/composer is T4.
 */

type HostUiState = {
  hostId: string
  hostName: string
  state: ConnState
  detail: string | null
  connection: HostConnection
}

export function HostManager({ keyStore }: { keyStore?: DeviceKeyStore }) {
  const store = useMemo(() => new HostStore(keyStore ?? new MemoryDeviceKeyStore()), [keyStore])
  const [hosts, setHosts] = useState<{ hostId: string; hostName: string }[]>([])
  const [connStates, setConnStates] = useState<Record<string, { state: ConnState; detail: string | null }>>({})
  const [pairText, setPairText] = useState('')
  const [pairError, setPairError] = useState<string | null>(null)
  const [pairSuccess, setPairSuccess] = useState<string | null>(null)
  const connections = useRef(new Map<string, HostConnection>())

  const refreshHosts = useCallback(async () => {
    const list = await store.list()
    setHosts(list.map((h) => ({ hostId: h.hostId, hostName: h.hostName })))
    return list
  }, [store])

  const connectHost = useCallback(
    (hostId: string) => {
      void (async () => {
        const existing = connections.current.get(hostId)
        if (existing) {
          existing.start()
          return
        }
        const record = await store.record(hostId)
        if (!record) return
        const policy = pagePolicy()
        const endpoint = chooseEndpoint(record.endpoints, policy)
        if (!endpoint.ok) {
          setConnStates((s) => ({ ...s, [hostId]: { state: 'error', detail: endpoint.reason === 'mixed_content' ? 'Chỉ kết nối được wss:// từ trang HTTPS (Tailscale Serve)' : 'Không có endpoint hợp lệ' } }))
          return
        }
        const conn = new HostConnection({
          endpoint: endpoint.endpoint,
          device: record,
          events: {
            onState: (state, detail) => {
              setConnStates((s) => ({ ...s, [hostId]: { state, detail: detail ?? null } }))
            },
          },
        })
        connections.current.set(hostId, conn)
        conn.start()
      })()
    },
    [store],
  )

  useEffect(() => {
    void refreshHosts()
    // Pair offer pre-fill from the URL fragment (host → "Copy web pair link").
    const offer = pairFromFragment(window.location.hash)
    if (offer) {
      setPairText(`https://li.quoc.app/#pair=${window.location.hash.slice('#pair='.length)}`)
      // Clear the fragment so a reload does not re-open the stale (single-use) offer.
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    return () => {
      for (const conn of connections.current.values()) conn.dispose()
      connections.current.clear()
    }
  }, [refreshHosts])

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
      await store.pairWith(offer, parsed.endpoint, (o) => createDeviceKey(keyStore ?? new MemoryDeviceKeyStore(), o))
      await refreshHosts()
      setPairSuccess(`Đã ghép nối với ${offer.hostName}. Chọn "Kết nối" để mở phiên.`)
      setPairText('')
      connectHost(offer.hostId)
    },
    [store, keyStore, refreshHosts, connectHost],
  )

  const doForget = useCallback(
    async (hostId: string) => {
      connections.current.get(hostId)?.dispose()
      connections.current.delete(hostId)
      await store.forget(hostId)
      setConnStates((s) => {
        const { [hostId]: _removed, ...rest } = s
        void _removed
        return rest
      })
      await refreshHosts()
    },
    [store, refreshHosts],
  )

  const policy = pagePolicy()

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Li Web</h1>
        <p>Workbench cho LiX qua tailnet của bạn. Mỗi máy chủ cần ghép nối riêng; khoá thiết bị lưu cục bộ trên trình duyệt này.</p>
      </header>

      <section className="card" aria-labelledby="hosts-heading">
        <h2 id="hosts-heading">Máy chủ đã ghép nối</h2>
        {hosts.length === 0 ? (
          <div className="empty">Chưa có máy chủ nào. Dán pair link hoặc quét QR từ LiX desktop bên dưới.</div>
        ) : (
          hosts.map((h) => {
            const cs = connStates[h.hostId]
            const dotClass = cs?.state === 'online' ? 'online' : cs?.state === 'error' ? 'error' : cs?.state === 'connecting' || cs?.state === 'handshaking' || cs?.state === 'reconnecting' ? 'connecting' : ''
            const label = cs?.state === 'online' ? 'Trực tuyến' : cs?.state === 'reconnecting' ? 'Đang kết nối lại…' : cs?.state === 'error' ? 'Lỗi' : cs?.state ? 'Đang kết nối…' : 'Ngoại tuyến'
            return (
              <div key={h.hostId} className="host-row">
                <span className={`host-dot ${dotClass}`} aria-hidden="true" />
                <div className="host-main">
                  <div className="host-name">{h.hostName}</div>
                  <div className="host-meta" title={cs?.detail ?? undefined}>
                    {label}
                    {cs?.detail ? ` — ${cs.detail}` : ''}
                  </div>
                </div>
                <button onClick={() => connectHost(h.hostId)}>Kết nối</button>
                <button className="danger" onClick={() => void doForget(h.hostId)}>
                  Quên
                </button>
              </div>
            )
          })
        )}
        <p className="notice">"Quên" chỉ xoá khoá trên trình duyệt này. Để thu hồi quyền từ phía máy chủ, xoá thiết bị trong LiX desktop (Auth → Devices).</p>
      </section>

      <section className="card" aria-labelledby="pair-heading">
        <h2 id="pair-heading">Ghép nối máy chủ mới</h2>
        <p className="notice">
          Trên LiX desktop mở phần Remote/Pair, rồi quét QR hoặc dán link ghép nối vào đây. Link chứa danh tính máy chủ (khóa công khai) và địa chỉ riêng trong tailnet — chỉ dùng một lần, hết hạn sau 5 phút.
        </p>
        <QrScanner onResult={(text) => void doPair(text)} onError={(message) => setPairError(`Camera: ${message}`)} />
        <textarea
          value={pairText}
          onChange={(e) => setPairText(e.target.value)}
          placeholder="pidesk://pair#… hoặc https://li.quoc.app/#pair=…"
          aria-label="pair link"
        />
        {pairError && <p className="notice error">{pairError}</p>}
        {pairSuccess && <p className="notice success">{pairSuccess}</p>}
        <div className="pair-actions">
          <button className="primary" disabled={!pairText.trim()} onClick={() => void doPair(pairText)}>
            Ghép nối
          </button>
          {!qrScanSupported() && <span className="notice">Trình duyệt này không hỗ trợ quét QR — dùng paste link.</span>}
          {!policy.secure && <span className="notice">Đang chạy qua HTTP (dev): ws:// nội bộ được phép. Bản production (HTTPS) chỉ dùng wss:// qua Tailscale Serve.</span>}
        </div>
      </section>
    </div>
  )
}
