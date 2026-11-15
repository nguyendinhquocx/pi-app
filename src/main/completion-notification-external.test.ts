import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompletionEvent } from '@shared/app-events'
import { bindCompletionNotificationEvents, setExternalCompletionAlertProvider } from './completion-notification-events'
import { createCompletionNotificationController } from './completion-notification-controller'
import { UiRouter } from './remote/ui-router'
import { SessionHub } from './remote/session-hub'
import { FakeHost } from './remote/testing/fake-host'
import type { HostTimelineItem } from './remote/host-port'
import type { HubClient } from './remote/session-hub'

/**
 * External-session completion notifications, end to end over the REAL seam:
 * SessionHub synthesizes the CompletionEvent → completion-notification-events sink →
 * controller delivers (or drops). Toggled-off external alerts must not reach anything.
 */

let dir: string
let host: FakeHost
let hub: SessionHub
let clock = 1000
let fileSeq = 0
const now = (): number => clock

class FakeClient implements HubClient {
  readonly id = 'c1'
  sendEvent(): void {}
  queuePatches(): void {}
}

function mkItems(turns: Array<{ user: string; answer?: string; stop?: boolean | string }>): HostTimelineItem[] {
  const items: HostTimelineItem[] = []
  let e = 0
  for (const t of turns) {
    const entryId = `e${++e}`
    items.push({ id: `h-${entryId}`, type: 'user-message', text: t.user, sessionEntryId: entryId, timestamp: 1000 + e })
    if (t.answer !== undefined) {
      items.push({
        id: `h-${entryId}-a`,
        type: 'assistant-message',
        text: t.answer,
        sessionEntryId: `${entryId}-a`,
        timestamp: 1000 + e,
        ...(t.stop === false ? {} : { stopReason: typeof t.stop === 'string' ? t.stop : 'stop' }),
      })
    }
  }
  return items
}

