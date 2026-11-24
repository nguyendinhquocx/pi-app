import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { PairOffer } from '@shared/remote'
import { chooseEndpoint, pagePolicy, queryLocalNetworkAccessPermission } from '../transport/endpoint'
import { createDeviceKey, IdbDeviceKeyStore, type DeviceKeyStore } from '../transport/device-keys'
import { HostConnection, type ConnState } from '../transport/host-connection'
import type { HostConnectionOptions } from '../transport/host-connection'
import { HostStore } from './host-store'
import { pairFromFragment, parsePairLink } from './pair'
import { QrScanner, qrScanSupported } from './QrScanner'
import { useWorkbench } from '../workbench/workbench-store'
import { Workbench, type WorkbenchConnection } from '../workbench/Workbench'

/**
 * Host management keeps the real HostStore/connection/pairing behavior while presenting the
 * active-host picker in the SessionRail footer. The QA preview shell is never part of this UI.
 * Pair tokens remain memory-only through the first handshake.
 */

type HostView = { hostId: string; hostName: string }
type HostStateView = { state: ConnState; detail: string | null; permissionDenied?: boolean }

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Accessible modal (spec T1): Escape/backdrop/close-button dismissal, focus containment and return. */
export function ModalDialog({ open, onClose, label, children }: {
  open: boolean
  onClose(): void
  label: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const trigger = document.activeElement as HTMLElement | null
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    if (document.activeElement === document.body || !panel?.contains(document.activeElement)) (first ?? panel)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusables.length === 0) return
      const firstEl = focusables[0]
      const lastEl = focusables[focusables.length - 1]
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === panel)) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      trigger?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="dialog-backdrop"
      data-testid="host-dialog-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div ref={panelRef} className="host-dialog" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <button className="dialog-close" aria-label="Đóng" onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  )
}

