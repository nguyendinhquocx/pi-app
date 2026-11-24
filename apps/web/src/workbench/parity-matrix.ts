import type { RemoteMethod } from '@shared/remote'

/**
 * Browser parity matrix (spec T4), frozen to the 46-row T0 inventory. Each feature is either
 * implemented with a real existing test file or explicitly excluded with a concrete reason.
 * Rows are split where T0 combined a supported read path with a missing write path.
 */
export type MatrixStatus = 'browser-ready' | 'excluded'
export type MatrixRow = {
  /** T0 numeric row; suffixes split one T0 row into explicit capabilities. */
  t0: string
  feature: string
  status: MatrixStatus
  methods: RemoteMethod[]
  /** Test path relative to apps/web/src. Required for browser-ready rows. */
  test?: string
  /** Required for excluded rows. */
  reason?: string
}

export const PARITY_MATRIX: MatrixRow[] = [
  { t0: '1', feature: 'Project/session sidebar: list, search, create', status: 'browser-ready', methods: ['project.list', 'session.watchList', 'session.create', 'session.open'], test: 'workbench/components.test.tsx' },
  { t0: '2', feature: 'Session context menu: rename/delete/clone', status: 'browser-ready', methods: ['session.rename', 'session.delete', 'session.clone'], test: 'workbench/components.test.tsx' },
  { t0: '3', feature: 'Home view / temporary-chat sandbox', status: 'excluded', methods: [], reason: 'Desktop sandbox-folder concept; no remote RPC in v1.' },
  { t0: '4', feature: 'Timeline: turns, markdown, code, state patches', status: 'browser-ready', methods: ['session.open', 'turn.page'], test: 'workbench/timeline-store.test.ts' },
  { t0: '5', feature: 'Tool cards and detail previews', status: 'browser-ready', methods: ['turn.toolDetail'], test: 'workbench/components.test.tsx' },
  { t0: '6', feature: 'Message actions: rewind and fork', status: 'excluded', methods: [], reason: 'Owner UAT 2026-11-24 removed the rewind/fork hover chrome from the chat surface; turn.rewind/session.fork stay available host-side but have no web UI.' },
  { t0: '7', feature: 'Timeline older-page scrubber', status: 'browser-ready', methods: ['turn.page'], test: 'workbench/components.test.tsx' },
  { t0: '8', feature: 'Session tree / branch overlay', status: 'browser-ready', methods: ['session.branches', 'session.switchBranch', 'turn.rewind'], test: 'workbench/branch-flow.test.ts' },
  { t0: '9', feature: 'Fork overlay', status: 'browser-ready', methods: ['session.fork', 'session.clone'], test: 'workbench/branch-flow.test.ts' },
  { t0: '10', feature: 'Tree inspector panel', status: 'browser-ready', methods: ['session.branches', 'session.switchBranch'], test: 'workbench/components.test.tsx' },
  { t0: '11', feature: 'Composer send/steer/follow-up/abort/dequeue', status: 'browser-ready', methods: ['turn.send', 'turn.abort', 'turn.dequeue'], test: 'workbench/components.test.tsx' },
  { t0: '12', feature: 'Slash command discovery (server-side resolve excluded)', status: 'browser-ready', methods: ['command.list'], test: 'workbench/components.test.tsx' },
  { t0: '13', feature: 'File @-mention search', status: 'browser-ready', methods: ['file.search'], test: 'workbench/components.test.tsx' },
  { t0: '14', feature: 'Prompt-only attachments ≤10 MiB', status: 'browser-ready', methods: ['attachment.upload'], test: 'features/upload.test.ts' },
  { t0: '15', feature: 'Model picker', status: 'browser-ready', methods: ['model.list', 'model.set'], test: 'workbench/components.test.tsx' },
  { t0: '16', feature: 'Thinking picker', status: 'browser-ready', methods: ['model.list', 'thinking.set'], test: 'workbench/components.test.tsx' },
  { t0: '17', feature: 'Context/cost metrics', status: 'browser-ready', methods: ['session.stats'], test: 'workbench/components.test.tsx' },
  { t0: '18a', feature: 'Pending steer/follow-up queue and dequeue', status: 'browser-ready', methods: ['turn.dequeue'], test: 'workbench/components.test.tsx' },
  { t0: '18b', feature: 'Manual compaction controls', status: 'excluded', methods: [], reason: 'Compact RPC is missing in mutations v1; host-side auto-compaction remains active.' },
  { t0: '19a', feature: 'Agents view: subagent tool run, progress/result, steer/abort/resume', status: 'browser-ready', methods: ['turn.toolDetail', 'turn.send', 'turn.abort'], test: 'workbench/subagent-flow.test.tsx' },
  { t0: '19b', feature: 'Deep navigation into child-session JSONL', status: 'excluded', methods: [], reason: 'T2 SessionSummary has no child→parent identity; Agents view stays on the parent tool step. Dedicated child-session RPC is tracked as remote gap #9.' },
  { t0: '20', feature: 'Voice input ASR', status: 'excluded', methods: [], reason: 'Host-local audio capture; N/A for the browser PWA.' },
  { t0: '21a', feature: 'Review diff view', status: 'browser-ready', methods: ['review.diff'], test: 'workbench/components.test.tsx' },
  { t0: '21b', feature: 'Review stage/unstage', status: 'excluded', methods: [], reason: 'Stage/unstage RPC is absent from frozen T2 mutations v1; web shows the read-only diff.' },
  { t0: '22', feature: 'Git branch status bar', status: 'excluded', methods: [], reason: 'Git branch-status RPC is missing in mutations v1.' },
  { t0: '23', feature: 'Files list/read/preview', status: 'browser-ready', methods: ['file.list', 'file.read'], test: 'workbench/components.test.tsx' },
  { t0: '24', feature: 'Files create/rename', status: 'browser-ready', methods: ['file.create', 'file.rename'], test: 'workbench/components.test.tsx' },
  { t0: '25', feature: 'Run state and live timeline', status: 'browser-ready', methods: ['session.open'], test: 'workbench/connection-states.test.ts' },
  { t0: '26', feature: 'Context inspector', status: 'browser-ready', methods: ['session.stats'], test: 'workbench/components.test.tsx' },
  { t0: '27', feature: 'Remote terminal PTY (OSC 52 host clipboard write blocked)', status: 'browser-ready', methods: ['terminal.open', 'terminal.input', 'terminal.resize', 'terminal.close'], test: 'workbench/terminal-pane.test.tsx' },
  { t0: '28', feature: 'Browser tool panel (~30 channels)', status: 'excluded', methods: [], reason: 'Desktop browser panel is a desktop-lane surface; N/A for Web v1.' },
  { t0: '29', feature: 'Split view', status: 'excluded', methods: [], reason: 'Desktop renderer-local window management.' },
  { t0: '30', feature: 'Desktop tray/status/update chrome', status: 'excluded', methods: [], reason: 'Native desktop chrome; Web supplies its own connection-state banner.' },
  { t0: '31', feature: 'Command palette', status: 'excluded', methods: [], reason: 'Palette semantics are missing server-side; slash command discovery remains available.' },
  { t0: '32', feature: 'Host status, usage and cache-warming settings', status: 'browser-ready', methods: ['host.status', 'session.stats', 'settings.cacheWarming.get', 'settings.cacheWarming.set'], test: 'workbench/components.test.tsx' },
  { t0: '33', feature: 'Appearance/theme editor', status: 'excluded', methods: [], reason: 'Custom CSS/theme editor is host-local and outside remote mutations v1; Web uses the fixed LiX token set and OS theme preference.' },
  { t0: '34', feature: 'Pi runtime/SDK settings', status: 'excluded', methods: [], reason: 'Host-local SDK settings panel; no remote mutation in v1.' },
  { t0: '35', feature: 'Provider/model settings', status: 'excluded', methods: [], reason: 'Provider keys are host-local secrets; never rendered or editable in the browser.' },
  { t0: '36', feature: 'Model routing editor', status: 'excluded', methods: [], reason: 'Host-local routing config; no remote mutation in v1.' },
  { t0: '37a', feature: 'Skill catalog and per-session enable/disable', status: 'browser-ready', methods: ['skills.list', 'skills.setEnabled'], test: 'workbench/components.test.tsx' },
  { t0: '37b', feature: 'Skills/prompts file management', status: 'excluded', methods: [], reason: 'File editing of host-local skills/prompts is excluded; only session enable/disable ships.' },
  { t0: '38a', feature: 'Masked extension inventory', status: 'browser-ready', methods: ['extensions.list'], test: 'workbench/components.test.tsx' },
  { t0: '38b', feature: 'Extension install/uninstall', status: 'excluded', methods: [], reason: 'Install/uninstall is host-local by policy; inventory contains names/versions/status only.' },
  { t0: '39', feature: 'MCP settings and diagnostics', status: 'excluded', methods: [], reason: 'Host-local MCP config/diagnostics; no remote mutation in v1.' },
  { t0: '40', feature: 'Adapter settings panels', status: 'excluded', methods: [], reason: 'Adapter config is host-local; unsupported adapter interactions use the warning fallback card.' },
  { t0: '41', feature: 'Per-session capability picker', status: 'browser-ready', methods: ['capability.list', 'capability.set'], test: 'workbench/components.test.tsx' },
  { t0: '42', feature: 'UI-block widgets (chart/gantt/etc.)', status: 'excluded', methods: [], reason: 'Desktop widget runtime; unknown interactions fall back instead of executing host UI code in Web.' },
  { t0: '43', feature: 'Adapter side panels', status: 'excluded', methods: [], reason: 'Desktop adapter panels; Web displays the explicit unsupported fallback card.' },
  { t0: '44a', feature: 'Read-only session todo state', status: 'browser-ready', methods: ['session.open'], test: 'workbench/timeline-store.test.ts' },
  { t0: '44b', feature: 'Adapter todo widget host and mutations', status: 'excluded', methods: [], reason: 'Desktop widget host is not embedded in Web; only the host-projected todo state is shown.' },
  { t0: '45a', feature: 'Built-in extension dialogs', status: 'browser-ready', methods: ['ui.respond', 'ui.cancel'], test: 'extensions/ExtensionDialogs.test.tsx' },
  { t0: '45b', feature: 'ask_user_question adapter', status: 'browser-ready', methods: ['ui.respond'], test: 'extensions/ExtensionDialogs.test.tsx' },
  { t0: '45c', feature: 'image_review: URL/data images; host-local image path uses fallback', status: 'browser-ready', methods: ['ui.respond'], test: 'extensions/ExtensionDialogs.test.tsx' },
  { t0: '45d', feature: 'Unknown extension UI fallback card', status: 'browser-ready', methods: ['ui.cancel'], test: 'extensions/ExtensionDialogs.test.tsx' },
  { t0: '46', feature: 'Extension config/MCP diagnostics', status: 'excluded', methods: [], reason: 'Host-local config and diagnostics; only masked inventory is exposed.' },
  { t0: 'NEW', feature: 'Connected/disconnected/owner-busy state', status: 'browser-ready', methods: ['host.hello'], test: 'workbench/connection-states.test.ts' },
  { t0: 'NEW', feature: 'Session export Markdown/HTML', status: 'browser-ready', methods: ['turn.page'], test: 'workbench/components.test.tsx' },
  { t0: 'NEW', feature: 'Session export raw JSON', status: 'excluded', methods: [], reason: 'session.export contract drift (T0 gap #11) is frozen out of v1 pending owner confirmation; Markdown/HTML export is client-side.' },
]

