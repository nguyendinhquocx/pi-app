// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '@shared/remote'
import { Timeline, keepAnchorWithin8px } from './Timeline'
import { emptyTimeline, olderPageIsStale, fetchOlderPageIfCurrent, prependOlder, apply, anchorAdjustment } from './timeline-store'
import type { SessionTimeline } from './timeline-store'

/**
 * Spec T3 acceptance: auto-page near top (one in-flight request), stale `turn.page` discard
 * after reset/reopen/host switch, older-error retry, aria-live off during bulk prepend,
 * jump-to-latest appears when the reader detaches from the bottom.
 */

afterEach(cleanup)

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_x',
    anchor: 'anchor_x',
    status: 'done',
    user: { text: 'msg' },
    activity: { counts: { read: 0, edit: 0, write: 0, run: 0, search: 0, think: 0, other: 0 }, failed: 0 },
    steps: [],
    answer: '',
    files: [],
    ...overrides,
  }
}

function scrollable(el: HTMLElement, top: number, height: number, client: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: client })
  el.scrollTop = top
}

describe('older-page lifecycle (spec T3)', () => {
  it('olderPageIsStale discards pages after reset, reopen and host switch', () => {
    const expected = { hostId: 'h1', sessionKey: 's1', firstAnchor: 'a1', generation: 7, timelineGeneration: 3 }
    // Same host/session/head/generation → fresh.
    expect(olderPageIsStale(expected, { activeHostId: 'h1', selectedSessionKey: 's1', firstAnchor: 'a1', generation: 7, timelineGeneration: 3 })).toBe(false)
    // timeline.reset emptied the timeline (no head anchor).
    expect(olderPageIsStale(expected, { activeHostId: 'h1', selectedSessionKey: 's1', firstAnchor: null, generation: 7, timelineGeneration: 4 })).toBe(true)
    // Another session selected on the same host.
    expect(olderPageIsStale(expected, { activeHostId: 'h1', selectedSessionKey: 's2', firstAnchor: 'a1', generation: 7, timelineGeneration: 3 })).toBe(true)
    // Host switch.
    expect(olderPageIsStale(expected, { activeHostId: 'h2', selectedSessionKey: 's1', firstAnchor: 'a1', generation: 8, timelineGeneration: 3 })).toBe(true)
    // A newer page already prepended another anchor on top.
    expect(olderPageIsStale(expected, { activeHostId: 'h1', selectedSessionKey: 's1', firstAnchor: 'a0', generation: 7, timelineGeneration: 3 })).toBe(true)
    // Reopen same session with same first anchor still invalidates prior request.
    expect(olderPageIsStale(expected, { activeHostId: 'h1', selectedSessionKey: 's1', firstAnchor: 'a1', generation: 8, timelineGeneration: 4 })).toBe(true)
  })

  it('a deferred turn.page response after reset/reopen is discarded and never committed', async () => {
    let resolvePage: (page: { turns: Turn[]; hasOlder: boolean }) => void = () => {}
    const pending = new Promise<{ turns: Turn[]; hasOlder: boolean }>((resolve) => { resolvePage = resolve })
    const expected = { hostId: 'h1', sessionKey: 's1', firstAnchor: 'a1', generation: 11, timelineGeneration: 3 }
    let actual = { activeHostId: 'h1', selectedSessionKey: 's1', firstAnchor: 'a1', generation: 11, timelineGeneration: 3 }
    const commit = vi.fn()

    const result = fetchOlderPageIfCurrent(() => pending, expected, () => actual, commit)
    // timeline.reset then reopen while RPC is pending; even the same anchor is invalidated.
    actual = { ...actual, timelineGeneration: 4 }
    resolvePage({ turns: [makeTurn({ id: 'stale', anchor: 'old-page' })], hasOlder: true })

    await expect(result).resolves.toBe(false)
    expect(commit).not.toHaveBeenCalled()
  })

  it('anchorAdjustment/keepAnchorWithin8px implement the ≤8px anchoring rule', () => {
    expect(anchorAdjustment(1000, 1300)).toBe(300)
    expect(keepAnchorWithin8px(1000, 1300)).toBe(300)
    expect(keepAnchorWithin8px(1000, 1006)).toBe(0)
  })

  it('prependOlder keeps order and dedupes even across generations', () => {
    let t = apply(emptyTimeline(), { op: 'turn.upsert', seq: 1, turn: makeTurn({ id: 't3', anchor: 'a3' }) }) as SessionTimeline
    t = prependOlder(t, [makeTurn({ id: 't2', anchor: 'a2' })], true)
    t = prependOlder(t, [makeTurn({ id: 't1', anchor: 'a1' }), makeTurn({ id: 't2', anchor: 'a2' })], false)
    expect(t.turns.map((x) => x.anchor)).toEqual(['a1', 'a2', 'a3'])
    expect(t.hasOlder).toBe(false)
  })
})

