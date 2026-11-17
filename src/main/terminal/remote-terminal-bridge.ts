// Remote terminal bridge (SPEC-2026-11-16-li-web T2): host PTYs for the remote gateway lane.
//
// Each opened terminal gets its own PtyManager so its output sink routes ONLY back through
// the gateway connection that opened it (never the renderer channels the desktop terminal
// drawer uses). Bounded: a small per-process cap keeps a runaway client from spawning PTYs.

import { PtyManager, type SpawnPty } from './pty-manager'
import { ptySpawn, terminalProfiles } from './terminal-service'

const MAX_REMOTE_TERMINALS = 8

type Entry = { mgr: PtyManager; id: string }

class RemoteTerminalBridge {
  private entries = new Map<string, Entry>()
  private seq = 0
  private spawnFn: SpawnPty | null = null

  private spawn(): SpawnPty {
    if (!this.spawnFn) this.spawnFn = ptySpawn()
    return this.spawnFn
  }

  get count(): number {
    return this.entries.size
  }

  open(projectId: string, opts: { cols: number; rows: number }, handlers: { data(id: string, data: string): void; exit(id: string, code: number): void }): string {
    if (this.entries.size >= MAX_REMOTE_TERMINALS) throw new Error('terminal_limit_reached')
    const profile = terminalProfiles()[0]
    if (!profile) throw new Error('no_shell_profile')
    const remoteId = `rt${++this.seq}`
    // One PtyManager per terminal: its sink translates the internal id to the remote id
    // the client knows, and nothing else can reach this PTY.
    const mgr = new PtyManager(this.spawn(), {
      data: (internalId, data) => {
        if (internalId === this.entries.get(remoteId)?.id) handlers.data(remoteId, data)
      },
      exit: (internalId, code) => {
        const e = this.entries.get(remoteId)
        if (e && e.id === internalId) {
          this.entries.delete(remoteId)
          handlers.exit(remoteId, code)
        }
      },
    }, () => process.env)
    const { id } = mgr.create(profile, { cwd: projectId, cols: opts.cols, rows: opts.rows })
    this.entries.set(remoteId, { mgr, id })
    return remoteId
  }

  private entryFor(remoteId: string): Entry | null {
    return this.entries.get(remoteId) ?? null
  }

  write(remoteId: string, data: string): void {
    const e = this.entryFor(remoteId)
    if (e) e.mgr.write(e.id, data)
  }

  resize(remoteId: string, cols: number, rows: number): void {
    const e = this.entryFor(remoteId)
    if (e) e.mgr.resize(e.id, cols, rows)
  }

  close(remoteId: string): void {
    const e = this.entries.get(remoteId)
    if (!e) return
    this.entries.delete(remoteId)
    e.mgr.killAll()
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }
}

/** Module-level singleton: remote PTYs survive gateway restarts like the desktop lane does. */
export const remoteTerminals = new RemoteTerminalBridge()