export function browserReadyRows(): MatrixRow[] {
  return PARITY_MATRIX.filter((row) => row.status === 'browser-ready')
}

export function excludedRows(): MatrixRow[] {
  return PARITY_MATRIX.filter((row) => row.status === 'excluded')
}

function normalizeTestPath(path: string): string {
  return path.replace(/^(\.\.\/|\.\/)+/, '').replace(/\\/g, '/')
}

/** Structural + optional real-file release gate. Tests pass the discovered source test paths. */
export function validateMatrix(testPaths?: readonly string[]): string[] {
  const errors: string[] = []
  const available = testPaths ? new Set(testPaths.map(normalizeTestPath)) : null
  for (const row of PARITY_MATRIX) {
    if (row.status === 'browser-ready' && !row.test) errors.push(`row ${row.t0} (${row.feature}): browser-ready but no test`)
    if (row.status === 'excluded' && !row.reason) errors.push(`row ${row.t0} (${row.feature}): excluded but no reason`)
    if (row.status === 'excluded' && row.methods.length > 0) errors.push(`row ${row.t0} (${row.feature}): excluded row declares RPC methods`)
    if (row.status === 'browser-ready' && available && row.test && !available.has(normalizeTestPath(row.test))) {
      errors.push(`row ${row.t0} (${row.feature}): test file does not exist: ${row.test}`)
    }
  }
  return errors
}