export function HostManager({ keyStore, socketFactory, initialDialogOpen = false }: { keyStore?: DeviceKeyStore; socketFactory?: HostConnectionOptions['socketFactory']; initialDialogOpen?: boolean }) {
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
  const [dialogOpen, setDialogOpen] = useState(initialDialogOpen)
  const [dialogTab, setDialogTab] = useState<'hosts' | 'pair'>('hosts')
  const [forgetTarget, setForgetTarget] = useState<string | null>(null)
  const [hostPickerOpen, setHostPickerOpen] = useState(false)
  const forgetTriggerRef = useRef<HTMLButtonElement | null>(null)
  const forgetConfirmRef = useRef<HTMLButtonElement | null>(null)
  const activeHostId = useWorkbench((s) => s.activeHostId)
  const setActiveHost = useWorkbench((s) => s.setActiveHost)
  const hostPickerRef = useRef<HTMLDivElement | null>(null)
  const hostPickerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const hostMenuRef = useRef<HTMLDivElement | null>(null)
  const pairTextRef = useRef<HTMLTextAreaElement | null>(null)
  const connectionsByHost = useRef(new Map<string, HostConnection>())
  const permissionChecks = useRef(new Set<string>())
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
        const detail = choice.reason === 'mixed_content'
          ? 'Host chưa có wss:// — bật Tailscale Serve để kết nối từ HTTPS.'
          : 'Không có endpoint riêng/tailnet hợp lệ trong pair link.'
        setConnStates((s) => ({ ...s, [hostId]: { state: 'error', detail } }))
        // Surface the selected host's real policy failure in its own slice; never leave the
        // previous host's selected session visible while this host is unavailable.
        useWorkbench.getState().setConnState(hostId, 'error', detail)
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
            if (state === 'online') permissionChecks.current.delete(hostId)
            if (!pagePolicy().secure || (state !== 'reconnecting' && state !== 'error') || permissionChecks.current.has(hostId)) return
            permissionChecks.current.add(hostId)
            void queryLocalNetworkAccessPermission().then((permission) => {
              if (!mounted.current || permission !== 'denied') return
              const guidance = 'Trình duyệt đang chặn quyền mạng nội bộ. Cho phép quyền cho li.quoc.app trong cài đặt trang rồi thử kết nối lại.'
              setConnStates((s) => ({ ...s, [hostId]: { state: 'error', detail: guidance, permissionDenied: true } }))
              useWorkbench.getState().setConnState(hostId, 'error', guidance)
            }).finally(() => permissionChecks.current.delete(hostId))
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
      setDialogTab('pair')
      setDialogOpen(true)
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
        // Handshake started: drop the user straight into the workbench.
        setDialogOpen(false)
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
      if (activeHostId === hostId) setActiveHost(null)
      setConnStates((s) => {
        const { [hostId]: _removed, ...rest } = s
        void _removed
        return rest
      })
      setForgetTarget(null)
      await refreshHosts()
    },
    [activeHostId, closeHost, setActiveHost, store, refreshHosts],
  )

  const openDialog = useCallback((tab: 'hosts' | 'pair' = 'hosts') => {
    setHostPickerOpen(false)
    setForgetTarget(null)
    setDialogTab(tab)
    setDialogOpen(true)
  }, [])

  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    setForgetTarget(null)
  }, [])

  useEffect(() => {
    if (!hostPickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !hostPickerRef.current?.contains(event.target)) setHostPickerOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setHostPickerOpen(false)
      hostPickerTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    hostMenuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [hostPickerOpen])

  useEffect(() => {
    if (dialogOpen && dialogTab === 'pair') pairTextRef.current?.focus()
  }, [dialogOpen, dialogTab])

  useEffect(() => {
    if (forgetTarget) forgetConfirmRef.current?.focus()
  }, [forgetTarget])

  const policy = pagePolicy()

  const hostStateView = useCallback((cs: HostStateView | undefined) => {
    const connecting = cs?.state === 'connecting' || cs?.state === 'handshaking' || cs?.state === 'reconnecting'
    const dotClass = cs?.permissionDenied || cs?.state === 'error' || cs?.state === 'closed' ? 'error' : cs?.state === 'online' ? 'online' : connecting ? 'connecting' : ''
    const label = cs?.permissionDenied ? 'Cần quyền mạng nội bộ'
      : cs?.state === 'online' ? 'Trực tuyến'
        : cs?.state === 'reconnecting' ? 'Đang kết nối lại…'
          : cs?.state === 'connecting' || cs?.state === 'handshaking' ? 'Đang kết nối…'
            : cs?.state === 'error' ? 'Không kết nối được'
              : cs?.state === 'closed' ? 'Đã ngắt'
                : 'Chưa kết nối'
    return { dotClass, label }
  }, [])

  const hostsPanel = (
    <section className="host-dialog-section" aria-labelledby="hosts-heading">
      <h2 id="hosts-heading">Máy chủ đã ghép nối</h2>
      {hosts.length === 0 ? (
        <div className="empty">Chưa có host đã ghép nối.</div>
      ) : (
        hosts.map((host) => {
          const cs = connStates[host.hostId]
          const { dotClass, label } = hostStateView(cs)
          const online = cs?.state === 'online'
          return (
            <div key={host.hostId} className="host-row">
              <span className={`host-dot ${dotClass}`} aria-hidden="true" />
              <div className="host-main">
                <div className="host-name">{host.hostName}</div>
                {/* Online hosts stay quiet: the green dot carries the state (owner UAT 2026-11-24). */}
                {(cs?.permissionDenied || cs?.detail || (cs && cs.state !== 'online')) && (
                  <div className="host-meta" title={cs?.detail ?? undefined}>
                    {cs?.permissionDenied ? cs.detail
                      : online ? (cs?.detail ?? null)
                        : cs?.detail ? `${label} · ${cs.detail}` : label}
                  </div>
                )}
              </div>
              {!online && <button onClick={() => void connectHost(host.hostId)}>Kết nối</button>}
              {online && <button onClick={() => closeHost(host.hostId)}>Đóng tạm</button>}
              {forgetTarget === host.hostId ? (
                <div className="forget-confirm" role="alertdialog" aria-label={`Xác nhận quên ${host.hostName}`}>
                  <span className="notice">Xoá khoá thiết bị của trình duyệt này cho {host.hostName}?</span>
                  <button ref={forgetConfirmRef} className="danger" onClick={() => void doForget(host.hostId)}>Quên host</button>
                  <button onClick={() => { setForgetTarget(null); forgetTriggerRef.current?.focus() }}>Huỷ</button>
                </div>
              ) : (
                <button className="danger" aria-label={`Quên ${host.hostName}`} onClick={(event) => { forgetTriggerRef.current = event.currentTarget; setForgetTarget(host.hostId) }}>Quên</button>
              )}
            </div>
          )
        })
      )}
    </section>
  )

  const pairPanel = (
    <section className="host-dialog-section" aria-labelledby="pair-heading">
      <h2 id="pair-heading">Ghép nối host mới</h2>
      <QrScanner onResult={(text) => void doPair(text)} onError={(message) => setPairError(`Camera: ${message}`)} />
      <textarea
        ref={pairTextRef}
        value={pairText}
        onChange={(e) => setPairText(e.target.value)}
        placeholder="pidesk://pair#… hoặc https://li.quoc.app/#pair=…"
        aria-label="Pair link"
      />
      {pairError && <p className="notice error" role="alert">{pairError}</p>}
      {pairSuccess && <p className="notice success" role="status">{pairSuccess}</p>}
      <div className="pair-actions">
        <button className="primary" disabled={!pairText.trim()} onClick={() => void doPair(pairText)}>Ghép nối</button>
        {!policy.secure && <span className="notice">HTTP dev cho phép ws:// nội bộ; bản HTTPS production chỉ dùng wss:// qua Tailscale Serve.</span>}
      </div>
    </section>
  )

  const activeHost = hosts.find((host) => host.hostId === activeHostId)
  const activeConnection = connections.find((connection) => connection.hostId === activeHostId)
  const activeHostName = activeHost?.hostName ?? activeConnection?.conn.hello?.hostName ?? activeHostId ?? 'Chọn host'
  const activeHostState = hostStateView(activeHostId ? connStates[activeHostId] : undefined)

  const hostPicker = (
    <div className="host-picker" ref={hostPickerRef}>
      <button
        ref={hostPickerTriggerRef}
        className="host-trigger"
        aria-label={`Host: ${activeHostName}`}
        aria-haspopup="menu"
        aria-expanded={hostPickerOpen}
        onClick={() => setHostPickerOpen((open) => !open)}
      >
        <span className={`host-dot ${activeHostState.dotClass}`} role="img" aria-label={activeHostState.label} />
        <span className="host-label">{activeHostName}</span>
        <ChevronDown className="host-chevron" size={16} aria-hidden="true" />
      </button>
      {hostPickerOpen && (
        <div
          ref={hostMenuRef}
          className="host-menu"
          role="menu"
          aria-label="Chọn host"
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
            const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setHostPickerOpen(false)
              hostPickerTriggerRef.current?.focus()
            } else if (items.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next].focus()
            }
          }}
        >
          <p className="menu-heading">Host đã ghép</p>
          {hosts.map((host) => {
            const state = connStates[host.hostId]
            const { dotClass, label } = hostStateView(state)
            return (
              <button
                key={host.hostId}
                className="host-option"
                role="menuitemradio"
                aria-checked={host.hostId === activeHostId}
                onClick={() => {
                  setActiveHost(host.hostId)
                  void connectHost(host.hostId)
                  setHostPickerOpen(false)
                  hostPickerTriggerRef.current?.focus()
                }}
              >
                <span className={`host-dot ${dotClass}`} aria-hidden="true" />
                <span className="host-option-copy">
                  <strong>{host.hostName}</strong>
                  {!(state?.state === 'online' && !state?.detail && !state?.permissionDenied) && (
                    <small>{state?.permissionDenied ? state.detail : state?.state === 'online' ? (state?.detail ?? null) : state?.detail ? `${label} · ${state.detail}` : label}</small>
                  )}
                </span>
              </button>
            )
          })}
          <button className="menu-add" role="menuitem" onClick={() => { hostPickerTriggerRef.current?.focus(); openDialog('hosts') }}>
            Quản lý host
          </button>
          <button className="menu-add" role="menuitem" onClick={() => { hostPickerTriggerRef.current?.focus(); openDialog('pair') }}>
            + Thêm host
          </button>
        </div>
      )}
    </div>
  )

  const connected = connections.length > 0
  const dialogBody = dialogTab === 'hosts' ? hostsPanel : pairPanel

  return (
    <div className={connected ? 'li-web-root connected' : 'li-web-root empty-root'}>
      {connected ? (
        <Workbench connections={connections} hostPicker={hostPicker} />
      ) : (
        <main className="empty-state">
          <div className="empty-state-inner">
            <h2>{hosts.length === 0 ? 'Chưa có host được ghép nối' : 'Host chưa kết nối'}</h2>
            <p>{hosts.length === 0 ? 'Thêm một host LiX để mở phiên và tiếp tục công việc.' : 'Một host đã ghép nối nhưng chưa kết nối được. Mở quản lý host để thử lại.'}</p>
            <button type="button" onClick={() => openDialog(hosts.length === 0 ? 'pair' : 'hosts')}>
              {hosts.length === 0 ? 'Thêm host' : 'Quản lý host'}
            </button>
          </div>
        </main>
      )}
      <ModalDialog open={dialogOpen} onClose={closeDialog} label="Hosts & ghép nối">
        <div className="host-manager-panel">
          <h2 className="host-dialog-title">Host</h2>
          <div
            className="dialog-tabs"
            role="tablist"
            aria-label="Quản lý host"
            onKeyDown={(event) => {
              const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
              const current = tabs.indexOf(event.target as HTMLButtonElement)
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              tabs[next].focus()
              setDialogTab(next === 0 ? 'hosts' : 'pair')
            }}
          >
            <button id="host-tab-list" type="button" role="tab" aria-controls="host-tab-panel" aria-selected={dialogTab === 'hosts'} tabIndex={dialogTab === 'hosts' ? 0 : -1} onClick={() => setDialogTab('hosts')}>Đã ghép nối</button>
            <button id="host-tab-pair" type="button" role="tab" aria-controls="host-tab-panel" aria-selected={dialogTab === 'pair'} tabIndex={dialogTab === 'pair' ? 0 : -1} onClick={() => setDialogTab('pair')}>Ghép nối mới</button>
          </div>
          <div id="host-tab-panel" className="dialog-body" role="tabpanel" tabIndex={0} aria-labelledby={dialogTab === 'hosts' ? 'host-tab-list' : 'host-tab-pair'}>
            {dialogBody}
          </div>
        </div>
      </ModalDialog>
    </div>
  )
}