async function addSession(items: HostTimelineItem[], mtimeMs: number): Promise<string> {
  const file = join(dir, '.pi', 'sessions', `ext-${++fileSeq}.jsonl`)
  host.sessions.set(file, {
    row: { sessionFile: file, projectId: dir, title: 'ext', createdAt: 1, updatedAt: 1 },
    items,
    running: false,
    model: 'm',
    thinking: 'high',
  })
  await mkdir(join(dir, '.pi', 'sessions'), { recursive: true })
  await writeFile(file, items.map((i) => JSON.stringify(i)).join('\n'), 'utf8')
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

async function touch(file: string, items: HostTimelineItem[], mtimeMs: number): Promise<void> {
  const s = host.sessions.get(file)
  if (s) s.items = items
  await writeFile(file, items.map((i) => JSON.stringify(i)).join('\n'), 'utf8')
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
}

// ── notification sink seam (what the controller would receive) ──

let completions: CompletionEvent[] = []
let unbindSink: (() => void) | null = null

beforeEach(() => {
  dir = ''
  clock = 1000
  completions = []
  setExternalCompletionAlertProvider(() => true)
  unbindSink = bindCompletionNotificationEvents({
    observeAppEvent: (event) => {
      if (event.type === 'completion') completions.push(event)
    },
    observeWorkerExit: () => {},
    visibleSessionChanged: () => {},
    foregroundChanged: () => {},
  })
})

afterEach(async () => {
  unbindSink?.()
  unbindSink = null
  setExternalCompletionAlertProvider(() => true)
  hub?.dispose()
  hub?.disposeExternalWatch()
  host?.dispose()
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function bootstrap(turns: Array<{ user: string; answer?: string; stop?: boolean | string }>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'lix-completion-'))
  host = new FakeHost({ projects: [dir] })
  hub = new SessionHub(host, new UiRouter(host, () => {}), () => [dir], now)
  const file = await addSession(mkItems(turns), 1000)
  const client = new FakeClient()
  await hub.open(client, file)
  return file
}

describe('SessionHub external completion synthesis', () => {
  it('first observation of an old (already settled) session only seeds — no notify', async () => {
    const file = await bootstrap([{ user: 'old', answer: 'already done' }])
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(0)
  })

  it('notifies exactly once when a running tail settles between two ticks', async () => {
    const file = await bootstrap([{ user: 'old', answer: 'done' }])
    await hub.onExternalChange(file) // seed: terminal tail
    expect(completions).toHaveLength(0)

    // A new turn appears, tail is non-terminal (still running).
    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 'new', answer: 'working…', stop: false }]), 4000)
    clock = 4000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(0)

    // The turn settles on disk: observed transition non-terminal → terminal.
    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 'new', answer: 'finished' }]), 5000)
    clock = 5000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({
      type: 'completion',
      outcome: 'success',
      settled: true,
      source: 'external-watcher',
      sessionFile: file,
      workspaceId: dir,
      runId: 'e2',
    })
    expect(completions[0].promptPreview).toBe('new')
    expect(completions[0].responsePreview).toBe('finished')

    // Reconciling again (same settled tail) must not re-notify.
    await touch(file, mkItems([{ user: 'old', answer: 'done EDITED' }, { user: 'new', answer: 'finished' }]), 6000)
    clock = 6000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(1)
  })

  it('notifies a new terminal turn that appears completely between two poll ticks', async () => {
    const file = await bootstrap([{ user: 'old', answer: 'already done' }])
    await hub.onExternalChange(file) // seed the old terminal baseline
    expect(completions).toHaveLength(0)

    await touch(file, mkItems([{ user: 'old', answer: 'already done' }, { user: 'fast', answer: 'finished before next poll' }]), 4000)
    clock = 4000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ runId: 'e2', responsePreview: 'finished before next poll' })
  })

  it('a branch switch from a non-terminal tail to another terminal turn does not notify', async () => {
    const file = await bootstrap([{ user: 'active branch', answer: 'working…', stop: false }])
    await hub.onExternalChange(file) // first observation: non-terminal turn e1

    const otherBranch = mkItems([{ user: 'older branch', answer: 'already done' }])
    otherBranch[0].sessionEntryId = 'branch-e2'
    await touch(file, otherBranch, 4000)
    clock = 4000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(0)
  })

  it('toolUse is not a terminal turn stop; the eventual stop transition notifies once', async () => {
    const file = await bootstrap([{ user: 'use tool', answer: '', stop: 'toolUse' }])
    await hub.onExternalChange(file) // toolUse closes only this assistant message, not the turn
    expect(completions).toHaveLength(0)

    await touch(file, mkItems([{ user: 'use tool', answer: 'finished', stop: 'stop' }]), 4000)
    clock = 4000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(1)
    expect(completions[0].outcome).toBe('success')
  })

  it('turn 2 of the same session still notifies (no dedupe drop across turns)', async () => {
    const file = await bootstrap([{ user: 'old', answer: 'done' }])
    await hub.onExternalChange(file)

    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 't2', answer: 'w', stop: false }]), 4000)
    clock = 4000
    await hub.onExternalChange(file)
    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 't2', answer: 'ok2' }]), 5000)
    clock = 5000
    await hub.onExternalChange(file)
    expect(completions.map((c) => c.runId)).toEqual(['e2'])

    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 't2', answer: 'ok2' }, { user: 't3', answer: 'w', stop: false }]), 6000)
    clock = 6000
    await hub.onExternalChange(file)
    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 't2', answer: 'ok2' }, { user: 't3', answer: 'ok3' }]), 7000)
    clock = 7000
    await hub.onExternalChange(file)
    expect(completions.map((c) => c.runId)).toEqual(['e2', 'e3'])
  })

  it('a heuristic running→idle flip (no stopReason) never notifies', async () => {
    const file = await bootstrap([{ user: 'work', answer: undefined }])
    clock = 3000
    await hub.onExternalChange(file) // running (tool tail, fresh mtime)

    clock = 91_500 // silence: backstop flips idle WITHOUT a disk read
    const flips = await hub.onWatchTick(new Map())
    expect(flips).toEqual([{ sessionFile: file, running: false }])
    expect(completions).toHaveLength(0)

    // A later reconcile still sees a non-terminal tail: still no notification.
    clock = 92_000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(0)
  })

  it('toggle off: no completion is synthesized at all', async () => {
    setExternalCompletionAlertProvider(() => false)
    const file = await bootstrap([{ user: 'old', answer: 'done' }])
    await hub.onExternalChange(file)

    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 't2', answer: 'w', stop: false }]), 4000)
    clock = 4000
    await hub.onExternalChange(file)
    await touch(file, mkItems([{ user: 'old', answer: 'done' }, { user: 't2', answer: 'ok' }]), 5000)
    clock = 5000
    await hub.onExternalChange(file)
    expect(completions).toHaveLength(0)
  })
})

