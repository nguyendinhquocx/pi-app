import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { Turn } from '@shared/remote'
import type { HostConnection } from '../transport/host-connection'
import { useWorkbench } from '../workbench/workbench-store'
import { Workbench } from '../workbench/Workbench'
import './workbench-preview.css'
import '../styles.css'

/**
 * Read-only visual fixture for responsive QA (spec T5). Reachable from the Vite dev server
 * only — never a build input. Every session/project/model below is synthetic demo data; the
 * fake connection answers a fixed script and never touches a real host.
 */

/** Visual-only fixture for the rail-footer menu; this never controls a real HostStore. */
function FixtureHostPicker() {
  const [open, setOpen] = useState(false)
  return (
    <div className="host-picker">
      <button className="host-trigger" aria-label="Host: Laptop (demo)" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="host-dot online" role="img" aria-label="Trực tuyến" />
        <span className="host-label">Laptop (demo)</span>
        <span className="host-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="host-menu" role="menu" aria-label="Hosts đã ghép">
          <p className="menu-heading">Host đã ghép</p>
          <button className="host-option" role="menuitemradio" aria-checked="true" onClick={() => setOpen(false)}>
            <span className="host-dot online" aria-hidden="true" />
            <span className="host-option-copy"><strong>Laptop (demo)</strong><small>Trực tuyến</small></span>
          </button>
          <button className="host-option" role="menuitemradio" aria-checked="false" onClick={() => setOpen(false)}>
            <span className="host-dot" aria-hidden="true" />
            <span className="host-option-copy"><strong>ProDesk (demo)</strong><small>Đang chờ kết nối</small></span>
          </button>
        </div>
      )}
    </div>
  )
}

const hostId = 'laptop-demo'
const sessionKey = 'D:/demo/project/.pi/agent/sessions/2026-11-18-demo.jsonl'
const MODEL = 'zai/glm-5.3-flash'

