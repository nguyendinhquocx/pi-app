# Li Web — T0 Baseline (SPEC-2026-11-16-li-web)

Collected: 2026-11-16, status-only commands only. No credentials, no mutation.
Matrix chi tiết: xem section "Capability matrix" cuối file (scout-lix-surface đã quét renderer/main/remote).

## Runtime versions (verified this run)

| Item | Laptop | ProDesk | Note |
|---|---|---|---|
| `li --version` | 1.3.0 (source 46ddc71954) | 1.3.0 (source b0d59811fe) | **Source commit khác nhau → runtime drift giữa hai host** |
| pi-mono-li SDK (source tree) | 1.3.0 | n/a | Lease code có ở đây |
| LiX repo pi-app | present, app version 0.7.13 | **ABSENT** (`/d/pcloud/.../pi-app` không tồn tại trên ProDesk) | |
| LiX SDK pin (pi-app package.json) | **1.0.2** | n/a | `dist/core/session-open-lease.js` trong SDK 1.0.2: **KHÔNG TỒN TẠI** (Test-Path False) → xác nhận finding GLM F1 |
| LiX installed app trên ProDesk | n/a | **0.7.13-9c8f2650 ACTIVE** — headless Linux AppImage qua Xvfb user units (`pi-desktop-xvfb`/`pi-desktop-app`, cả hai active), `/home/quoc/apps/pi-desktop/current` symlink, gateway 47900 LISTEN, rollback 0.7.12 retained. Deployed 2026-11-16 qua lane deploy riêng có owner approval (receipt: `D:\pcloud\workspace\archive\home-server-artifacts\lix-0.7.13\receipts\prodesk-lix-0.7.13-20261116T135637946504Z.json`). Correction từ Pi Android, parent verified bằng readlink + ss + systemctl --user. HOMELAB snapshot "0.7.12" cũ đã superseded. |

## Agent dirs

| Item | Laptop | ProDesk |
|---|---|---|
| `~/.pi/agent` | present | present |
| Extensions count | 35 | 33 (lệch 2 — inventory chi tiết ở matrix) |
| Skills (D:\.claude\skills laptop) | 108 | n/a (check riêng khi cần) |

## Version-gate decisions (T0 output per spec)

1. **Bump SDK pin**: pi-app `@earendil-works/pi-coding-agent` 1.0.2 → pi-mono-li build chứa T1 owner protocol. Quyết định ghi tại đây, THỰC HIỆN ở T2 (owner: Pi Android; parent verify protocol). Busy-writer tests T5 chạy trên SDK đã bump.
2. **SDK 1.0.2 fail-closed**: xác nhận dist không có lease code bằng file check ở trên. T1 capability handshake phải từ chối attach từ runtime không khai protocol version.
3. **ProDesk LiX host**: ĐÃ CÓ — LiX 0.7.13-9c8f2650 active qua lane deploy riêng đã owner-approved (xem bảng trên). Gate install KHÔNG còn cần approval nữa; T5 chỉ cần Pi Android build release mới chứa SDK bump + deploy ProDesk qua cùng wrapper lane (deploy.py pin SHA, symlink atomic, rollback retained).
4. **Runtime drift hai host**: `li` cùng version 1.3.0 nhưng source commit khác (laptop 46ddc71954 vs ProDesk b0d59811fe) → trước T5 cần re-sync `li` trên cả hai host về cùng commit (lane riêng, owner approval).

## Capability matrix (skeleton — đang được scout điền)

Schema: feature | LiX Desktop entry (file/UI) | main handler | remote RPC | adapter status | test path | status

- Renderer/main surface inventory: `scout-lix-surface` subagent đang quét (kết quả sẽ được merge vào file này).
- Extensions inventory chi tiết từng host (tên/version/loaded + interactions cần adapter): pending, thu thập trong T0 continuation.

## Laptop extensions (tên thư mục, 35)

agent-view-bridge, context-guard, copy-n, editor-context, goal-bridge, handoff, jev, kaneo-agent-control, kaneo-mcp, knowledge-preamble, minimal-footer, peer-sessions, pi-agent-browser-native, pi-antigravity, pi-ask, pi-bash-guard, pi-done-notify, pi-osc-patch-guard, pi-terminal-relay, picron, prodesk-parent, prodesk-sync, prodesk-tab, runtime-identity, secrets-intake, session-delete, session-trim, shared, subagent-tab, super-parent, surf-jobs, tele-supervisor, todo-list, worker-progress, (1 mục nữa pending exact list)

## ProDesk extensions count

33 thư mục (exact list pending — cần lane read-only tiếp theo hoặc T2 slice của Pi Android).

## Sources

