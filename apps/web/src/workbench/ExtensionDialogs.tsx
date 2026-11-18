import { useState } from 'react'
import type { UiRequest, UiResponse } from '@shared/remote'
import { resolveAdapter, fallbackRawPayload, FALLBACK_NOTICE } from '../extensions/adapter-registry'
import type { WebUiRequest } from '../transport/web-ui-request'

export type DialogActions = {
  onRespond(id: string, response: Omit<UiResponse, 'id'>): Promise<void>
  onCancel(id: string): Promise<void>
}

export function ExtensionDialogs({ requests, sessionKey, actions }: { requests: WebUiRequest[]; sessionKey: string; actions: DialogActions }) {
  const visible = requests.filter((request) => request.sessionKey === sessionKey && request.method !== 'notify')
  if (visible.length === 0) return null
  return (
    <div className="extension-dialogs" role="region" aria-label="Extension dialogs">
      {visible.map((request) => <DialogCard key={request.id} request={request} actions={actions} />)}
    </div>
  )
}

function DialogCard({ request, actions }: { request: WebUiRequest; actions: DialogActions }) {
  const adapter = resolveAdapter(request)
  const respond = (response: Omit<UiResponse, 'id'>) => void actions.onRespond(request.id, response).catch(() => undefined)
  const cancel = () => void actions.onCancel(request.id).catch(() => undefined)

  if (adapter.kind === 'fallback') {
    const toolName = request.method === 'custom' && request.kind === 'unknown_custom' ? request.toolName : 'image_review'
    return (
      <div className="ext-dialog fallback-card" role="alert">
        <div className="fallback-head">
          <strong>{adapter.extension}</strong><span className="fallback-tool">{toolName}</span><span className="fallback-notice">{FALLBACK_NOTICE}</span>
        </div>
        <details className="fallback-raw"><summary>Raw payload</summary><pre>{fallbackRawPayload(request)}</pre></details>
        <button onClick={cancel}>Đóng</button>
      </div>
    )
  }
  if (request.method === 'select') return (
    <div className="ext-dialog">
      <strong>{request.title}</strong>
      <ul role="listbox">{request.options.map((option) => <li key={option}><button onClick={() => respond({ value: option })}>{option}</button></li>)}</ul>
      <button onClick={cancel}>Huỷ</button>
    </div>
  )
  if (request.method === 'confirm') return (
    <div className="ext-dialog">
      <strong>{request.title}</strong><p>{request.message}</p>
      <button className="primary" onClick={() => respond({ confirmed: true })}>Đồng ý</button>
      <button onClick={cancel}>Huỷ</button>
    </div>
  )
  if (request.method === 'input' || request.method === 'editor') return <InputDialog request={request} onRespond={respond} onCancel={cancel} />
  if (request.method === 'custom' && request.kind === 'ask_user_question') return <AskUserQuestions request={request} onRespond={respond} />
  if (request.method === 'custom' && request.kind === 'image_review') return <ImageReview request={request} onRespond={respond} onCancel={cancel} />
  return null
}

type InputRequest = Extract<UiRequest, { method: 'input' | 'editor' }>
function InputDialog({ request, onRespond, onCancel }: { request: InputRequest; onRespond(response: Omit<UiResponse, 'id'>): void; onCancel(): void }) {
  const [value, setValue] = useState(request.method === 'editor' ? request.prefill ?? '' : '')
  return (
    <div className="ext-dialog">
      <strong>{request.title}</strong>
      {request.method === 'input'
        ? <input value={value} placeholder={request.placeholder ?? ''} onChange={(event) => setValue(event.target.value)} aria-label={request.title} />
        : <textarea value={value} onChange={(event) => setValue(event.target.value)} aria-label={request.title} rows={6} />}
      <button className="primary" disabled={!value.trim()} onClick={() => onRespond({ value })}>Gửi</button>
      <button onClick={onCancel}>Huỷ</button>
    </div>
  )
}

type AskQuestionRequest = Extract<UiRequest, { method: 'custom'; kind: 'ask_user_question' }>
type QuestionnaireAnswer =
  | { questionIndex: number; question: string; kind: 'custom'; answer: string }
  | { questionIndex: number; question: string; kind: 'multi'; answer: null; selected: string[] }
  | { questionIndex: number; question: string; kind: 'option'; answer: string | null }