// ── controller delivery policy ──

function makeController(settings: Partial<{ alertOnExternalSessions: boolean; alertOnBackgroundRunIdle: boolean; onlyWhenUnfocused: boolean; visible: string | null; minimized: boolean; focused: boolean }>) {
  const delivered: unknown[] = []
  const ctrl = createCompletionNotificationController({
    now: () => clock,
    delayMs: 0,
    getSettings: () => ({
      soundEnabled: true,
      notificationEnabled: true,
      alertOnRunIdle: true,
      alertOnBackgroundRunIdle: settings.alertOnBackgroundRunIdle ?? false,
      alertOnRunFailed: true,
      alertOnCancelled: false,
      timeoutSeconds: 15,
      previewMode: 'fixed',
      onlyWhenUnfocused: settings.onlyWhenUnfocused ?? true,
      dndUntil: null,
      delivery: 'auto',
      language: 'vi',
      alertOnExternalSessions: settings.alertOnExternalSessions ?? true,
    }),
    getWindowState: () => ({ focused: settings.focused ?? true, visible: settings.focused ?? true, minimized: settings.minimized ?? false }),
    getVisibleSessionFile: () => settings.visible ?? null,
    projectLabel: () => 'proj',
    deliver: (card) => delivered.push(card),
  })
  return { ctrl, delivered }
}

const flush = () => new Promise((r) => setTimeout(r, 5))

function externalEvent(runId: string): CompletionEvent {
  return {
    type: 'completion',
    outcome: 'success',
    settled: true,
    sessionFile: 'C:/work/ext.jsonl',
    workspaceId: 'C:/work',
    runId,
    source: 'external-watcher',
    seq: 0,
    timestamp: clock,
  }
}

describe('controller delivery for external completions', () => {
  it('delivers while minimized / another session visible (gates bypassed for external)', async () => {
    const { ctrl, delivered } = makeController({ visible: null, minimized: true, focused: false })
    ctrl.handleCompletion(externalEvent('e2'))
    await flush()
    expect(delivered).toHaveLength(1)
  })

  it('does NOT deliver when the user is looking at that session (unfocused-only)', async () => {
    const { ctrl, delivered } = makeController({ visible: 'C:/work/ext.jsonl', minimized: false, focused: true })
    ctrl.handleCompletion(externalEvent('e2'))
    await flush()
    expect(delivered).toHaveLength(0)
  })

  it('notifies once per turn; turn 2 has a different dedupe key and still delivers', async () => {
    const { ctrl, delivered } = makeController({ visible: null, minimized: true })
    ctrl.handleCompletion(externalEvent('e2'))
    await flush()
    ctrl.handleCompletion(externalEvent('e2')) // same anchor: deduped
    await flush()
    ctrl.handleCompletion(externalEvent('e3')) // next turn: delivered
    await flush()
    expect(delivered).toHaveLength(2)
  })

  it('toggle off drops the external completion entirely (no inbox, no deliver)', async () => {
    const { ctrl, delivered } = makeController({ visible: null, minimized: true, alertOnExternalSessions: false })
    ctrl.handleCompletion(externalEvent('e2'))
    await flush()
    expect(delivered).toHaveLength(0)
    expect(ctrl.listInbox()).toHaveLength(0)
  })

  it('slot regression: background slot completion stays gated by alertOnBackgroundRunIdle', async () => {
    const { ctrl, delivered } = makeController({ visible: null, minimized: true, alertOnBackgroundRunIdle: false })
    ctrl.handleCompletion({ ...externalEvent('e2'), source: undefined }) // slot completion: no source
    await flush()
    expect(delivered).toHaveLength(0)

    const { ctrl: withBackground, delivered: delivered2 } = makeController({ visible: null, minimized: true, alertOnBackgroundRunIdle: true })
    withBackground.handleCompletion({ ...externalEvent('e2'), source: undefined })
    await flush()
    expect(delivered2).toHaveLength(1)
  })
})
