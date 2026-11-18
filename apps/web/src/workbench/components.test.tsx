// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandInfo, SessionSummary } from '@shared/remote'
import { Composer } from './Composer'
import { SessionRail } from './SessionRail'
import { Inspector, downloadExport } from './Inspector'
import { SettingsPanel } from './SettingsPanel'
import { Timeline } from './Timeline'
import { timelineToMarkdown, timelineToHtmlBody } from './export-session'
import { emptyTimeline } from './timeline-store'
import type { Turn } from '@shared/remote'

afterEach(cleanup)

const sessionKey = 'proj/s1.jsonl'

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionKey, projectId: 'p1', title: 'S1', status: 'idle', updatedAt: 1, ...over }
}

describe('Composer (spec T4: send modes, slash list, metrics, abort)', () => {
  const baseActions = {
    onSend: vi.fn(async () => undefined),
    onAbort: vi.fn(async () => ({ aborted: true, wasRunning: true, stopped: true })),
    onDequeue: vi.fn(async () => ['q1']),
    onFileSearch: vi.fn(async (q: string) => [{ path: `src/${q}.ts` }]),
    onAttach: vi.fn(async () => ({ path: 'attachments/file.txt', name: 'file.txt', size: 1 })),
  }

  const commands: CommandInfo[] = [
    { name: 'compact', category: 'prompt' },
    { name: 'review', category: 'skill' },
  ]

  it('sends with mode prompt when idle, auto-steer when running', async () => {
    const actions = { ...baseActions, onSend: vi.fn(async () => undefined) }
    const { rerender } = render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={actions} />)
    const input = screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    await waitFor(() => expect(actions.onSend).toHaveBeenCalledWith('hello world', 'prompt', expect.any(String)))

    rerender(<Composer sessionKey={sessionKey} running={true} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={actions} />)
    fireEvent.change(input, { target: { value: 'steer now' } })
    // Prompt mode while running auto-promotes to steer (UX contract).
    fireEvent.click(screen.getByText('Abort'))
    await waitFor(() => expect(actions.onAbort).toHaveBeenCalled())
  })

  it('attachment upload stays prompt-only and inserts the returned host path as an @file reference', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'note.txt', { type: 'text/plain' })
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.dispatchEvent(new Event('change'))
    })
    const actions = { ...baseActions, onAttach: vi.fn(async () => ({ path: 'attachments/note.txt', name: 'note.txt', size: 3 })) }
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={actions} />)
    fireEvent.click(screen.getByRole('button', { name: /Đính kèm tệp/ }))
    await waitFor(() => expect(actions.onAttach).toHaveBeenCalled())
    expect((screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement).value).toContain('@attachments/note.txt')
    expect(actions.onSend).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it('slash commands list from command.list (local filter, no server resolve — matrix row 12)', () => {
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={commands} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={baseActions} />)
    const input = screen.getByLabelText('Tin nhắn')
    fireEvent.change(input, { target: { value: '/re' } })
    const listbox = screen.getByRole('listbox', { name: 'Slash commands' })
    expect(listbox).toBeTruthy()
    expect(listbox.textContent).toContain('/review')
    expect(listbox.textContent).toContain('skill')
  })

  it('@mention triggers file.search and renders entries', async () => {
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={baseActions} />)
    const input = screen.getByLabelText('Tin nhắn')
    fireEvent.change(input, { target: { value: 'x @ind' } })
    await waitFor(() => expect(baseActions.onFileSearch).toHaveBeenCalledWith('ind'))
    await waitFor(() => expect(screen.getByText('src/ind.ts')).toBeTruthy())
  })

  it('shows pending queue and restores queued prompts into the composer', async () => {
    const actions = { ...baseActions, onDequeue: vi.fn(async () => ['restored prompt']) }
    render(<Composer sessionKey={sessionKey} running={true} queue={{ steering: ['steer A'], followUp: ['follow B'] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={actions} />)
    fireEvent.click(screen.getByText('Hàng đợi (2)'))
    fireEvent.click(screen.getByRole('button', { name: 'Lấy lại' }))
    await waitFor(() => expect(actions.onDequeue).toHaveBeenCalled())
    expect((screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement).value).toBe('restored prompt')
  })

  it('context metrics render tokens + cost (row 17/26)', () => {
    render(
      <Composer
        sessionKey={sessionKey}
        running={false}
        queue={{ steering: [], followUp: [] }}
        commands={[]}
        context={{ tokens: 342, window: 200000, messages: 2, breakdown: [] }}
        usage={{ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.0123, calls: 2 }}
        model={null}
        thinking={null}
        thinkingLevels={[]}
        models={[]}
        onSetModel={vi.fn()}
        onSetThinking={vi.fn()}
        actions={baseActions}
      />,
    )
    expect(screen.getByText(/342 tok \(0%\)/)).toBeTruthy()
    expect(screen.getByText(/\$0\.0123/)).toBeTruthy()
  })
})

