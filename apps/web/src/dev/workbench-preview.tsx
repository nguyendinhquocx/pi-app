import React from 'react'
import ReactDOM from 'react-dom/client'
import type { HostConnection } from '../transport/host-connection'
import { useWorkbench } from '../workbench/workbench-store'
import { Workbench } from '../workbench/Workbench'
import './workbench-preview.css'
import '../styles.css'

// Read-only visual fixture for responsive QA only. This file is reachable from Vite dev server
// and is intentionally not a build input or public asset. All session/project data below is fake.
const hostId = 'laptop-demo'
const sessionKey = 'D:/demo/project/.pi/agent/sessions/2026-11-18-demo.jsonl'
const fakeConnection = {
  hostId,
  state: 'online',
  online: true,
  errorDetail: null,
  hello: { hostId, hostName: 'Laptop (demo)', role: 'operator', ownerProtocol: 1 },
  bindEvents() {},
  start() {},
  stop() {},
  request: async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'session.watchList') return { sessions: [
      { sessionKey, projectId: 'D:/demo/project', title: 'Fix parser edge case', status: 'running', updatedAt: 1_763_000_000_000, preview: 'Add URL parsing coverage' },
      { sessionKey: 'D:/demo/project/.pi/agent/sessions/older-demo.jsonl', projectId: 'D:/demo/project', title: 'Review release checklist', status: 'idle', updatedAt: 1_762_900_000_000 },
    ] }
    if (method === 'project.list') return { projects: [{ id: 'D:/demo/project', name: 'demo project' }] }
    if (method === 'file.list') return { entries: [{ path: 'src', name: 'src', dir: true }, { path: 'src/parser.ts', name: 'parser.ts', dir: false }, { path: 'README.md', name: 'README.md', dir: false }], truncated: false }
    if (method === 'session.stats') return { context: { tokens: 3420, window: 200000, messages: 18, breakdown: [{ role: 'user', tokens: 400 }, { role: 'assistant', tokens: 1280 }, { role: 'tool', tokens: 1740 }] }, usage: { input: 2000, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0.0241, calls: 7 } }
    if (method === 'command.list') return { commands: [{ name: 'review', category: 'skill', description: 'Review the current changes' }] }
    if (method === 'model.list') return { models: [{ id: 'openai-codex/gpt-6-luna', name: 'GPT-6 Luna' }], current: 'openai-codex/gpt-6-luna', thinking: 'medium', availableThinking: ['low', 'medium', 'high'] }
    if (method === 'session.branches') return { branches: [{ leafId: 'main', title: 'Current branch', turns: 4, current: true }, { leafId: 'experiment', title: 'Try stricter parser', turns: 2, current: false }] }
    if (method === 'terminal.open') return { terminalId: 'demo-terminal' }
    if (method === 'review.diff') return { isRepo: true, branch: 'main', files: [{ path: 'src/parser.ts', add: 12, del: 3, status: 'modified' }] }
    if (method === 'file.read') return { content: 'export function parseUrl(input: string) { /* demo */ }', size: 54, truncated: false, mime: 'text/plain' }
    if (method === 'file.search') return { entries: [{ path: 'src/parser.ts', name: 'parser.ts', dir: false }] }
    if (method === 'skills.list') return { skills: [{ name: 'review', description: 'Review changes', enabled: true, source: 'global' }] }
    if (method === 'extensions.list') return { extensions: [{ name: 'subagent-tab', version: '1.2', loaded: true }] }
    if (method === 'host.status') return { appVersion: '0.7.13', platform: 'Windows', sdkVersion: '1.3.0', ownerProtocol: 1 }
    if (method === 'settings.cacheWarming.get') return { mode: 'streaming' }
    if (method === 'capability.list') return { capabilities: [{ id: 'bash', available: true, promptTokens: 0, tools: 1, enabled: true }] }
    return {}
  },
} as unknown as HostConnection

const count = { read: 1, edit: 1, write: 0, run: 1, search: 0, think: 1, other: 0 }
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
          seq: 6,
          state: { running: true, model: 'openai-codex/gpt-6-luna', thinking: 'medium', queue: { steering: [], followUp: [] }, todo: { title: 'Parser edge case', items: [{ id: '1', text: 'Add regression test', status: 'completed' }, { id: '2', text: 'Verify escaped paths', status: 'in_progress' }] } },
          pendingUi: [], hasOlder: true,
          turns: [
            {
              id: 'turn_1', anchor: 'anchor-1', status: 'running', startedAt: 1_763_000_000_000,
              user: { text: 'Add coverage for URLs with escaped spaces and query strings' },
              activity: { counts: count, failed: 0, live: 'tool-1' },
              steps: [
                { id: 'thinking-1', kind: 'thinking', text: 'Check existing parser behavior and preserve the current link rules.' },
                { id: 'tool-1', kind: 'tool', toolCallId: 'call-1', toolName: 'read', category: 'read', status: 'ok', node: { template: 'read', title: 'Read src/parser.ts', fields: {}, status: 'ok', preview: 'parseUrl(input) → normalized URL', fallbackText: 'Read parser source' } },
                { id: 'agent-1', kind: 'tool', toolCallId: 'call-agent', toolName: 'subagent_tab', category: 'other', status: 'running', node: { template: 'tree', title: 'Review URL edge cases', fields: {}, status: 'running', preview: 'Checking escaped-space behavior…', fallbackText: 'Subagent is checking parser edge cases' } },
              ],
              answer: 'I found one URL edge case and am validating the regression test.',
              files: [{ path: 'src/parser.ts', add: 12, del: 3 }],
              meta: { model: 'openai-codex/gpt-6-luna', thinking: 'medium' },
            },
          ],
        },
      },
    },
  },
})

document.documentElement.classList.remove('dark')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <>
    <div className="fixture-banner">LOCAL UI FIXTURE — data is illustrative, no host connected</div>
    <Workbench connections={[{ hostId, conn: fakeConnection }]} />
  </>,
)
