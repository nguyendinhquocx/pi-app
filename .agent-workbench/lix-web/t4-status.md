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
