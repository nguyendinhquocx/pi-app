// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiResponseSchema, type UiResponse } from '@shared/remote'
import { ExtensionDialogs } from '../workbench/ExtensionDialogs'
import { normalizeUnknownCustomUiRequest } from '../transport/web-ui-request'

afterEach(cleanup)

describe('ExtensionDialogs (spec T4)', () => {
  it('unknown custom UI reaches a warning fallback card, with tool identity and redacted raw payload', async () => {
    const onCancel = vi.fn(async () => undefined)
    const raw = {
      id: 'u-unknown',
      sessionKey: 'proj/s.jsonl',
      method: 'custom',
      kind: 'vendor_action',
      extensionName: 'vendor-extension',
      toolName: 'dangerous_tool',
      apiToken: 'do-not-show-this',
      prompt: 'Need human input',
    }
    const unknown = normalizeUnknownCustomUiRequest(raw)
    if (!unknown) throw new Error('test fixture should satisfy fallback routing envelope')
    render(<ExtensionDialogs requests={[unknown]} sessionKey="proj/s.jsonl" actions={{ onRespond: vi.fn(async () => undefined), onCancel }} />)

    expect(screen.getByText('vendor-extension')).toBeTruthy()
    expect(screen.getByText('dangerous_tool')).toBeTruthy()
    expect(screen.getByText('Chưa hỗ trợ trên Web')).toBeTruthy()
    fireEvent.click(screen.getByText('Raw payload'))
    await waitFor(() => expect(screen.getByText(/apiToken/)).toBeTruthy())
    const rawText = document.querySelector('.fallback-raw pre')?.textContent ?? ''
    expect(rawText).toContain('[redacted]')
    expect(document.body.textContent).not.toContain('do-not-show-this')
    fireEvent.click(screen.getByText('Đóng'))
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith('u-unknown'))
  })

  it('host-local image_review path falls back honestly instead of showing a broken image', () => {
    const request = {
      id: 'u-image',
      sessionKey: 'proj/s.jsonl',
      method: 'custom',
      kind: 'image_review',
      image: 'D:/private/workspace/result.png',
      title: 'Review image',
      question: 'Looks right?',
      options: ['approve', 'revise'],
      allowFeedback: false,
    } as unknown as import('@shared/remote').UiRequest
    render(<ExtensionDialogs requests={[request]} sessionKey="proj/s.jsonl" actions={{ onRespond: vi.fn(async (_id: string, _response: Omit<UiResponse, 'id'>) => undefined), onCancel: vi.fn(async () => undefined) }} />)
    expect(screen.getByText('pi-image-gen')).toBeTruthy()
    expect(screen.getByText('Chưa hỗ trợ trên Web')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('ask_user_question returns the strict ExtensionUIQuestionnaireResult envelope', async () => {
    const onRespond = vi.fn(async (_id: string, _response: Omit<UiResponse, 'id'>) => undefined)
    const request = {
      id: 'u-question',
      sessionKey: 'proj/s.jsonl',
      method: 'custom',
      kind: 'ask_user_question',
      questions: [
        { question: 'Database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
        { question: 'Features?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }] },
      ],
    } as unknown as import('@shared/remote').UiRequest
    render(<ExtensionDialogs requests={[request]} sessionKey="proj/s.jsonl" actions={{ onRespond, onCancel: vi.fn(async () => undefined) }} />)
    fireEvent.click(screen.getByLabelText('SQLite'))
    fireEvent.click(screen.getByLabelText('Auth'))
    fireEvent.click(screen.getByLabelText('Search'))
    fireEvent.click(screen.getByRole('button', { name: 'Trả lời' }))

    await waitFor(() => expect(onRespond).toHaveBeenCalled())
    const response = onRespond.mock.calls[0][1]
    const parsed = UiResponseSchema.safeParse({ id: 'u-question', ...response })
    expect(parsed.success).toBe(true)
    expect(response).toEqual({
      result: {
        cancelled: false,
        answers: [
          { questionIndex: 0, question: 'Database?', kind: 'option', answer: 'SQLite' },
          { questionIndex: 1, question: 'Features?', kind: 'multi', answer: null, selected: ['Auth', 'Search'] },
        ],
      },
    })
  })
})