- `li --version` stdout (laptop + prodesk), 2026-11-16.
- `node -p require('./package.json')` (pi-app laptop).
- `Test-Path .../dist/core/session-open-lease.js` → False.
- `ls $env:USERPROFILE\.pi\agent\extensions` (laptop), `ls ~/.pi/agent/extensions | wc -l` (prodesk).
- `ls $LOCALAPPDATA/Programs`, `$APPDATA` grep pi/lix (prodesk) → miss (Linux host); CORRECTED bằng: `readlink -f /home/quoc/apps/pi-desktop/current`, `ss -tlnp | grep 47900`, `systemctl --user is-active pi-desktop-xvfb pi-desktop-app`, receipt JSON (laptop path).

## Capability matrix (T0, từ scout-lix-surface 2026-11-16)

Schema: feature | renderer entry | main handler | remote RPC | adapter status | test | status
adapter: ready = remote RPC đủ; partial = thiếu vài op; missing = chưa có RPC. test/status: UNTESTED (điền khi T2-T4).

| # | Feature | Renderer | Handler | Remote | Adapter | Test | Status |
|---|---|---|---|---|---|---|---|
| 1 | Project sidebar/session list | project-sidebar.tsx | workspace.ts, session.ts | project.list, session.watchList/open/create | ready | TBD | UNTESTED |
| 2 | Session context menu (rename/delete/clone) | session-context-menu.tsx | session.ts | rename/delete/clone THIẾU; fork có | partial | TBD | UNTESTED |
| 3 | Home view / temp chat sandbox | project-home-view.tsx | workspace.sandbox.* | THIẾU | missing | TBD | UNTESTED |
| 4 | Timeline/markdown/code/mermaid | timeline.tsx | timeline-projection | turn.page/toolDetail/patch | ready | TBD | UNTESTED |
| 5 | Tool cards/previews | tool-card-templates.tsx | render-node.ts | turn.toolDetail | ready | TBD | UNTESTED |
| 6 | Message hover actions (rewind/fork) | message-hover-actions.tsx | session.ts | turn.rewind, session.fork | ready | TBD | UNTESTED |
| 7 | Timeline scrubber | timeline-scrubber.tsx | session.getMessages | turn.page | ready | TBD | UNTESTED |
| 8 | Session tree overlay | session-tree-overlay.tsx | session.tree/navigateTree | session.branches/switchBranch, turn.rewind | ready | TBD | UNTESTED |
| 9 | Fork overlay (clone) | session-fork-overlay.tsx | forkCandidates/fork/clone | clone THIẾU | partial | TBD | UNTESTED |
| 10 | Tree panel | tree-panel.tsx | session.tree | session.branches | partial | TBD | UNTESTED |
| 11 | Composer send/steer/follow-up | composer.tsx | prompt.ts | turn.send/abort/dequeue | ready | TBD | UNTESTED |
| 12 | Slash commands + completions | composer-slash-popover.tsx | commands-slash.ts | command.list có; completions/resolve THIẾU | partial | TBD | UNTESTED |
| 13 | File @-search | composer-file-popover.tsx | workspace-fs.ts | file.search | ready | TBD | UNTESTED |
| 14 | Attachments | attachments.tsx | prompt.ts clipboard | attachment.upload/get | ready | TBD | UNTESTED |
| 15 | Model picker | model-picker.tsx | model-runtime.ts | model.list/set; cycle THIẾU | ready | TBD | UNTESTED |
| 16 | Thinking picker | thinking-picker.tsx | model-runtime.ts | thinking.set | ready | TBD | UNTESTED |
| 17 | Composer metrics/context | composer-metrics-footer.tsx | context.preview | session.stats | partial | TBD | UNTESTED |
| 18 | Pending queue/retry/compaction | composer-pending-queue.tsx | prompt/session | dequeue có; compact THIẾU | partial | TBD | UNTESTED |
| 19 | Subagent activity/navigation | composer-agent-activity.tsx | tool-child-session.ts | THIẾU (chỉ turn.patch) | missing | TBD | UNTESTED |
| 20 | Voice input ASR | composer-voice-ui.tsx | asr.ts | THIẾU | missing | TBD | UNTESTED |
| 21 | Review panel stage/unstage | review-panel.tsx | review.ts | review.diff có; stage THIẾU | partial | TBD | UNTESTED |
| 22 | Git branch status | branch-status.tsx | git-branches.ts | THIẾU | missing | TBD | UNTESTED |
| 23 | Files panel read/preview | workspace-files-panel.tsx | workspace-fs.ts | file.list/search có; read/preview THIẾU | partial | TBD | UNTESTED |
| 24 | Files create/rename | files-context-menu-portal.tsx | workspace-fs.ts | THIẾU | missing | TBD | UNTESTED |
| 25 | Run panel | run-panel.tsx | worker events | turn.patch/state | ready | TBD | UNTESTED |
| 26 | Context panel | context-panel.tsx | context.preview | session.stats | partial | TBD | UNTESTED |
| 27 | Terminal PTY | terminal-drawer.tsx | terminal.ts | THIẾU | missing | TBD | UNTESTED |
| 28 | Browser panel (~30 channels) | browser-panel.tsx | browser.ts | THIẾU | missing | TBD | UNTESTED |
| 29 | Split view | split-view.tsx | renderer-local | N/A | N/A | TBD | UNTESTED |
| 30 | Status bar/notification/update | status-bar.tsx | desktop-chrome.ts | THIẾU (desktop-only) | N/A desktop | TBD | UNTESTED |
| 31 | Command palette | command-palette.tsx | commands.list | THIẾU palette semantics | missing | TBD | UNTESTED |
| 32 | Settings general/mobile/usage | settings-page.tsx | settings.ts, usage.ts | chỉ cacheWarming | partial | TBD | UNTESTED |
| 33 | Appearance/theme editor | appearance-theme-editor.tsx | background.ts | THIẾU | missing | TBD | UNTESTED |
| 34 | Pi runtime/SDK settings | pi-settings-panel.tsx | pi-sdk.ts | THIẾU | missing | TBD | UNTESTED |
| 35 | Models settings (providers) | models-settings-panel.tsx | pi-sdk.ts | THIẾU | missing | TBD | UNTESTED |
| 36 | Model routing | model-routing-panel.tsx | model-routers.ts | THIẾU | missing | TBD | UNTESTED |
| 37 | Skills/prompts settings | skills-settings-panel.tsx | skills-resources.ts | THIẾU | missing | TBD | UNTESTED |
| 38 | Extensions settings | settings-extensions-panel.tsx | extensions.ts | THIẾU | missing | TBD | UNTESTED |
| 39 | MCP settings | mcp-settings-panel.tsx | mcp.ts | THIẾU | missing | TBD | UNTESTED |
| 40 | Adapters settings | settings-adapters-panel.tsx | adapter-panels.ts | THIẾU | missing | TBD | UNTESTED |
| 41 | Capability picker per session | default-tools.ts | prompt.ts | capability.list/set | ready | TBD | UNTESTED |
| 42 | UI-blocks widgets (chart/gantt/…) | ui-blocks/runtime.tsx | worker-frame | THIẾU (desktop widget) | missing | TBD | UNTESTED |
| 43 | Adapter side panels | generic-adapter-side-panel.tsx | adapter-panels.ts | THIẾU | missing | TBD | UNTESTED |
| 44 | Todo widget host | composer-adapter-widget-host.tsx | adapter-widget.ts | THIẾU | missing | TBD | UNTESTED |
| 45 | Extension dialogs (5 kinds) | extension-ui-host.tsx | extension-ui.ts | ui.respond/cancel + ui.request | ready | TBD | UNTESTED |
| 46 | Extension config/MCP diag | extension-config-subpage.tsx | extension-ui.ts | THIẾU | missing | TBD | UNTESTED |