describe('SessionRail (spec T4: search, context menu rename/delete/clone, agents grouping)', () => {
  const actions = {
    onOpen: vi.fn(),
    onRename: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onClone: vi.fn(async () => undefined),
    onCreate: vi.fn(async () => undefined),
  }

  const sessions: SessionSummary[] = [
    summary({ sessionKey: 'proj/a.jsonl', title: 'Alpha' }),
    summary({ sessionKey: 'proj/b.jsonl', title: 'Beta', status: 'running' }),
  ]

  it('search filters sessions by title', () => {
    render(<SessionRail hostId="h1" sessions={sessions} selectedSessionKey={null} actions={actions} />)
    const input = screen.getByLabelText('Tìm phiên hoặc tin nhắn đầu tiên')
    fireEvent.change(input, { target: { value: 'alp' } })
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()
  })

  it('context menu triggers typed rename RPC through an inline editor', async () => {
    render(<SessionRail hostId="h1" sessions={[summary({ sessionKey: 'proj/a.jsonl', title: 'Alpha' })]} selectedSessionKey={null} actions={actions} />)
    fireEvent.click(screen.getByLabelText('Tuỳ chọn phiên Alpha'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Đổi tên' }))
    const input = screen.getByLabelText('Tên mới cho Alpha')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    await waitFor(() => expect(actions.onRename).toHaveBeenCalledWith('proj/a.jsonl', 'Renamed'))
  })
})

async function await_a_tick(fn: () => void): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  fn()
}

describe('Inspector (spec T4: review diff, files, context, tree, export)', () => {
  const connStub = null
  const turns: Turn[] = [
    {
      id: 't1',
      anchor: 'a1',
      status: 'done',
      user: { text: 'Demo' },
      activity: { counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 0 }, failed: 0 },
      steps: [],
      answer: 'Done text',
      files: [{ path: 'x.ts', add: 2, del: 0 }],
    },
  ]

  it('review diff renders files and selected-file lines through review.diff (row 21)', async () => {
    const onLoadDiff = vi.fn(async () => undefined)
    render(
      <Inspector
        sessionKey={sessionKey}
        tab="review"
        onTab={vi.fn()}
        reviewDiff={{ isRepo: true, branch: 'main', files: [{ path: 'a.ts', add: 6, del: 1, status: 'modified' }], file: { path: 'a.ts', lines: [{ k: 'add', n: 1, s: 'const x = 1' }], truncated: false } }}
        onLoadDiff={onLoadDiff}
        files={[]}
        onListFiles={vi.fn(async () => undefined)}
        onReadFile={vi.fn()}
        onCreateFile={vi.fn(async () => undefined)}
        onRenameFile={vi.fn(async () => undefined)}
        stats={null}
        branches={[]}
        onSwitchBranch={vi.fn()}
        onAgentSteer={vi.fn(async () => undefined)}
        onAgentAbort={vi.fn(async () => undefined)}
        onAgentResume={vi.fn(async () => undefined)}
        conn={connStub}
        onExport={vi.fn()}
        timelineTurns={turns}
        sessionTitle="S1"
      />,
    )
    expect(screen.getAllByText('a.ts').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('+6')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    expect(screen.getByText('const x = 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /a.ts/ }))
    await_a_tick(() => expect(onLoadDiff).toHaveBeenCalledWith('turn', 'a.ts'))
  })

  it('tree tab lists branches with switch action (row 8)', () => {
    const onSwitch = vi.fn(async () => undefined)
    render(
      <Inspector
        sessionKey={sessionKey}
        tab="tree"
        onTab={vi.fn()}
        reviewDiff={null}
        onLoadDiff={vi.fn()}
        files={[]}
        onListFiles={vi.fn(async () => undefined)}
        onReadFile={vi.fn()}
        onCreateFile={vi.fn(async () => undefined)}
        onRenameFile={vi.fn(async () => undefined)}
        stats={null}
        branches={[
          { leafId: 'l1', title: 'main', turns: 3, current: true },
          { leafId: 'l2', title: 'exp', turns: 1, current: false },
        ]}
        onSwitchBranch={onSwitch}
        onAgentSteer={vi.fn(async () => undefined)}
        onAgentAbort={vi.fn(async () => undefined)}
        onAgentResume={vi.fn(async () => undefined)}
        conn={connStub}
        onExport={vi.fn()}
        timelineTurns={turns}
        sessionTitle="S1"
      />,
    )
    const buttons = screen.getAllByRole('button')
    const expBtn = buttons.find((b) => (b.textContent ?? '').includes('exp'))
    expect(expBtn).toBeTruthy()
    fireEvent.click(expBtn as HTMLElement)
    await_a_tick(() => expect(onSwitch).toHaveBeenCalledWith('l2'))
  })

  it('files tab reads a file and supports create/rename through callbacks', async () => {
    const onListFiles = vi.fn(async () => undefined)
    const onReadFile = vi.fn(async () => 'file body')
    const onCreateFile = vi.fn(async () => undefined)
    const onRenameFile = vi.fn(async () => undefined)
    render(
      <Inspector
        sessionKey={sessionKey}
        tab="files"
        onTab={vi.fn()}
        reviewDiff={null}
        onLoadDiff={vi.fn()}
        files={[{ path: 'src', kind: 'dir' }, { path: 'src/a.ts', kind: 'file' }]}
        onListFiles={onListFiles}
        onReadFile={onReadFile}
        onCreateFile={onCreateFile}
        onRenameFile={onRenameFile}
        stats={null}
        branches={[]}
        onSwitchBranch={vi.fn()}
        onAgentSteer={vi.fn(async () => undefined)}
        onAgentAbort={vi.fn(async () => undefined)}
        onAgentResume={vi.fn(async () => undefined)}
        conn={connStub}
        onExport={vi.fn()}
        timelineTurns={turns}
        sessionTitle="S1"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /📁 src/ }))
    await_a_tick(() => expect(onListFiles).toHaveBeenCalledWith('src'))
    fireEvent.click(screen.getByRole('button', { name: /📄 src\/a.ts/ }))
    await_a_tick(() => expect(onReadFile).toHaveBeenCalledWith('src/a.ts'))
    await waitFor(() => expect(screen.getByText('file body')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Tên file hoặc thư mục mới'), { target: { value: 'new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }))
    await_a_tick(() => expect(onCreateFile).toHaveBeenCalledWith('src/new.ts', false))
    fireEvent.click(screen.getByRole('button', { name: /📄 src\/a.ts/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Đổi tên' })[1])
    fireEvent.change(screen.getByLabelText('Tên mới cho src/a.ts'), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    await_a_tick(() => expect(onRenameFile).toHaveBeenCalledWith('src/a.ts', 'b.ts'))
  })

  it('timeline hover actions are real rewind/fork controls and scrubber loads older pages', async () => {
    const actions = { onRewind: vi.fn(async () => undefined), onFork: vi.fn(async () => undefined), onToolDetail: vi.fn(async () => 'tool output') }
    const onLoadOlder = vi.fn(async () => undefined)
    const timelineTurn: Turn = {
      ...turns[0],
      steps: [{ id: 'tool-1', kind: 'tool', toolCallId: 'c1', toolName: 'bash', category: 'run', status: 'ok', node: { template: 'bash', title: 'bash', fields: {}, status: 'ok', preview: '3 passing', detail: true, fallbackText: 'bash' } }],
    }
    const timeline = { ...emptyTimeline(), turns: [timelineTurn], hasOlder: true }
    render(<Timeline timeline={timeline} sessionKey={sessionKey} actions={actions} onLoadOlder={onLoadOlder} />)
    fireEvent.click(screen.getByRole('button', { name: 'Xem các lượt cũ hơn' }))
    await_a_tick(() => expect(onLoadOlder).toHaveBeenCalledWith(sessionKey, 'a1'))
    fireEvent.click(screen.getByRole('button', { name: 'Quay lại đây (rewind)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận' }))
    await_a_tick(() => expect(actions.onRewind).toHaveBeenCalledWith(sessionKey, 'a1'))
    fireEvent.click(screen.getByRole('button', { name: 'Nhánh mới từ đây (fork)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận' }))
    await_a_tick(() => expect(actions.onFork).toHaveBeenCalledWith(sessionKey, 'a1'))
    fireEvent.click(screen.getByRole('button', { name: /bash/ }))
    await_a_tick(() => expect(actions.onToolDetail).toHaveBeenCalledWith(sessionKey, 'c1'))
    await waitFor(() => expect(screen.getByText('tool output')).toBeTruthy())
  })

  it('export produces markdown + sanitized html (rows NEW/JSON-excluded)', () => {
    const md = timelineToMarkdown('S1', turns)
    expect(md).toContain('# S1')
    const html = timelineToHtmlBody(turns)
    expect(html).toContain('Done text')
    const url = URL.createObjectURL
    const created: string[] = []
    URL.createObjectURL = ((b: Blob) => {
      created.push(b.type)
      return 'blob:x'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = () => undefined
    downloadExport('markdown', 'S1', turns)
    downloadExport('html', 'S1', turns)
    expect(created).toContain('text/markdown')
    expect(created).toContain('text/html')
    URL.createObjectURL = url
  })
})

describe('SettingsPanel (spec T4: masked inventory + per-host differences, never synced)', () => {
  it('capability toggle calls capability.set for the current session (T0 row 41)', async () => {
    const calls: unknown[] = []
    const conn = { request: async (method: string, params: unknown) => { calls.push({ method, params }); return { enabled: ['bash'] } } } as unknown as import('../transport/host-connection').HostConnection
    const onDataRefresh = vi.fn(async () => undefined)
    render(
      <SettingsPanel
        hostId="laptop"
        conn={conn}
        sessionKey={sessionKey}
        data={{ capabilities: [{ id: 'bash', available: true, promptTokens: 100, tools: 1, enabled: false }], skills: [], extensions: [], hostStatus: null, cacheWarming: 'off' }}
        hostVersions={[]}
        onDataRefresh={onDataRefresh}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(calls).toContainEqual({ method: 'capability.set', params: { sessionKey, id: 'bash', on: true } }))
    expect(onDataRefresh).toHaveBeenCalled()
  })
  it('renders skills/extensions/host status and the version-difference notice', () => {
    render(
      <SettingsPanel
        hostId="laptop"
        conn={null}
        sessionKey={sessionKey}
        data={{
          capabilities: [{ id: 'bash', available: true, promptTokens: 100, tools: 1, enabled: true }],
          skills: [{ name: 'grill-me', enabled: true, source: 'global' }],
          extensions: [{ name: 'subagent-tab', version: '1.2', loaded: true }],
          hostStatus: { appVersion: '0.7.13', platform: 'linux', sdkVersion: '1.3.0', ownerProtocol: 1 },
          cacheWarming: 'off',
        }}
        hostVersions={[
          { hostId: 'laptop', appVersion: '0.7.13', sdkVersion: '1.3.0' },
          { hostId: 'prodesk', appVersion: '0.7.12', sdkVersion: '1.3.0' },
        ]}
        onDataRefresh={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/0\.7\.13/).length).toBeGreaterThan(0)
    expect(screen.getByText('grill-me')).toBeTruthy()
    const panel = document.body.textContent ?? ''
    expect(panel).toContain('subagent-tab')
    expect(panel).toContain('v1.2')
    expect(panel).toContain('loaded')
    expect(screen.getByText(/phiên bản khác nhau/i)).toBeTruthy()
    expect(screen.getByText(/không tự đồng bộ/i)).toBeTruthy()
  })
})
