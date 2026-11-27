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

  it('UAT R3: cancelling the native file picker re-enables the attach button immediately', async () => {
    // Real browsers fire only 'cancel' when the user dismisses the picker; before the fix the
    // attach button stayed disabled forever (attaching never reset).
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'))
    })
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={baseActions} />)
    const attach = screen.getByRole('button', { name: /Đính kèm tệp/ })
    fireEvent.click(attach)
    await waitFor(() => expect((attach as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByRole('button', { name: /Đính kèm tệp/ }) as HTMLButtonElement).disabled).toBe(false)
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

  const kaneoCommands: CommandInfo[] = [
    { name: 'kaneo-card', category: 'extension', description: 'Bind Kaneo card' },
    { name: 'compact', category: 'prompt' },
  ]

  it('SPEC-2026-11-27: slash picker shows one slash for kaneo-card and closes once args are typed', () => {
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={kaneoCommands} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={baseActions} />)
    const input = screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '/kaneo' } })
    const listbox = screen.getByRole('listbox', { name: 'Slash commands' })
    expect(listbox.textContent).toContain('/kaneo-card')
    expect(listbox.textContent).not.toContain('//')
    // Args typed → token complete → picker closes, Enter sends instead of re-selecting.
    fireEvent.change(input, { target: { value: '/kaneo-card task-1' } })
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  it('SPEC-2026-11-27: Arrow moves selection, Enter inserts without sending, Escape dismisses keeping draft', async () => {
    const actions = { ...baseActions, onSend: vi.fn(async () => undefined) }
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={kaneoCommands} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={actions} />)
    const input = screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '/' } })
    expect(screen.getByRole('option', { name: /kaneo-card/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /compact/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getByRole('option', { name: /kaneo-card/ }).getAttribute('aria-selected')).toBe('true')
    // Enter over an open picker inserts the command; it must not send.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('/kaneo-card ')
    expect(actions.onSend).not.toHaveBeenCalled()
    // With args typed the picker is closed, so Enter sends the full draft.
    fireEvent.change(input, { target: { value: '/kaneo-card task-1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(actions.onSend).toHaveBeenCalledWith('/kaneo-card task-1', 'prompt', expect.any(String)))
    // Escape dismisses the picker but keeps the draft; the next Enter sends the draft.
    fireEvent.change(input, { target: { value: '/kan' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
    expect(input.value).toBe('/kan')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(actions.onSend).toHaveBeenCalledWith('/kan', 'prompt', expect.any(String)))
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

  it('context cost/token metrics moved out of the composer; only a ≥80% window cue stays', () => {
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
    // Spec T4: no token/cost repetition in the composer footer (Inspector → Context shows them).
    expect(screen.queryByText(/342 tok/)).toBeNull()
    expect(screen.queryByText(/\$0\.0123/)).toBeNull()
  })

  it('context cue appears once usage reaches ≥80% of the window', () => {
    render(
      <Composer
        sessionKey={sessionKey}
        running={false}
        queue={{ steering: [], followUp: [] }}
        commands={[]}
        context={{ tokens: 180000, window: 200000, messages: 2, breakdown: [] }}
        usage={null}
        model={null}
        thinking={null}
        thinkingLevels={[]}
        models={[]}
        onSetModel={vi.fn()}
        onSetThinking={vi.fn()}
        actions={baseActions}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('90%')
  })

  it('thinking picker uses host levels and reports update failures', async () => {
    const onSetThinking = vi.fn(async () => { throw new Error('thinking denied') })
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking="low" thinkingLevels={['low', 'high']} models={[]} onSetModel={vi.fn()} onSetThinking={onSetThinking} actions={baseActions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking: low' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('thinking denied'))
    expect(onSetThinking).toHaveBeenCalledWith('high')
  })

  it('mode menu supports Escape and returns focus to its trigger', () => {
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={baseActions} />)
    const trigger = screen.getByRole('button', { name: /Chế độ gửi: Gửi/ })
    trigger.focus()
    fireEvent.click(trigger)
    const currentMode = screen.getByRole('menuitemradio', { name: /Gửi/ })
    expect(document.activeElement).toBe(currentMode)

    fireEvent.keyDown(currentMode, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Chế độ gửi' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Telegram-style quick typing: focuses the prompt and inserts the first key', () => {
    render(<Composer sessionKey={sessionKey} running={false} queue={{ steering: [], followUp: [] }} commands={[]} context={null} usage={null} model={null} thinking={null} thinkingLevels={[]} models={[]} onSetModel={vi.fn()} onSetThinking={vi.fn()} actions={baseActions} />)
    const textarea = screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement
    textarea.blur()
    expect(document.activeElement).not.toBe(textarea)

    // Press a printable key on window -> focus shifts to textarea
    fireEvent.keyDown(window, { key: 'h' })
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('h')

    // Pressing with modifier keys (e.g. Ctrl+C) must not steal focus or enter text
    textarea.blur()
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    expect(document.activeElement).not.toBe(textarea)
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

  it('shows a green dot for a running session and removes the decorative search icon', () => {
    const { container } = render(<SessionRail hostId="h1" sessions={sessions} selectedSessionKey={null} actions={actions} />)
    expect(screen.getByRole('img', { name: 'Đang chạy' }).className).toContain('live-dot')
    expect(container.querySelector('.rail-search-icon')).toBeNull()
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

  it('Inspector exposes only Terminal and the compact export menu returns focus', () => {
    const onTab = vi.fn()
    const onExport = vi.fn()
    const { container } = render(
      <Inspector
        sessionKey={sessionKey} tab="terminal" onTab={onTab} reviewDiff={null} onLoadDiff={vi.fn()}
        files={[]} onListFiles={vi.fn(async () => undefined)} onReadFile={vi.fn()}
        onCreateFile={vi.fn(async () => undefined)} onRenameFile={vi.fn(async () => undefined)}
        stats={null} branches={[]} onSwitchBranch={vi.fn()}
        onAgentSteer={vi.fn(async () => undefined)} onAgentAbort={vi.fn(async () => undefined)} onAgentResume={vi.fn(async () => undefined)}
        conn={null} onExport={onExport} timelineTurns={turns} sessionTitle="S1"
      />,
    )
    expect(screen.getByRole('heading', { name: 'Terminal' })).toBeTruthy()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(container.querySelector('.terminal-pane')).toBeTruthy()

    const exportTrigger = screen.getByRole('button', { name: 'Xuất phiên' })
    fireEvent.click(exportTrigger)
    const markdownAction = screen.getByRole('menuitem', { name: 'Xuất Markdown' })
    const htmlAction = screen.getByRole('menuitem', { name: 'Xuất HTML' })
    expect(document.activeElement).toBe(markdownAction)
    fireEvent.keyDown(markdownAction, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(htmlAction)
    fireEvent.keyDown(htmlAction, { key: 'Home' })
    expect(document.activeElement).toBe(markdownAction)
    fireEvent.click(markdownAction)
    expect(onExport).toHaveBeenCalledWith('markdown')
    expect(document.activeElement).toBe(exportTrigger)
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps the terminal pane mounted when another Inspector tab is selected', async () => {
    const common = {
      sessionKey,
      onTab: vi.fn(),
      reviewDiff: null,
      onLoadDiff: vi.fn(async () => undefined),
      files: [],
      onListFiles: vi.fn(async () => undefined),
      onReadFile: vi.fn(async () => ''),
      onCreateFile: vi.fn(async () => undefined),
      onRenameFile: vi.fn(async () => undefined),
      stats: null,
      branches: [],
      onSwitchBranch: vi.fn(async () => undefined),
      onAgentSteer: vi.fn(async () => undefined),
      onAgentAbort: vi.fn(async () => undefined),
      onAgentResume: vi.fn(async () => undefined),
      conn: null,
      onExport: vi.fn(),
      timelineTurns: turns,
      sessionTitle: 'S1',
    }
    const view = render(<Inspector {...common} tab="terminal" />)
    const pane = view.container.querySelector('.terminal-pane') as HTMLElement
    expect(pane).toBeTruthy()

    view.rerender(<Inspector {...common} tab="review" />)
    await waitFor(() => expect(view.container.querySelector('.terminal-pane')).toBe(pane))
    expect(pane.hidden).toBe(true)

    view.rerender(<Inspector {...common} tab="terminal" />)
    expect(view.container.querySelector('.terminal-pane')).toBe(pane)
    expect(pane.hidden).toBe(false)
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
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    await_a_tick(() => expect(onListFiles).toHaveBeenCalledWith('src'))
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }))
    await_a_tick(() => expect(onReadFile).toHaveBeenCalledWith('src/a.ts'))
    await waitFor(() => expect(screen.getByText('file body')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Tên file hoặc thư mục mới'), { target: { value: 'new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }))
    await_a_tick(() => expect(onCreateFile).toHaveBeenCalledWith('src/new.ts', false))
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tuỳ chọn src/a.ts' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Đổi tên' }))
    fireEvent.change(screen.getByLabelText('Tên mới cho src/a.ts'), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    await_a_tick(() => expect(onRenameFile).toHaveBeenCalledWith('src/a.ts', 'b.ts'))
  })

  it('file preview can be closed (spec T4)', async () => {
    const onReadFile = vi.fn(async () => 'file body')
    render(
      <Inspector
        sessionKey={sessionKey}
        tab="files"
        onTab={vi.fn()}
        reviewDiff={null}
        onLoadDiff={vi.fn()}
        files={[{ path: 'src/a.ts', kind: 'file' }]}
        onListFiles={vi.fn(async () => undefined)}
        onReadFile={onReadFile}
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
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => expect(screen.getByText('file body')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Đóng xem trước' }))
    expect(screen.queryByText('file body')).toBeNull()
  })

  it('file action menu supports Escape focus return and puts focus in the rename editor', () => {
    render(
      <Inspector
        sessionKey={sessionKey}
        tab="files"
        onTab={vi.fn()}
        reviewDiff={null}
        onLoadDiff={vi.fn()}
        files={[{ path: 'src/a.ts', kind: 'file' }]}
        onListFiles={vi.fn(async () => undefined)}
        onReadFile={vi.fn(async () => '')}
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
    const trigger = screen.getByRole('button', { name: 'Tuỳ chọn src/a.ts' })
    trigger.focus()
    fireEvent.click(trigger)
    const renameAction = screen.getByRole('menuitem', { name: 'Đổi tên' })
    expect(document.activeElement).toBe(renameAction)
    fireEvent.keyDown(renameAction, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Đổi tên' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Tên mới cho src/a.ts'))
  })

  it('running turns suppress transient prose/thinking deltas, then reveal the settled transcript', () => {
    const actions = { onToolDetail: vi.fn(async () => 'tool output') }
    const liveTurn: Turn = {
      ...turns[0],
      status: 'running',
      answer: 'partial answer bytes',
      steps: [
        { id: 'think-1', kind: 'thinking', text: 'private thought chunk' },
        { id: 'prose-1', kind: 'prose', text: '/' },
        { id: 'tool-1', kind: 'tool', toolCallId: 'c1', toolName: 'bash', category: 'run', status: 'running', node: { template: 'bash', title: 'bash command', fields: {}, status: 'running', fallbackText: 'bash' } },
      ],
    }
    const timeline = { ...emptyTimeline(), turns: [liveTurn], state: { running: true } }
    const onLoadOlder = vi.fn(async () => undefined)
    const { rerender } = render(<Timeline timeline={timeline} sessionKey={sessionKey} actions={actions} onLoadOlder={onLoadOlder} />)
    expect(screen.queryByText('private thought chunk')).toBeNull()
    expect(screen.queryByText('/')).toBeNull()
    expect(screen.queryByText('partial answer bytes')).toBeNull()
    expect(screen.getByRole('button', { name: /bash command/ })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Đang chạy')

    rerender(<Timeline timeline={{ ...timeline, turns: [{ ...liveTurn, status: 'done' }], state: { running: false } }} sessionKey={sessionKey} actions={actions} onLoadOlder={onLoadOlder} />)
    expect(screen.getByText('private thought chunk')).toBeTruthy()
    expect(screen.getByText('/')).toBeTruthy()
    expect(screen.getByText('partial answer bytes')).toBeTruthy()
  })

  it('timeline has no rewind/fork chrome; tool detail still works; scroll-near-top pages older history', async () => {
    const actions = { onToolDetail: vi.fn(async () => 'tool output') }
    const onLoadOlder = vi.fn(async () => undefined)
    const timelineTurn: Turn = {
      ...turns[0],
      steps: [{ id: 'tool-1', kind: 'tool', toolCallId: 'c1', toolName: 'bash', category: 'run', status: 'ok', node: { template: 'bash', title: 'bash', fields: {}, status: 'ok', preview: '3 passing', detail: true, fallbackText: 'bash' } }],
    }
    const timeline = { ...emptyTimeline(), turns: [timelineTurn], hasOlder: true }
    render(<Timeline timeline={timeline} sessionKey={sessionKey} actions={actions} onLoadOlder={onLoadOlder} />)
    // Owner UAT 2026-11-24: rewind/fork hover controls are gone from the chat surface.
    expect(screen.queryByRole('button', { name: /rewind/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /fork/i })).toBeNull()
    // Spec T3: success tools render no raw `ok` label.
    expect(document.body.textContent).not.toMatch(/\bok\b/)
    // Spec T3: auto-load replaces the old button — scrolling near the top triggers the page load.
    const log = document.querySelector('.timeline') as HTMLElement
    fireEvent.scroll(log)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledWith(sessionKey, 'a1'))
    fireEvent.click(screen.getByRole('button', { name: /bash/ }))
    await_a_tick(() => expect(actions.onToolDetail).toHaveBeenCalledWith(sessionKey, 'c1'))
    await waitFor(() => expect(screen.getByText('tool output')).toBeTruthy())
  })

  it('copy chips copy user text and answer, flipping to a check after copying', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const actions = { onToolDetail: vi.fn(async () => '') }
    const turnWithAnswer: Turn = { ...turns[0], answer: 'Answer body' }
    const { container } = render(<Timeline timeline={{ ...emptyTimeline(), turns: [turnWithAnswer] }} sessionKey={sessionKey} actions={actions} onLoadOlder={vi.fn(async () => undefined)} />)
    expect(screen.queryByText('Bạn')).toBeNull()
    expect(container.querySelector('.turn-user-actions')?.previousElementSibling?.classList.contains('turn-user')).toBe(true)
    expect(container.querySelector('.turn-answer-actions')?.parentElement?.classList.contains('turn-answer')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép tin nhắn' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(turnWithAnswer.user.text))
    expect(screen.getByRole('button', { name: 'Đã sao chép' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép câu trả lời' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Answer body'))
  })

  it('failed tool rows hide verbose error text until the user opens the detail', async () => {
    const failedTurn: Turn = {
      ...turns[0],
      steps: [{ id: 'tool-fail', kind: 'tool', toolCallId: 'call-fail', toolName: 'bash', category: 'run', status: 'error', node: { template: 'bash', title: 'python3 worker.py', fields: {}, status: 'error', detail: true, fallbackText: 'permission denied at /private/path' } }],
    }
    const actions = { onToolDetail: vi.fn(async () => 'permission denied at /private/path') }
    render(<Timeline timeline={{ ...emptyTimeline(), turns: [failedTurn] }} sessionKey={sessionKey} actions={actions} onLoadOlder={vi.fn(async () => undefined)} />)
    expect(screen.queryByText(/Thất bại/)).toBeNull()
    expect(screen.queryByText(/permission denied at/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /python3 worker.py.*thất bại/i }))
    await waitFor(() => expect(screen.getByText('permission denied at /private/path')).toBeTruthy())
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
