import { useState } from 'react'
import type { HostConnection } from '../transport/host-connection'

/**
 * Settings panel (spec T4 parity v1): skills on/off per session, masked extensions inventory,
 * host status, cache warming — with per-host version differences shown, never synced.
 * Host-local settings excluded from the matrix render as excluded pointers.
 */

export type SettingsData = {
  capabilities: { id: string; available: boolean; reason?: string; promptTokens: number; tools: number; enabled: boolean }[]
  skills: { name: string; description?: string; enabled: boolean; source?: string }[]
  extensions: { name: string; version?: string; loaded: boolean }[]
  hostStatus: { appVersion: string; platform: string; sdkVersion: string; ownerProtocol?: number } | null
  cacheWarming: 'off' | 'streaming' | 'idle' | null
}

export async function loadSettings(conn: HostConnection, sessionKey: string): Promise<SettingsData> {
  const [capabilities, skills, extensions, hostStatus, cacheWarming] = await Promise.all([
    conn.request('capability.list', { sessionKey }),
    conn.request('skills.list', { sessionKey }),
    conn.request('extensions.list', {}),
    conn.request('host.status', {}),
    conn.request('settings.cacheWarming.get', {}),
  ])
  return { capabilities: capabilities.capabilities, skills: skills.skills, extensions: extensions.extensions, hostStatus, cacheWarming: cacheWarming.mode }
}

export function SettingsPanel({
  hostId,
  conn,
  sessionKey,
  data,
  hostVersions,
  onDataRefresh,
}: {
  hostId: string
  conn: HostConnection | null
  sessionKey: string
  data: SettingsData | null
  /** appVersion of OTHER paired hosts, for the per-host difference display (never auto-synced). */
  hostVersions: { hostId: string; appVersion: string; sdkVersion: string }[]
  onDataRefresh(): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const others = hostVersions.filter((h) => h.hostId !== hostId)
  const versionDiff = data?.hostStatus && others.some((o) => o.appVersion !== '?' && o.appVersion !== data.hostStatus?.appVersion)

  return (
    <div className="settings-panel" aria-label={`Cài đặt host ${hostId}`}>
      <h3>Host: {hostId}</h3>
      {versionDiff && (
        <p className="notice">Hosts khác phiên bản khác nhau — settings là host-local, không tự đồng bộ.</p>
      )}
      {others.length > 0 && (
        <details className="host-version-diff">
          <summary>So sánh phiên bản các host</summary>
          <ul>
            <li>{hostId}: app {data?.hostStatus?.appVersion ?? '?'} · sdk {data?.hostStatus?.sdkVersion ?? '?'}</li>
            {others.map((o) => (
              <li key={o.hostId}>{o.hostId}: app {o.appVersion} · sdk {o.sdkVersion}</li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}
      {!data && <div className="empty">{busy ? 'Đang tải…' : 'Chưa tải settings.'}</div>}
      {data && (
        <>
          <section>
            <h4>Host status</h4>
            <p className="muted">
              app {data.hostStatus?.appVersion ?? '?'} · sdk {data.hostStatus?.sdkVersion ?? '?'} · owner protocol {data.hostStatus?.ownerProtocol ?? 'n/a'}
            </p>
          </section>
          <section>
            <h4>Capabilities (this session)</h4>
            <ul>
              {data.capabilities.map((cap) => (
                <li key={cap.id}>
                  <label title={cap.available ? `${cap.tools} tools · ${cap.promptTokens} prompt tokens` : cap.reason}>
                    <input
                      type="checkbox"
                      checked={cap.enabled}
                      disabled={!conn || busy || !cap.available}
                      onChange={(event) =>
                        void run(async () => {
                          if (!conn) return
                          await conn.request('capability.set', { sessionKey, id: cap.id, on: event.currentTarget.checked })
                          await onDataRefresh()
                        })
                      }
                    />
                    {cap.id}
                    {!cap.available && <span className="muted"> — {cap.reason ?? 'không khả dụng'}</span>}
                  </label>
                </li>
              ))}
              {data.capabilities.length === 0 && <li className="empty">Không có capability nào.</li>}
            </ul>
          </section>
          <section>
            <h4>Skills (theo session)</h4>
            <ul>
              {data.skills.map((s) => (
                <li key={s.name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={!conn || busy}
                      onChange={() =>
                        void run(async () => {
                          if (!conn) return
                          await conn.request('skills.setEnabled', { sessionKey, name: s.name, on: !s.enabled })
                          await onDataRefresh()
                        })
                      }
                    />
                    {s.name} <span className="muted">{s.source ?? ''}</span>
                  </label>
                </li>
              ))}
              {data.skills.length === 0 && <li className="empty">Không có skill nào.</li>}
            </ul>
          </section>
          <section>
            <h4>Extensions (masked inventory)</h4>
            <ul>
              {data.extensions.map((e) => (
                <li key={e.name}>
                  {e.name} {e.version ? `v${e.version}` : ''} <span className="muted">{e.loaded ? 'loaded' : 'not loaded'}</span>
                </li>
              ))}
              {data.extensions.length === 0 && <li className="empty">Không có extension nào.</li>}
            </ul>
          </section>
          <section>
            <h4>Cache warming</h4>
            <select
              aria-label="Cache warming mode"
              value={data.cacheWarming ?? 'off'}
              disabled={!conn || busy}
              onChange={(event) =>
                void run(async () => {
                  if (!conn) return
                  const mode = event.currentTarget.value as 'off' | 'streaming' | 'idle'
                  await conn.request('settings.cacheWarming.set', { mode })
                  await onDataRefresh()
                })
              }
            >
              <option value="off">off</option>
              <option value="streaming">streaming</option>
              <option value="idle">idle</option>
            </select>
          </section>
          <p className="notice">
            Cài đặt SDK/models/MCP/extensions-install là host-local (loại trừ trong parity matrix) — chỉ xem được trên desktop.
          </p>
        </>
      )}
    </div>
  )
}