describe('Timeline auto-page + states (spec T3 UX contract)', () => {
  const actions = { onRewind: vi.fn(async () => undefined), onFork: vi.fn(async () => undefined), onToolDetail: vi.fn(async () => '') }
  const base = { ...emptyTimeline(), hasOlder: true, turns: [makeTurn({ id: 't1', anchor: 'a1', user: { text: 'old message' } })] }

  function renderTimeline(timeline: SessionTimeline, onLoadOlder: (sk: string, before: string) => Promise<void>) {
    render(<Timeline timeline={timeline} sessionKey="s1" actions={actions} onLoadOlder={onLoadOlder} />)
    return document.querySelector('.timeline') as HTMLElement
  }

  it('scrolling near the top triggers exactly one in-flight page load', async () => {
    let resolvePage: () => void = () => {}
    const pending = new Promise<void>((resolve) => { resolvePage = resolve })
    let calls = 0
    const onLoadOlder = vi.fn(async () => { calls += 1; await pending })
    const el = renderTimeline(base, onLoadOlder)

    scrollable(el, 0, 2000, 600)
    fireEvent.scroll(el)
    fireEvent.scroll(el)
    fireEvent.scroll(el)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    // Loading state silences the live region so the whole older page is never announced.
    expect(el.getAttribute('aria-live')).toBe('off')
    expect(document.body.textContent).toContain('Đang tải các lượt cũ hơn…')

    resolvePage()
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    // The log stays silent after the bulk prepend; only the short status region was announced.
    expect(el.getAttribute('aria-live')).toBe('off')
    expect(calls).toBe(1)
  })

  it('no fetch when history reached the end', () => {
    const onLoadOlder = vi.fn(async () => undefined)
    const el = renderTimeline({ ...base, hasOlder: false }, onLoadOlder)
    scrollable(el, 0, 2000, 600)
    fireEvent.scroll(el)
    expect(onLoadOlder).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Đầu phiên')
  })

  it('older-load failure shows a retry state; retry succeeds', async () => {
    let fails = true
    const onLoadOlder = vi.fn(async () => { if (fails) throw new Error('mất kết nối') })
    const el = renderTimeline(base, onLoadOlder)
    scrollable(el, 0, 2000, 600)
    fireEvent.scroll(el)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Không tải được lượt cũ hơn')
    expect(alert.textContent).toContain('mất kết nối')

    fails = false
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })

  it('leaving the bottom detaches follow-live and reveals jump-to-latest', () => {
    const el = renderTimeline(base, vi.fn(async () => undefined))
    expect(el.getAttribute('data-follow')).toBe('live')

    scrollable(el, 400, 2000, 600)
    fireEvent.scroll(el)
    expect(el.getAttribute('data-follow')).toBe('detached')
    expect(screen.getByRole('button', { name: 'Về cuối' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Về cuối' }))
    expect(el.getAttribute('data-follow')).toBe('live')
    expect(screen.queryByRole('button', { name: 'Về cuối' })).toBeNull()
  })

  it('tool failure keeps a readable state without the raw "error" label', async () => {
    const failed: SessionTimeline = {
      ...base,
      hasOlder: false,
      turns: [makeTurn({
        id: 't2',
        anchor: 'a2',
        steps: [{ id: 's1', kind: 'tool', toolCallId: 'c9', toolName: 'bash', category: 'run', status: 'error', node: { template: 'bash', title: 'bash', fields: {}, status: 'error', fallbackText: 'exit code 1' } }],
      })],
    }
    render(<Timeline timeline={failed} sessionKey="s1" actions={actions} onLoadOlder={vi.fn(async () => undefined)} />)
    expect(document.body.textContent).toContain('Thất bại')
    // The failure message/recovery stays directly visible (spec T3).
    expect(document.body.textContent).toContain('exit code 1')
    expect(screen.getByRole('button', { name: /bash/ }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /bash/ }))
    expect(screen.getByRole('button', { name: /bash/ }).getAttribute('aria-expanded')).toBe('true')
  })
})
