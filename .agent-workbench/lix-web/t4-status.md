# T4 Status — Pi workbench UI + extension parity (SPEC-2026-11-16-li-web)

Updated: 2026-11-17. Owner: parent (Web UI). Design tokens: `apps/web/DESIGN.md`.

## DONE (code + tests trên pi-app, parent)

### 1. Timeline core (`apps/web/src/workbench/timeline-store.ts`)
- **Mirror chính xác Android `TurnStore.kt`** (cùng wire contract): apply 7 ops (turn.upsert id/anchor replace, step.upsert + activity counts, text.append ref=answer/steps, turn.promote, turn.settle propagating error→running tool steps, session.state, timeline.reset giữ hasOlder).
- Gap rule: patch seq ≠ seq+1 → GAP (caller re-open); overlap (seqTo ≤ seq) skip; coalesced text.append advance tới seqTo.
- pendingUi add (notify không vào, dedupe id) / dismiss.

### 2. Parity matrix hữu hạn (`workbench/parity-matrix.ts`) — release gate
- **Froze toàn bộ 46 hàng T0** + rows mới: mọi hàng là `browser-ready` (28 rows, có test path) hoặc `excluded` (22 rows, có lý do viết rõ) — không còn "partially implied".
- Excluded có chủ đích: theme editor, SDK/models/MCP settings (host-local, secrets mask), voice ASR, browser panel, split view, command palette, git branch bar, compact, temp chat sandbox, UI-blocks widgets, export JSON (contract drift gap #11 — MD/HTML ship client-side), subagent deep navigation (gap #9 post-v1).
- `validateMatrix()` + test đánhLuật: ready row thiếu test / excluded row thiếu reason → fail.

### 3. Strict sanitization (`features/markdown.ts`)
- DOMPurify profile nghiêm ngặt: ALLOWED_TAGS chỉ formatting/table/img/a; FORBID iframe/object/embed/script/form/base/meta/link/style/svg/math; FORBID on* attrs + srcset; allow-data-attr false.
- Hook: links force target=_blank + rel noopener noreferrer nofollow.
- Markdown text render qua react-markdown + remark-gfm/breaks **không rehype-raw** (raw HTML drop mặc định). Export documents sanitize qua cùng profile.

### 4. Terminal OSC 52 off (`features/terminal.ts`)
- `stripOsc52` — single choke point giữa `terminal.data` và xterm.write: strip OSC 52 (BEL + ST terminator, fail-closed với unbalanced), giữ nguyên colors/OSC khác; byte-safe. 9 tests.
- `TerminalPane` lazy-load @xterm/xterm + addon-fit (đã có sẵn trong node_modules, không thêm dep); open/input/resize/close typed RPC; close cleanup khi unmount.

### 5. Attachments prompt-only (`features/upload.ts`)
- ≤10 MiB qua shared `ATTACHMENT_MAX_BYTES`, sha256 + base64 chunked, FileReader fallback cho engine thiếu `file.arrayBuffer()`; AttachmentTooLargeError typed.

### 6. Extension UI adapters (`extensions/adapter-registry.ts` + `workbench/ExtensionDialogs.tsx`)
- Native web adapters: select/confirm/input/editor/notify + **ask_user_question** (multi-select checkboxes + free-input) + **image_review** (img + options + feedback).
- **Fallback card** cho mọi kind khác: tên extension + **"Chưa hỗ trợ trên Web"** + raw JSON collapse (cap 2000 chars) — warning treatment (màu --status-warn, KHÔNG error red).
- Dialog dock phía trên composer — không modal che task đang chạy.

### 7. Workbench shell (`workbench/Workbench.tsx` + SessionRail/Timeline/Composer/Inspector/SettingsPanel)
- **Host rail** (per-host dot + online state, active chip) → **session rail** (search, context menu rename/delete/clone typed RPC, Agents grouping qua `isSubagentSession`) → **timeline** (turns + tool cards có detail lazy load + markdown answer + files chips + hover rewind/fork với confirm strip) → **composer** (prompt/steer/followUp với auto-steer khi running, slash list từ command.list local filter, @file mention qua file.search, prompt-only attach, metrics tokens/cost footer, Abort luôn hiện khi running) → **inspector** 5 tabs (Review diff isRepo+files, Files list+preview, Context tokens/cost/breakdown, Tree branches switchBranch, Terminal xterm OSC52-off) + export MD/HTML buttons.
- Mobile reflow: <900px inspector ẩn, <640px rail ẩn (CSS grid) — semantic order giữ nguyên.
- States: loading/empty/error (notice banner + rail role=status)/disconnected (reconnecting banner)/owner busy (writer_conflict → thông điệp riêng)/stream (indicator + Abort)/handoff (writer_conflict message) — không modal false-stop.
- `openSessionInStore`: snapshot/replay result populate store timeline (RPC req/res không tự chảy vào store); gap/resync path dùng lại helper (forced re-open có snapshot).

### 8. Subagent-tab flow (acceptance T4) — `workbench/subagent-flow.test.ts`
- **Real wire test** qua HostSim handshake thật: spawn (turn.send prompt) → sessions.update mang child (SessionSummary chuẩn, gateway title-prefix `subagent-tab: `) → progress qua subagent_tab tool step trên parent timeline (turn.patch, step id ổn định) → steer mid-flight → abort truthful `{aborted, wasRunning, stopped}` + child idle trong sessions.update → resume/handoff followUp — **không stale-context re-read**.

### 9. Responsive captures (spec verify)
- `apps/web/scripts/capture-responsive.mjs` (Playwright + vite preview): chụp 320/375/768/1280/1440 vào `plans/ui-visual-exploration/lix-web/captures-t4/shell-*.png`; assert `scrollWidth ≤ clientWidth` — **5/5 overflow=0px PASS**.

## VERIFY RESULTS
- `npx vitest run apps/web`: **101/101 PASS (17 files)** — timeline-store semantics (10), parity matrix gate (6), markdown/DOMPurify (6), terminal OSC52 (9), upload (5), adapter registry + export (8), connection states + isolation (5), branch/review flows qua real wire (4), subagent-tab flow (1), composer/rail/inspector/settings components (10), endpoint/device-keys/handshake/reconnect/pair/host-store từ T3 (27).
- `npm run test:unit` full repo: lần 1 có 7 fail, lần 2 còn 4 fail — **đều là desktop tests (session-tree-from-file, session-jsonl-timeline-skill, timeline-view-first-load, worker-cli-entry) chạy ISOLATED PASS** → flake parallel-load pre-existing (đúng pattern đã ghi trong t1-status), không liên quan apps/web.
- `npm run typecheck` (web+node): 0 errors. `npm run web:typecheck` (app+sw): 0 errors.
- `npm run web:build`: PASS (62 modules, sw precache 5 files).
- Responsive: 5 widths, 0px overflow, captures lưu `plans/ui-visual-exploration/lix-web/captures-t4/`.

## MANUAL_SMOKE_NEEDED (T5)
- Extension dialog thật từ extension lạ (fallback card trên host thật).
- Terminal PTY qua WSS Serve + camera QR trên mobile.

## SCOPE_DEVIATIONS
- Không có so spec. Ghi chú thiết kế: Agents view nhận diện child qua gateway title-prefix `subagent-tab: ` trong sessions.update (web-side display convention — deep child navigation vẫn excluded theo matrix gap #9).

## OUT_OF_SPEC_ADDITIONS
- `capture-responsive.mjs` + playwright chromium headless-shell download (dev tool cho verify spec T4).
- Không thêm runtime dep mới (xterm/dompurify/react-markdown/zustand dùng sẵn của desktop renderer).

## FIX ROUND (2026-11-18, sau independent review NEEDS_FIX — 7/7 findings)

Reviewer độc lập (T4 review subagent) xác nhận 7 proven bugs. Tất cả đã fix:

1. **Workbench chưa mount** → HostManager render `<Workbench>` khi có connection (manager panel collapse vào `<details>`); per-host `connectStore` wiring + `resetHost` cleanup.
2. **Pair token bị drop ở hs1** → `HostConnection` giữ `pendingPairToken`, gửi trong hs1 đầu, clear sau handshake; HostSim ghi `pairTokens[]`; test assert one-time + không persist.
3. **Memory key store** → một `IdbDeviceKeyStore` duy nhất share giữa HostStore + createDeviceKey; `store.markConnected(hostId, hello.deviceId)` gọi khi hello.
4. **Không pin host identity** → hs2 `payload.hostId` + hello `hostId` so với pinned hostId; mismatch refuse; error state reset được từ `error`.
5. **`ui.respond` sai envelope** → ExtensionDialogs gửi `{value}` (select/input/editor), `{confirmed}` (confirm), questionnaire `{result:{cancelled:false,answers}}`, image_review `{result:{choice,label,feedback?}}`; Workbench gửi `{id, ...response}`, chỉ dismiss khi `result.accepted`; `ui.cancel` xử lý; notify → store notice.
6. **Terminal không subscribe** → `TerminalPane` dùng `conn.subscribeEvents()`; buffer `terminal.data` early output per terminalId; `terminal.exit` set exited; resize qua `term.onResize`; cleanup theo `conn.online`. Test mới `terminal-pane.test.tsx` (wire integration full: open → data OSC52 strip → input/resize → exit → close + unsubscribe + dispose).
7. **Matrix cite test không tồn tại** → parity-matrix.ts rewrite, mọi row cite file thật; `validateMatrix(testPaths)` check disk; parity-matrix.test.ts walk filesystem covers 46 hàng T0.

Kèm theo fix round:
- Unknown custom `ui.request` → `UnknownCustomUiRequest` browser-side (`web-ui-request.ts`) + fallback card redact/bound (`adapter-registry.ts` rewrite). KHÔNG đụng `UiRequestSchema` T2.
- Session resync single-path: `onSessionOpen` → `applyOpenResult`; không double-open khi resync.
- AgentsPanel (steer/abort/resume từ parent tool steps) + Inspector agents tab; files create/rename + directory nav; SessionRail inline rename + delete-confirm + project filter (`project.list`); Composer queue display + thinkingLevels + abort feedback + @file insertion; Timeline todo widget; Settings `capability.list/set` + cacheWarming radio + version-diff guard.
- Responsive capture chuyển sang dev fixture `workbench-preview.html` (dev-server, không cần host) — 5/5 overflow=0.

## VERIFY RESULTS (final, fix round)
- `npx vitest run apps/web`: **114/114 PASS (20 files)**.
- `npm run web:typecheck` + `npm run typecheck`: 0 errors.
- `npm run web:build`: PASS (warning chunk 522kB/xterm 338kB — note cho sau, không block).
- Responsive captures 320–1440: **5/5 overflow=0px** (`captures-t4/workbench-*.png`, 2 shots đã soi mắt).

## COMMIT
- **T4 = `1a1a2ab`** (main, sau `da54e87` T3): 45 files, +5007/−102.

## GAPS MỞ (chuyển T5 / pi android lane)
- Child→parent session identity trong `sessions.update` — host lane (pi android), web side đã tự thoái (Agents view derive từ parent tool steps).
- UAT host thật (laptop + ProDesk) + provider-real handoff >90s — T5.
- li drift re-sync — chờ owner.
- Tailscale Serve activation — release gate riêng, owner duyệt.