const MODELS = [
  { id: 'openai-codex/gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai-codex', group: 'custom' },
  { id: 'zai/glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'zai', group: 'apiKey' },
  { id: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', group: 'apiKey' },
  { id: 'antigravity/gemini-4-argon', name: 'Gemini 4 Argon', provider: 'antigravity', group: 'login' },
  { id: 'antigravity/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'antigravity', group: 'login' },
]

const counts = (n: number) => ({ read: n, edit: 1, write: 0, run: 1, search: 0, think: 1, other: 0 })

/** 100 synthetic turns: quiet tools, occasional running/error rows, real markdown answers. */
function makeDemoTurn(i: number): Turn {
  const running = i === 99
  const failed = i % 17 === 8
  const steps: Turn['steps'] = [
    { id: `think-${i}`, kind: 'thinking', text: `Demo reasoning step ${i}: check the fixture behavior, keep output synthetic.` },
    {
      id: `tool-${i}`,
      kind: 'tool',
      toolCallId: `call-${i}`,
      toolName: 'bash',
      category: 'run',
      status: running ? 'running' : failed ? 'error' : 'ok',
      node: {
        template: 'bash',
        title: `run fixture-check-${i}`,
        fields: {},
        status: running ? 'running' : failed ? 'error' : 'ok',
        preview: `fixture output for turn ${i}`,
        fallbackText: failed ? 'exit code 1' : 'ok',
      },
    },
  ]
  return {
    id: `turn_${i}`,
    anchor: `anchor-${i}`,
    status: running ? 'running' : failed ? 'failed' : 'done',
    startedAt: 1_763_000_000_000 + i * 1000,
    user: { text: `Demo prompt ${i}: exercising the long-session timeline fixture.` },
    activity: { counts: counts(i), failed: failed ? 1 : 0, ...(running ? { live: `tool-${i}` } : {}) },
    steps,
    answer: running ? 'Demo answer streaming…' : `Demo answer ${i} — **synthetic markdown** with \`code\` and a list:\n\n- item one\n- item two`,
    files: i % 9 === 0 ? [{ path: 'src/demo.ts', add: 12, del: 3 }] : [],
  }
}

const DEMO_TURNS = Array.from({ length: 100 }, (_, i) => makeDemoTurn(i))
const OLDER_PAGE = Array.from({ length: 20 }, (_, i) => makeDemoTurn(-20 + i))
const terminalListeners = new Set<(event: string, payload: unknown) => void>()

const fakeConnection = {
  hostId,
  state: 'online',
  online: true,
  errorDetail: null,
  hello: { hostId, hostName: 'Laptop (demo)', role: 'operator', ownerProtocol: 1 },
  bindEvents() {},
  subscribeEvents(listener: (event: string, payload: unknown) => void) {
    terminalListeners.add(listener)
    return () => { terminalListeners.delete(listener) }
  },
  openSession: async () => ({
    kind: 'snapshot', resync: true, turns: DEMO_TURNS, seq: 120,
    state: { running: true, model: MODEL, thinking: 'medium', queue: { steering: [], followUp: [] } },
    pendingUi: [], hasOlder: true,
  }),
  start() {},
  stop() {},
  dispose() {},
  request: async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'session.watchList') return { sessions: [
      { sessionKey, projectId: 'D:/demo/project', title: 'Fix parser edge case', status: 'running', updatedAt: 1_763_000_000_000, preview: 'Add URL parsing coverage' },
      { sessionKey: 'D:/demo/project/.pi/agent/sessions/older-demo.jsonl', projectId: 'D:/demo/project', title: 'Review release checklist', status: 'idle', updatedAt: 1_762_900_000_000 },
    ] }
    if (method === 'project.list') return { projects: [{ id: 'D:/demo/project', name: 'demo project' }] }
    if (method === 'file.list') return { entries: [{ path: 'src', name: 'src', dir: true }, { path: 'src/parser.ts', name: 'parser.ts', dir: false }, { path: 'README.md', name: 'README.md', dir: false }], truncated: false }
    if (method === 'session.stats') return { context: { tokens: 170000, window: 200000, messages: 218, breakdown: [{ role: 'user', tokens: 400 }, { role: 'assistant', tokens: 1280 }, { role: 'tool', tokens: 1740 }] }, usage: { input: 2000, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0.0241, calls: 7 } }
    if (method === 'command.list') return { commands: [{ name: 'review', category: 'skill', description: 'Review the current changes' }] }
    if (method === 'model.list') return { models: MODELS, current: MODEL, thinking: 'medium', availableThinking: ['off', 'low', 'medium', 'high'] }
    if (method === 'session.branches') return { branches: [{ leafId: 'main', title: 'Current branch', turns: 4, current: true }, { leafId: 'experiment', title: 'Try stricter parser', turns: 2, current: false }] }
    if (method === 'terminal.open') {
      queueMicrotask(() => {
        for (const listener of terminalListeners) listener('terminal.data', { terminalId: 'demo-terminal', data: '$ echo "Local fixture"\r\nLocal fixture\r\n$ ' })
      })
      return { terminalId: 'demo-terminal' }
    }
    if (method === 'review.diff') return { isRepo: true, branch: 'main', files: [{ path: 'src/parser.ts', add: 12, del: 3, status: 'modified' }] }
    if (method === 'file.read') return { content: 'export function parseUrl(input: string) { /* demo */ }', size: 54, truncated: false, mime: 'text/plain' }
    if (method === 'file.search') return { entries: [{ path: 'src/parser.ts', name: 'parser.ts', dir: false }] }
    if (method === 'skills.list') return { skills: [{ name: 'review', description: 'Review changes', enabled: true, source: 'global' }] }
    if (method === 'extensions.list') return { extensions: [{ name: 'subagent-tab', version: '1.2', loaded: true }] }
    if (method === 'host.status') return { appVersion: '0.7.13', platform: 'Windows', sdkVersion: '1.3.0', ownerProtocol: 1 }
    if (method === 'settings.cacheWarming.get') return { mode: 'streaming' }
    if (method === 'capability.list') return { capabilities: [{ id: 'bash', available: true, promptTokens: 0, tools: 1, enabled: true }] }
    if (method === 'turn.page') {
      // One synthetic older page for the long-session demo; ends history afterwards.
      const before = String(params.before ?? '')
      if (before.startsWith('anchor-0')) return { turns: OLDER_PAGE, hasOlder: false }
      return { turns: [], hasOlder: false }
    }
    if (method === 'model.set') return { model: String(params.modelId ?? MODEL) }
    if (method === 'thinking.set') return { thinking: String(params.level ?? 'medium') }
    return {}
  },
} as unknown as HostConnection

useWorkbench.setState({
  activeHostId: hostId,
  notice: null,
  slices: {
    [hostId]: {
      state: 'online', detail: null, role: 'operator', ownerProtocol: 1,
      projects: [{ id: 'D:/demo/project', name: 'demo-project' }],
      selectedProjectId: null,
      sessions: [
        { sessionKey, projectId: 'D:/demo/project', title: 'Fix parser edge case', status: 'running', updatedAt: 1_763_000_000_000, preview: 'Add URL parsing coverage' },
        { sessionKey: 'D:/demo/project/.pi/agent/sessions/older-demo.jsonl', projectId: 'D:/demo/project', title: 'Review release checklist', status: 'idle', updatedAt: 1_762_900_000_000 },
      ],
      selectedSessionKey: sessionKey,
      timelines: {
        [sessionKey]: {
          seq: 120,
          state: { running: true, model: MODEL, thinking: 'medium', queue: { steering: ['Demo steer waiting for the next turn'], followUp: [] }, todo: { title: 'Parser edge case', items: [{ id: '1', text: 'Add regression test', status: 'completed' }, { id: '2', text: 'Verify escaped paths', status: 'in_progress' }, { id: '3', text: 'Update docs', status: 'pending' }] } },
          pendingUi: [], hasOlder: true,
          turns: DEMO_TURNS,
        },
      },
    },
  },
})

document.documentElement.classList.remove('dark')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <>
    <div className="fixture-banner">LOCAL UI FIXTURE — synthetic demo data only, no host connected</div>
    <Workbench
      connections={[{ hostId, conn: fakeConnection }]}
      hostPicker={<FixtureHostPicker />}
    />
  </>,
)