## Remote gaps tổng (T2 scope freeze input)

1. Session mutations: rename/delete/clone/compact/export (export orphan: handler có, renderer không gọi — cần xác nhận host thật trước khi vào parity).
2. Files read/preview/create/rename (resolvePathUnderWorkspace guard).
3. Terminal PTY lifecycle (terminal.create/kill/resize/profiles).
4. Review stage/unstage + raw diff.
5. Git branchStatus/switch/restoreStash.
6. Extensions/adapters/skills/prompts/MCP/SDK/model-settings/routers — quản trị host (mutations v1 đóng băng theo matrix, secrets mask).
7. Browser tool panel (~30 channels) — đánh giá scope riêng (có thể N/A v1 với lý do).
8. Voice ASR — N/A v1 với lý do (host-local audio).
9. Subagent/child-session surface — cần RPC riêng cho Agents view parity.
10. Slash completions/resolve, usage.summary, model.cycle — nhỏ.
11. Contract drift nhỏ: ipc-contract.ts SessionExportRequest {sessionId} vs handler đọc sessionFile — fix trong T2 khi thêm export.

## Observations T0

- Orphan handler: session.export đầy đủ handler nhưng không có UI entry (cần xác nhận trước khi parity claim).
- Remote watcher khớp session summary schema (updatedAt ms).
- Pairing/desktop-chrome/window/WSL: N/A matrix (desktop-only by nature).
