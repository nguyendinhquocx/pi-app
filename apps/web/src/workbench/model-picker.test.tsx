// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer, type ModelOption } from './Composer'

/**
 * Spec T4 acceptance: searchable model popover grouped by provider; every model the host
 * reports stays selectable; optimistic current model after `model.set`; keyboard combobox
 * (Arrow/Enter/Escape/Home/End) with focus return; concise no-result recovery.
 */

afterEach(cleanup)

const sessionKey = 'proj/s1.jsonl'

const MODELS: ModelOption[] = [
  { id: 'openai-codex/gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai-codex', group: 'custom' },
  { id: 'zai/glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'zai', group: 'apiKey' },
  { id: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', group: 'apiKey' },
  { id: 'antigravity/gemini-4-argon', name: 'Gemini 4 Argon', provider: 'antigravity', group: 'login' },
]

const baseActions = {
  onSend: vi.fn(async () => undefined),
  onAbort: vi.fn(async () => ({ aborted: true })),
  onDequeue: vi.fn(async () => []),
  onFileSearch: vi.fn(async () => []),
  onAttach: vi.fn(async () => ({ path: 'a', name: 'a', size: 1 })),
}

function renderComposer(models: ModelOption[], onSetModel: (id: string) => Promise<void>) {
  render(
    <Composer
      sessionKey={sessionKey}
      running={false}
      queue={{ steering: [], followUp: [] }}
      commands={[]}
      context={null}
      usage={null}
      model={MODELS[0].id}
      thinking={null}
      thinkingLevels={[]}
      models={models}
      onSetModel={onSetModel}
      onSetThinking={vi.fn()}
      actions={baseActions}
    />,
  )
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Model:/ }))
}

describe('Model picker (spec T4)', () => {
  it('renders every available model grouped by provider — none dropped', () => {
    renderComposer(MODELS, vi.fn(async () => undefined))
    openPicker()
    expect(document.activeElement).toBe(screen.getByLabelText('Tìm model'))
    const listbox = screen.getByRole('listbox', { name: 'Models' })
    expect(listbox).toBeTruthy()
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(MODELS.length)
    // Current model is marked.
    expect(options.find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('data-model-id')).toBe('openai-codex/gpt-6-luna')
    // Provider groups render as section labels.
    const text = listbox.textContent ?? ''
    for (const provider of ['openai-codex', 'zai', 'deepseek', 'antigravity']) expect(text).toContain(provider)
  })

  it('search filters by id/name/provider; no-result offers a concise recovery message', () => {
    renderComposer(MODELS, vi.fn(async () => undefined))
    openPicker()
    const input = screen.getByLabelText('Tìm model') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'deepseek' } })
    const options = within(screen.getByRole('listbox', { name: 'Models' })).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('DeepSeek Flash')

    fireEvent.change(input, { target: { value: 'zzz-nothing' } })
    expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Không có model khớp')
  })

  it('selection is optimistic: the trigger reflects the pick immediately, before the RPC resolves', async () => {
    let resolveSet: () => void = () => {}
    const onSetModel = vi.fn((id: string) => new Promise<void>((resolve) => { resolveSet = resolve }))
    renderComposer(MODELS, onSetModel)
    openPicker()
    fireEvent.click(screen.getByRole('option', { name: /GLM 5.3 Flash/ }))

    // Popover closed, trigger already shows the new model while model.set is still pending.
    expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull()
    const trigger = screen.getByRole('button', { name: /^Model:/ })
    expect(trigger.textContent).toContain('GLM 5.3 Flash')
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(onSetModel).toHaveBeenCalledWith('zai/glm-5.3-flash'))

    resolveSet()
    await waitFor(() => expect(trigger.getAttribute('aria-busy')).toBe('false'))
    // Successful selection remains optimistic even after the model.set request settles.
    expect(trigger.textContent).toContain('GLM 5.3 Flash')
  })

  it('Escape closes the popover and returns focus to the trigger', () => {
    renderComposer(MODELS, vi.fn(async () => undefined))
    openPicker()
    const input = screen.getByLabelText('Tìm model')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Model:/ }))
  })

  it('keyboard combobox: ArrowDown moves the active option, Enter picks it', async () => {
    const onSetModel = vi.fn(async () => undefined)
    renderComposer(MODELS, onSetModel)
    openPicker()
    const input = screen.getByLabelText('Tìm model')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSetModel).toHaveBeenCalledWith('deepseek/deepseek-flash'))
  })

  it('a failed model.set rolls the optimistic pick back and surfaces the error', async () => {
    const onSetModel = vi.fn(async () => { throw new Error('host từ chối') })
    renderComposer(MODELS, onSetModel)
    openPicker()
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek Flash/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('host từ chối'))
    // Trigger falls back to the previous model.
    expect(screen.getByRole('button', { name: /^Model:/ }).textContent).toContain('GPT-6 Luna')
  })
})