function AskUserQuestions({ request, onRespond }: { request: AskQuestionRequest; onRespond(response: Omit<UiResponse, 'id'>): void }) {
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const answers: QuestionnaireAnswer[] = request.questions.map((question, questionIndex) => {
    const customAnswer = (custom[questionIndex] ?? '').trim()
    if (customAnswer) return { questionIndex, question: question.question, kind: 'custom', answer: customAnswer }
    const chosen = selected[questionIndex] ?? []
    if (question.multiSelect) {
      return {
        questionIndex,
        question: question.question,
        kind: 'multi',
        answer: null,
        selected: question.options.map((option) => option.label).filter((label) => chosen.includes(label)),
      }
    }
    return { questionIndex, question: question.question, kind: 'option', answer: chosen[0] ?? null }
  })

  return (
    <div className="ext-dialog ask-user">
      {request.questions.map((question, index) => (
        <fieldset key={index}>
          <legend>{question.question}{question.header ? ` — ${question.header}` : ''}</legend>
          <ul role={question.multiSelect ? 'group' : 'radiogroup'}>
            {question.options.map((option) => (
              <li key={option.label}>
                <label>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`question-${request.id}-${index}`}
                    checked={(selected[index] ?? []).includes(option.label)}
                    onChange={() => {
                      setCustom((value) => ({ ...value, [index]: '' }))
                      setSelected((value) => {
                        const current = value[index] ?? []
                        const next = question.multiSelect
                          ? current.includes(option.label) ? current.filter((item) => item !== option.label) : [...current, option.label]
                          : [option.label]
                        return { ...value, [index]: next }
                      })
                    }}
                  />
                  <span>{option.label}</span>
                  {option.description && <span className="muted">{option.description}</span>}
                  {option.preview && <span className="muted">{option.preview}</span>}
                </label>
              </li>
            ))}
          </ul>
          <input
            aria-label={`Câu trả lời khác ${index + 1}`}
            value={custom[index] ?? ''}
            placeholder="Câu trả lời khác…"
            onChange={(event) => setCustom((value) => ({ ...value, [index]: event.target.value }))}
          />
        </fieldset>
      ))}
      <button className="primary" onClick={() => onRespond({ result: { cancelled: false, answers } })}>Trả lời</button>
    </div>
  )
}

function ImageReview({ request, onRespond, onCancel }: {
  request: Extract<UiRequest, { method: 'custom'; kind: 'image_review' }>
  onRespond(response: Omit<UiResponse, 'id'>): void
  onCancel(): void
}) {
  const [selected, setSelected] = useState<{ label: string; index: number } | null>(null)
  const [feedback, setFeedback] = useState('')
  const imageCanLoad = /^https?:\/\//i.test(request.image) || request.image.startsWith('data:') || request.image.startsWith('blob:')
  const choiceMap = ['approve', 'revise', 'reject', 'cancel']
  return (
    <div className="ext-dialog">
      <strong>{request.title}</strong>
      {imageCanLoad
        ? <img src={request.image} alt={request.title} />
        : <p className="notice">Ảnh nằm trên host và không được tải về trình duyệt; xem trước không khả dụng ở đây.</p>}
      <p>{request.question}</p>
      {request.context && <p className="muted">{request.context}</p>}
      <ul role="listbox">
        {request.options.map((option, index) => (
          <li key={option}><button aria-pressed={selected?.label === option} onClick={() => setSelected({ label: option, index })}>{option}</button></li>
        ))}
      </ul>
      {request.allowFeedback && <textarea aria-label="Feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Nhận xét thêm…" rows={2} />}
      <div className="dialog-actions">
        <button onClick={onCancel}>Huỷ</button>
        <button
          className="primary"
          disabled={!selected}
          onClick={() => selected && onRespond({ result: { choice: choiceMap[selected.index] ?? 'approve', label: selected.label, ...(request.allowFeedback && feedback ? { feedback } : {}) } })}
        >Xác nhận</button>
      </div>
    </div>
  )
}
