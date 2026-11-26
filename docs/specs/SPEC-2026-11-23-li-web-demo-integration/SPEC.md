---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-23-li-web-demo-integration"
status: "archived"
title: "Li Web — tích hợp Workbench design demo vào product"
archived_at: "2026-11-26T10:11:11+07:00"
source_file: "SPEC-2026-11-23-li-web-demo-integration.md"
source_sha256: "cbfbd1dad498e63f0356597aceb1cfbcb6b84cac4b3f56d3394bfe22c149318c"
implementation_ref: "d61947252723c4a1b3111ed278a7cfab5e3f7109"
working_tree: "dirty"
related_paths: ["apps/web", "apps/web/src/workbench", "apps/web/src/extensions"]
---

# Spec: Li Web — tích hợp Workbench design demo vào product

## Context Snapshot
- Project: Li Web PWA trong `apps/web`; surface Operate, phục vụ mở host/session, đọc hội thoại và gửi prompt.
- Supersedes: `SPEC-2026-11-23-li-web-workbench-ux.md` cho mọi source change từ revision này trở đi. Spec cũ giữ lịch sử review/UAT; không dùng Task T6 “Temp-only” làm scope hiện hành.
- Source lane: `D:/pcloud/workspace/code/android/pi-app-r4-fix-create-open`, branch `li-web/fix-create-open`, starting HEAD `aba10ac` (UAT round 1). Working tree ban đầu sạch ngoài screenshot captures untracked; giữ nguyên, không reset/xóa captures.
- Owner đã yêu cầu thay presentation hiện tại bằng design demo nhưng giữ behavior thật. Scope được owner chốt 2026-11-23; không cần hỏi lại style.
- Stack: React + TypeScript + Vite, CSS variables/component classes ở `apps/web/src/styles.css`; không thêm framework/dependency.
- Visual scope: giữ identity LiX calm/white-first Operate; thay composition/presentation theo app-frame demo, không tạo brand/world hay product mới.
- Visual reference authoritative: `apps/web/dev/workbench-design-demo.html`, copy byte-identical từ Temp SHA-256 `d2e3dc97f802bff75922de17639fe7f3707dbe9df8dd6e959922c1413876743a`. Đây là fixture HTML/JS synthetic, không product-ready.
- Harness boundary: phần ngoài `.app-frame` — nền/canvas xám, `.preview-shell`, tiêu đề/caption “Li · Workbench · design preview”, dòng synthetic/no-host, 9 nút đổi scene và nút Sáng/Tối — chỉ để QA chuyển view/theme; CẤM đưa vào product. Không tạo route/tab tương ứng cho 9 fixture. Chỉ dùng app frame bên trong làm visual/composition reference; data, interaction, RPC và permission phải đến từ product thật.
- Relevant files: `apps/web/src/hosts/HostManager.tsx`; `apps/web/src/workbench/{Workbench,SessionRail,Timeline,timeline-store,Composer,Inspector,SettingsPanel}.tsx`; `apps/web/src/styles.css`; `apps/web/src/dev/workbench-preview.tsx`; `apps/web/scripts/capture-responsive.mjs`; các test hiện có cùng thư mục.
- Constraints: giữ host namespace riêng, typed RPC, HostConnection, single-writer/security, pair token memory-only và history fragment cleanup; không đổi gateway/protocol/shared schema/Android/ProDesk/T20/Serve/DNS/firewall. Production hiện đã deploy UAT round 1 (`aba10ac`); UAT round 2 chỉ sửa/verify local, không deploy nếu owner chưa yêu cầu.

## Objective
Tích hợp design demo vào Li Web bằng React + store/RPC thật, rồi xử lý các correction trong owner UAT round 2 tại `aba10ac`. Giữ host/session/security behavior; không dùng demo làm nguồn dữ liệu. UAT round 2 acceptance ở mục dưới là phần active mới và supersedes presentation/capability visibility cũ khi mâu thuẫn.

## Scope
- In:
  - Thay host chips trên topbar bằng host picker ở footer của SessionRail; giữ đầy đủ host status, chuyển host, thêm/quản lý/pair, disconnect tạm và Forget có confirm.
  - Topbar giữ toggle rail trái, theme toggle (được owner yêu cầu trong UAT round 1) và Inspector phải; mobile dùng nút mở drawer không lặp title session.
  - App mở thẳng workbench khi đã có host; empty state không-host là một CTA thật; không có preview title/banner/scene controls.
  - Rail + Inspector responsive, resize/collapse và lưu preference local-only; breakpoint/width theo `Approach`.
  - Chuyển layout timeline/tool/composer/Inspector theo visual reference; giữ host/protocol/security behavior và các component implementation ngoài demo. Visibility có thể được điều chỉnh theo owner UAT correction bên dưới mà không xóa panel/RPC code.
  - Cập nhật synthetic fixture/capture và `apps/web/DESIGN.md` sau khi runtime evidence đã verify.
- Out:
  - Bê demo JS/fake data vào product, dùng iframe/static HTML làm UI, hoặc thêm route/tab để chuyển 9 scene.
  - Thay API/RPC/protocol, authority/permission, host/session identity, model availability phía host, terminal execution/OSC52, Android, gateway/host/ProDesk, release/deploy.
  - Đưa pair token, session thật, host thật hoặc screenshot có nội dung riêng tư ra ngoài.
  - Bê nguyên theme control của QA harness vào product; nút sáng/tối riêng trên product được owner yêu cầu trong UAT round 1 và dùng theme bootstrap/persistence hiện có.
  - Tailwind/shadcn migration, dependency hoặc component framework mới chỉ để restyle.

## Thuật ngữ
- QA harness: vỏ demo dùng để chuyển scene/theme và hiển thị nhãn synthetic; không phải giao diện product.
- Fixture scene: mẫu trạng thái trong demo. Khi vào product, đó là state thật của cùng workbench, không phải route/tab.
- Host picker: menu chọn host ở cuối rail; không tự pair, xóa key hay thu hồi quyền.
- Forget: xóa browser device key; khác disconnect tạm thời, luôn cần confirm riêng.
- Local-network permission: quyền browser cho PWA HTTPS mở kết nối tới host private/tailnet; chỉ báo “bị chặn” khi permission/browser evidence xác nhận, không suy diễn từ mọi WebSocket error.

## UX Baseline
1. Keyboard: topbar toggle → rail search/session rows/host picker → timeline → composer → Inspector; dialog/menu Escape đóng và focus quay về trigger; combobox/menu hỗ trợ keyboard thật.
2. Focus: pointer click không tạo black ring; keyboard focus nhìn thấy, không dựa riêng màu; selected host/session/tab dùng text-weight, focus cue riêng.
3. A11y: controls có name/role/state; dialog trap/return focus; errors `role=alert`, progress `role=status`; text ≥4.5:1, target ≥44px.
4. Responsive: 320–1440px không tràn ngang; viewport matrix gồm 320/375/414/768/769/999/1000/1024/1280/1440; giữ đọc được inner timeline/composer/Inspector, không chỉ document.
5. States thật: no-host, offline/connecting/reconnecting/error, pair input/scan/error/success, local-network permission denied khi xác nhận được, empty session, older loading/error/end, attached/detached follow, model pending/error/no-result, tool running/failed/completed, terminal opening/open/exited/error.
6. Selection: host/session/Inspector tab active không dùng fill nền; dùng weight và semantics (`aria-pressed`, `aria-current`, `aria-selected`). Model option selection được phép dùng soft-fill + check, keyboard focus có cue riêng.
7. Theme: giữ current OS/local theme bootstrap; terminal light/dark theo theme; theme toggle product ở topbar theo owner UAT round 1, không port nguyên harness control; tôn trọng reduced-motion.
8. Copy: không có demo caption/hint; error/busy/recovery/final state cần hành động phải còn, copy trung tính và nói đúng nguồn thật.

## Owner UAT Round 2 — active correction (2026-11-24)
Source: screenshots supplied by owner in current session; implementation starts only after this amendment. Route remains `https://li.quoc.app`; affected states are long/running timeline, failed tool rows, running session rows, focused search/composer, Inspector open, desktop + phone. Screenshot paths stay local and are not committed.

Owner override: this UAT instruction supersedes Task 4's earlier requirement to expose every Inspector tab. Product UI shows Terminal only; do not delete the underlying panel implementations or alter their RPC/security behavior, but no alternate navigation to those hidden panels is required in this round. The separate topbar light/dark toggle remains because the owner explicitly asked for it in UAT round 1.

Acceptance:
1. Session rail: remove decorative magnifier; add a visible green status dot for `status === 'running'`; keep text/name/search semantics. Rail/model search fields have no outline box; keyboard focus uses soft surface + weight. Hide scrollbars visually across page and nested panes without disabling scrolling.
2. Chat: remove the redundant “Bạn” sender label; no hover decoration on thinking/tool-running content; failed-tool summary does not spill verbose error text into the transcript (failure details remain available on deliberate expansion and to assistive technology). Abort action uses neutral black text, not error red.
3. Copy: prompt and settled assistant answer each have a small copy action; assistant copy is left-aligned directly under its answer content, not at the far edge. Hover/focus reveal only for the corresponding message, never when hovering unrelated thinking/tool content; successful copy changes to a check briefly and has an accessible name.
4. Inspector: only Terminal is visible; remove tab/divider lines and redundant borders. Keep the three-dot export action functional but compact and aligned with the reduced single-panel header.
5. Streaming display: while a turn is running, do not expose token-by-token intermediate thinking/prose deltas as transcript content; show one concise live activity cue and real tool rows. Once settled, render the final authoritative content. Reproduce with a deterministic mixed text/thinking stream test before accepting the fix.
6. Blank/stale timeline: direct reset, sequence gap, or reconnect replay containing `timeline.reset` must request a fresh snapshot without clearing visible turns. Buffer/replay patches newer than the snapshot head; a failed/slow resync keeps the old view and retries on later events. Per-session open freshness prevents late snapshots/context from a previous session overwriting the selected one; close/unwatch cancels resync and ignores late patches.
7. Verify typecheck, full `apps/web` tests, build, responsive/runtime captures (320/375/414/768/769/999/1000/1024/1280/1440), and two independent review rounds: GLM-5.3-Flash, GPT-6 Luna, Gemini-3.8-Flash. Fix material findings and re-run targeted verification before final report. No commit/push/production deploy in this round absent a fresh ship instruction.

## Owner UAT Round 3 — active correction (2026-11-25)
Source: owner feedback in current session (attachment upload, empty-state copy, dark-terminal palette, Inspector width, new-session layout, host restore). Shipped R2 baseline: commit `85ceea9`, deploy `cb48288f`.

Acceptance:
1. Attachment upload: cancelling the native file picker re-enables the attach button immediately (the picker fires only `cancel` — never leave `attaching` stuck). Selecting a file keeps the existing flow.
2. Empty/new-session view: no “Chưa có nội dung” placeholder, no “Phiên mới / Tin nhắn đầu tiên…” landing copy; the composer sits at the bottom edge exactly like an open session (first message still creates the session). The Inspector toggle renders on the new-session view too; Terminal opens there by borrowing the first session key (host resolves the project from it).
3. Terminal palette follows the app theme from the device-local preference (`lix-web-ui` → `dark` class → OS preference), and live repaints when the topbar toggle flips while a PTY is open (no reopen). Dark app ⇒ dark terminal; light app ⇒ light terminal.
4. Inspector width ceiling is half the viewport (desktop ≥1000px), bounded by the 360px center floor and gutters — the owner runs work inside the terminal and needs 50% width. Stored widths above the old 380px cap are restored up to the live ceiling.
5. Host restore: the last used host persists device-local (`li-web-last-host`) and is restored on reload instead of always defaulting to the first paired host.
6. Re-run typecheck, full `apps/web` tests (regression tests for all five items), build, and captures (new-session view 1280/375, dark terminal, half-width Inspector) before reporting. Ship still requires an explicit owner command.

## View / State Matrix
| Demo fixture (không phải route) | Product flow thật | Acceptance cốt lõi |
|---|---|---|
| Workbench | `HostManager` → `Workbench` → `SessionRail` / `Timeline` / `Composer` | Chọn host/session đúng namespace; giữ create/open/rename/clone/delete, project filter, send/steer/follow-up/queue/abort/attachment/slash/@file. |
| Ghép host | Host picker → host-management dialog, pair tab | Dùng HostStore, QR/link parser, pair token memory-only; host status/reconnect/disconnect/Forget giữ semantics; close không đổi session. |
| Pair · quyền mạng | Pair/connection recovery state | Tách mixed-content/no endpoint/camera failure và LNA denied nếu browser báo denied; không giả successful pair, có retry/instruction thật. |
| Lịch sử dài | Timeline + RPC `turn.page` | Auto-page, một request/session, dedupe/order/seq, anchor lệch ≤8px, live không kéo người đang đọc; jump-to-latest. |
| Lỗi tải lịch sử | Timeline older-error | Báo lỗi ngắn tại đầu timeline, retry cùng session/anchor, giữ nội dung và scroll đã tải. |
| Model picker | Composer + `model.list`/`model.set` | Giữ toàn bộ model host trả available; search theo id/name/provider/group; grouping provider; current/pending/error/keyboard thật. |
| Files | Inspector Files + current file RPC | Dùng file.list/read/create/rename hiện tại, giữ session/path authorization; menu/preview thực; không fake tree/content. |
| Terminal | Inspector TerminalPane + PTY | Chỉ mở PTY thật cho active session; giữ OSC52 filter, input/resize/close/error; không render command output giả. |
| Chưa kết nối | HostManager empty state | Một CTA ghép host; khác state “đã pair nhưng chưa chọn session”; không chuyển scene. |

### Product capabilities ngoài 9 fixture — behavior giữ, visibility theo owner UAT
Review diff, Context/usage, Tree/branch switch, Agents inspect/steer/abort/resume, ExtensionDialogs/UI request, Export, SettingsPanel, status writer-conflict, host/session settings giữ nguyên code/RPC/security semantics. Owner UAT round 2 yêu cầu chỉ lộ Terminal trong Inspector; không xóa implementations nhưng cũng không dựng thêm entrypoint/menu trong vòng này. Rewind/Fork chat actions ẩn theo owner UAT round 1.

## Flow
Current working tree đang có UI thử theo spec cũ: host chips/Add Host ở topbar, mobile toggle chứa title session, SessionRail/Inspector ở grid, Inspector tab Context, SettingsPanel ở disclosure footer. Các behavior đã có trong tree là uncommitted, chưa được final-gate; phải đối chiếu code/test trước khi reuse.

Desired:
1. Mở Li → nếu chưa có host, thấy empty state và một CTA pair; nếu có host, vào thẳng workbench.
2. Chọn host ở picker cuối rail; menu cho chọn paired host hoặc mở quản lý/thêm host; không có title session dropdown lặp.
3. Chọn/tìm session ở rail; tạo phiên bằng `+` sát ô search; timeline/composer là vùng chính.
4. Đọc/gửi tại timeline; cuộn lên tự nạp lịch sử và giữ mốc đọc; lỗi có retry, về cuối có action rõ.
5. Inspector mở khi cần; UI chỉ lộ Terminal và export menu theo owner UAT round 2; các panel code khác được giữ nhưng ẩn, không có alternate entrypoint trong scope này.

## Approach
- Quyết định kỹ thuật: recompose presentation trên các React components/store/RPC đang có. Jev so sánh đã chọn `react-composition` áp đảo; embed HTML hoặc rewrite behavior từ đầu đều bị loại vì sẽ kéo fake state vào product và làm mất permission/safety/host namespace.
- Dùng `apps/web/dev/workbench-design-demo.html` làm reference cho inner app frame, typography/tokens/spacing/composition và fixture states; không dùng code JS/data trong đó làm product logic. App product chiếm viewport thật; bỏ outer gray canvas, preview-shell/toolbar/banner, scene switcher, theme switcher.
- Host picker dời xuống rail footer. Topbar giữ toggle ở hai đầu; host/session controls không lặp ở topbar. Pair/manage vẫn đi qua dialog có tab “Đã ghép nối” / “Ghép nối mới”.
- Rail default 280px, min 240px; max động ≤50vw và clamp theo phần bề rộng còn lại. Ngưỡng workbench center ≥360px chỉ áp dụng layout nhiều cột từ 769px trở lên; ở ≤768px center dùng toàn bộ chiều rộng khả dụng và drawer/sheet overlay, tuyệt đối không ép min-width 360px. Inspector default closed, width 310px, min 280/max 380; state/width lưu local-only. `Terminal` là tab đầu và tab active mặc định khi Inspector mở; không tự mở panel khi vào phiên lần đầu.
- Breakpoints: ≤768px rail drawer + Inspector bottom sheet; 769–999px rail là grid, Inspector overlay/backdrop có close rõ; rail-closed + Inspector-open dùng 2 grid tracks để không chồng; 1000–1024px cả rail/Inspector có thể là 3 grid tracks; ≥1025px dùng layout 3-pane có resize separators. Ở layout nhiều cột (≥769px), width clamp giữ center ≥360px; ≤768px dùng toàn chiều rộng khả dụng và không ép min-width gây page overflow.
- Reuse CSS variables/plain CSS; đổi semantic component classes để khớp ref; không giữ lại fill/underline ở selected host/session/tab, nhưng vẫn có focus cue và selected semantics. Dữ liệu/model/host/files/terminal luôn là dữ liệu product thật.
- SettingsPanel chưa có trong demo: giữ advanced disclosure hiện có ở cuối workbench, collapsed và gọn; không tạo settings nav thứ hai nếu chưa cần.

## Assumptions / Open Questions
- Owner đã chốt visual reference và harness boundary; không hỏi lại mood/style.
- Existing `DESIGN.md` đang mô tả implementation chưa final-gate; chỉ sửa sau khi screenshot/build mới được parent xác minh.
- LNA: permission query có thể không hỗ trợ ở mọi browser. Nếu API báo `denied`, hiện hướng dẫn retry; nếu unsupported/unknown hoặc lỗi socket chung, chỉ hiện lỗi kết nối trung tính, không tuyên bố Chrome đã chặn.
- Product không có theme picker; theme preference hiện có là nguồn sự thật.

## Bỏ qua
- Không ship QA toolbar, demo title/caption, synthetic banner, scene buttons, `Sáng/Tối`, static model/session/file/terminal data.
- Không lấy screenshot `layout-final-1024.png` làm bằng chứng product đã pass; đó là render của standalone reference.
- Không đổi policy/resolution cho gateway, pair permission, session writer, file boundary hoặc terminal.
- Không reset branch, overwrite diff cũ, sửa canonical `pi-app/pi-app` main, push hoặc deploy.

## Risks
- Branch đang có uncommitted implementation cũ và parent fixes; nếu dùng wholesale sẽ giữ cả mismatch như host-at-top/Context-default/tab underline/old breakpoints. Nếu xóa wholesale sẽ mất behavior/test mới. Parent phải scope-check từng diff và sửa có chọn lọc.
- Dời host picker sang rail footer có thể làm user không tìm được host khi rail gập; vẫn phải giữ đường mở rail và keyboard/touch reachability.
- 769–999 overlay và 1000–1024 3-track có breakpoints sát nhau; cần capture edge widths và kiểm internal overflow.
- Permission denial không thể suy ra từ generic WebSocket `1006`; copy phải phản ánh dữ liệu browser thật.
- Settings/ExtensionDialogs/Agents và các flow không có trong demo dễ bị mất nếu chỉ port ảnh.

## Task List

### Task 1 — Product shell, rail host picker, pairing and empty state
- Objective: Đưa host selection về đúng nơi như reference, bỏ preview chrome, giữ pairing/manage an toàn.
- Acceptance:
  - `document.title`, manifest `name`/`short_name` là `Li`; không render Li Web/design-preview/synthetic caption/scene/theme controls.
  - Topbar chỉ có session rail toggle ở đầu trái và Inspector toggle ở đầu phải; mobile toggle không lặp title session.
  - Host picker ở footer SessionRail, liệt kê mọi record từ HostStore kể cả offline/endpoint-error; state hiển thị ghép từ record + `connStates`, không giả online khi chưa có `HostConnection`.
  - Khi rail desktop gập, topbar toggle vẫn mở lại rail trong một thao tác; trên mobile, drawer chứa host picker ở footer.
  - Chọn host không còn kết nối phải lộ trạng thái/reconnect/manage path và không giữ session/timeline của host trước như thể host mới đã mở; “Thêm host” mở pairing dialog.
  - Dialog có tabs host đã ghép/pair mới, connect/disconnect/Forget giữ nguyên; Forget confirm riêng; pair link/QR dùng flow thật, token memory-only, fragment cleanup.
  - No-host là empty app state với một CTA; khác “host connected, chưa chọn session”.
  - Browser permission guidance chỉ hiển thị nếu permission state thật xác nhận denied; generic socket failure không bị gán nhầm.
  - Host/session/settings/existing online/offline/error state không bị mất khi đổi entrypoint.
- UX Contract: `no-host`, paired host list, selected/offline/connecting, dialog hosts/pair, invalid link, camera unsupported, permission-denied/unknown, Forget confirm. Dialog Escape/backdrop/close + focus return; menus keyboard; errors `role=alert`, no success giả.
- Skills: `ui-design`, `flow`, `mobile-responsive`, `frontend-taste-chatgpt`, `test`.
- Visual Ref: `apps/web/dev/workbench-design-demo.html` inner `.app-frame`; harness section không phải ref cần port.
- Reproduce: `npm exec -- vitest run apps/web/src/hosts/HostManager.integration.test.tsx apps/web/src/hosts/host-dialog.test.tsx apps/web/src/hosts/pair.test.ts`.
- Verify: HostStore có record paired nhưng `chooseEndpoint` lỗi trong khi host khác online; picker vẫn liệt kê cả hai, status không giả online và khi chọn host lỗi không render session host cũ. Pair modal open/close/error/Forget và no-host/connected; permission denied/unknown test doubles; không có real pair token/host trong preview.
- Files: `apps/web/src/hosts/HostManager.tsx` (pair/memory key logic); `apps/web/src/workbench/Workbench.tsx` (host state/layout); `apps/web/src/workbench/SessionRail.tsx` (search/+ / footer); `apps/web/src/styles.css`; host/pair tests.

### Task 2 — App frame, responsive rail and Inspector
- Objective: Khớp bố cục demo mà timeline luôn còn chỗ đọc.
- Acceptance:
  - Rail default 280px, persisted width local-only, min 240; max động ≤50vw. Center ≥360px chỉ bắt buộc ở multi-column layouts ≥769px; ≤768px center dùng full width và không bị min-width ép tràn.
  - Inspector mặc định đóng; width 310px, min 280/max380; mở Inspector không đổi host/session/scroll; tab Terminal đầu/default.
  - 320–768px center dùng toàn chiều rộng khả dụng; rail drawer + Inspector bottom sheet; Escape/scrim đóng, focus return đúng toggle; hai overlay không mở chồng nhau; không đặt min-width 360px.
  - 769–999 Inspector là overlay có backdrop + nút/toggle đóng; rail-closed + Inspector-open vẫn có grid track riêng và không overlap.
  - 1000–1024px cho phép 3 tracks khi rail/Inspector mở; ≥1025px 3-pane resize. Mọi layout nhiều cột giữ center ≥360px, không gây page/internal horizontal overflow.
  - Host/session/tab active dùng bold/semantics thay selected fill/underline; model option keyboard selection vẫn có marker.
- UX Contract: separators keyboard/pointer/Home/End/Arrow, `aria-valuemin/max/now`; pointer cancel sạch; prefs localStorage; focus/reading order và scroll giữ nguyên.
- Skills: `ui-design`, `mobile-responsive`, `frontend-taste-chatgpt`, `test`.
- Visual Ref: `apps/web/dev/workbench-design-demo.html` app frame + `layout-final-1024.png` chỉ là reference render, không phải product proof.
- Reproduce: `npm exec -- vitest run apps/web/src/workbench/workbench-layout.test.tsx apps/web/src/workbench/components.test.tsx apps/web/src/workbench/connection-states.test.ts`.
- Verify: 4 layout combinations at 1024; 769/999 overlay/right-only; 320/375/768 drawers. Assert center ≥360px only at widths ≥769 and full available width below; `scrollWidth <= clientWidth` on root/grid/main/center/composer/Inspector; keyboard/focus return and host-picker reachability while rail collapsed.
- Files: `apps/web/src/workbench/{Workbench,SessionRail,Inspector}.tsx`, `apps/web/src/styles.css`, `apps/web/scripts/capture-responsive.mjs`, layout/component tests.

### Task 3 — Timeline appearance and long-history continuity
- Objective: Dùng bố cục transcript trong reference nhưng giữ `turn.page` thật và không giật vị trí.
- Acceptance:
  - User message, assistant answer, thinking, tools/files/errors dùng content thật; không có fixture values trong product.
  - Scroll top auto-page, one request/session; anchor nhìn thấy lệch ≤8px; dedupe/order/seq; stale reply sau reset/reopen/host switch bị bỏ.
  - User tách khỏi tail thì stream không kéo xuống; chỉ về cuối do user chọn/near-bottom; older error retry giữ page/session.
  - Success tool không hiện raw `ok`, running/error có state/recovery thật; bulk prepend không announce cả log.
- UX Contract: timeline log `aria-live=off`, status/error ngoài log; `older-loading/error/end`, `reading-history/follow-live`, `tool-running/failed/completed`.
- Skills: `ui-design`, `flow`, `mobile-responsive`, `test`.
- Visual Ref: demo `history` / `historyError` scenes (fixture behavior không port).
- Reproduce: `npm exec -- vitest run apps/web/src/workbench/timeline-store.test.ts apps/web/src/workbench/timeline-history.test.tsx apps/web/src/workbench/components.test.tsx`.
- Verify: long session ≥100 turns, actual prepend with scroll anchor, duplicate/in-flight, stale generations, retry, streaming while reading, 320/1024/1440 captures.
- Files: `apps/web/src/workbench/{Timeline.tsx,timeline-store.ts,Workbench.tsx}`, relevant timeline tests, `styles.css`.

### Task 4 — Composer, model picker and Inspector capability parity
- Objective: Lấy hierarchy/compact controls từ demo nhưng giữ toàn bộ product flows ngoài demo.
- Acceptance:
  - Model search theo id/name/provider/group; đủ mọi host-available options; provider grouping; selected/pending/error rollback; không server filtering.
  - Composer giữ send/steer/follow-up, thinking levels, slash, @file, attachment ≤10 MiB, queue/dequeue, abort/error; context cue từ stats thật ≥80%.
  - Inspector order bắt đầu Terminal rồi Context/Review/Files/Tree/Agents; tabs accessible/no fill; Files directory scope, create/read/rename/preview/actions giữ RPC hiện có; Review/Tree/Agents/export/UI requests/SettingsPanel vẫn reachable.
  - Terminal dùng palette demo phù hợp theme hiện có, open/exit/error thật; PTY/input/resize/close và OSC52 fail-closed giữ nguyên; không render demo command text.
  - Product không thêm Sáng/Tối control; settings nâng cao còn reachable nhưng collapsed.
- UX Contract: combobox keyboard/escape/focus; no-result recovery; menu Escape/focus-return; pending `model.set`; file read/create/rename errors; terminal lifecycle; settings busy/error.
- Skills: `ui-design`, `mobile-responsive`, `frontend-taste-chatgpt`, `test`.
- Visual Ref: demo Model/Files/Terminal scenes chỉ làm reference; source thật là current RPC/Inspector.
- Reproduce: `npm exec -- vitest run apps/web/src/workbench/components.test.tsx apps/web/src/workbench/model-picker.test.tsx apps/web/src/workbench/terminal-pane.test.tsx`.
- Verify: model fixture đa provider/group + full list; keyboard; `model.set` success/failure; file path/preview/create/rename; terminal light/dark + OSC52/input/resize/close; SettingsPanel capability/skills refresh.
- Files: `apps/web/src/workbench/{Composer.tsx,Workbench.tsx,Inspector.tsx,SettingsPanel.tsx}`, CSS, component/model/terminal tests.

### Task 5 — Synthetic product preview, capture matrix, docs and final gate
- Objective: kiểm rendered product components bằng fixture an toàn, không trộn demo harness vào product bundle.
- Acceptance:
  - `apps/web/dev/workbench-preview.html` fixture render cùng React product components và synthetic host/store; source demo `workbench-design-demo.html` vẫn là reference QA-only, không tham gia `apps/web` production build.
  - Capture matrix gồm 320/375/414/768/769/999/1000/1024/1280/1440; 1024 chụp 4 rail/Inspector combos; host dialog at desktop/mobile; Inspector states; keyboard-focused states.
  - Overflow asserted tại document, app-grid, workbench-center, timeline, composer, Inspector; tất cả ≤0px; screenshot pack là synthetic, không host/session/token thật.
  - `apps/web/DESIGN.md` chỉ mô tả built/verified visual system, no stale claims; không update global principles.
- UX Contract: QA-only controls có thể dùng query/localStorage test state, nhưng không xuất hiện product UI; fake actions rõ ràng chỉ trong dev fixture.
- Skills: `ui-design`, `mobile-responsive`, `verify`.
- Visual Ref: project copy `apps/web/dev/workbench-design-demo.html`; Temp gốc không chỉnh; no Surf/upload.
- Reproduce: `npm run web:dev -- --host 127.0.0.1` mở synthetic preview; final gates `npm run web:typecheck`, scoped Vitest, `npm run web:build`, `node apps/web/scripts/capture-responsive.mjs`, `git diff --check`.
- Verify: screenshot scenes/states, no harness in production `apps/web/dist`, full scope-check `apps/web/**`, final visual review from local runtime + design peer, no production UAT/deploy.
- Files: `apps/web/src/dev/workbench-preview.tsx`, `apps/web/dev/workbench-preview.html`, `apps/web/src/dev/host-manager-preview.tsx`, `apps/web/dev/host-manager-preview.html`, `apps/web/scripts/capture-responsive.mjs`, tests, `apps/web/DESIGN.md`.

## Checkpoints
- C1: Host picker/dialog/empty state + scoped host/pair tests pass; no token/key semantics changed.
- C2: Responsive matrix + layout tests pass; multi-column widths ≥769 preserve ≥360px main, mobile uses full-width overlays, no overlap/overflow.
- C3: Timeline/history/model/composer/Inspector/terminal/settings targeted tests and `web:typecheck` pass.
- C4: Build, capture matrix, same-state screenshots, product bundle excludes harness, design peer UI/flow review completed.
- C5: Parent `/verify` + user UAT on local preview; no production deploy within this spec.

## External Review Brief
### Reviewer needs to judge
- Does app frame carry the task without harness chrome, keep host/session selection direct and avoid a duplicate session-title dropdown?
- Does the host picker at rail bottom remain reachable when collapsed/mobile and still distinguish active/offline hosts?
- Are 769–999 overlay and 1000–1024 three-track states both understandable/non-overlapping?
- Does the app preserve product capabilities outside the 9 synthetic demo scenes, including SettingsPanel and extension UI?
- Does every demo fixture map to a real product state without fake data/network/filesystem actions?
### Reviewer should read first
- This spec + `apps/web/dev/workbench-design-demo.html` (inner frame only); current `DESIGN.md`; `HostManager.tsx`, `Workbench.tsx`, `SessionRail.tsx`, `Timeline.tsx`, `Composer.tsx`, `Inspector.tsx`, settings and capture script.
### Reviewer need not judge
- Gateway/protocol/Android, ProDesk/T20, deployment, or the preview harness's own visual toolbar.

## User Test
| Hành động | Kết quả kỳ vọng | Chuẩn nhìn |
|---|---|---|
| Mở Li khi chưa pair / khi có host | Empty CTA / workbench tương ứng | Không có preview title, scene tabs, theme picker hay synthetic banner |
| Chọn host từ cuối rail rồi chọn session | Đổi đúng host namespace/session | Picker có host offline/endpoint lỗi; gập rail thì một lần bấm mở lại; Forget chỉ trong dialog và confirm riêng |
| Mở Add host, chuyển tab, đóng bằng Escape/backdrop | Pair/manage dùng flow thật | Focus return đúng; token không còn trong URL sau parsing, không persist |
| Cuộn lên lịch sử khi stream đang chạy | Older pages nạp và giữ điểm đọc | Không auto-jump; lỗi có retry; về cuối là hành động riêng |
| Mở Model, Files, Terminal và các Inspector tabs | Thao tác trên dữ liệu thật | Model đủ list; file/PTY không dùng mock; Terminal không chạy fixture command |
| Thử 320/375/768/769/999/1000/1024 | Vùng đọc và sidebars reflow | ≤768 full-width drawer/sheet; ≥769 center ≥360px; không tràn/che; 1024 có 3-track khi cần |

5 câu Y/N:
1. Sản phẩm vào thẳng workbench/empty state mà không lẫn QA harness controls không?
2. Đổi host/session, pair, Forget và recover error có giữ đúng state/namespace không?
3. Đọc lịch sử dài khi stream chạy có giữ vị trí và retry được không?
4. Model, Files, Terminal, Settings/Agents/Review vẫn là flow thật chứ không phải dữ liệu demo không?
5. Tất cả viewport/layout combos giữ focus cue, nội dung và thao tác cần thiết, không overflow/overlap không?

## Completion Gates
- [ ] Spec này thay active contract; old UI spec marked Superseded; owner direction đã chốt qua request hiện tại.
- [ ] T1–T5 acceptance + targeted tests pass; không thay backend/protocol/host/Android.
- [ ] `npm run web:typecheck`, scoped Vitest, `npm run web:build`, `capture-responsive.mjs`, `git diff --check` pass.
- [ ] Screenshots cùng state cho responsive/layout matrix; `workbench-design-demo.html`/harness không nằm trong production build.
- [ ] Parent scope-check mọi dirty/untracked files; giữ/chỉnh chọn lọc previous changes, không discard mù.
- [ ] Dedicated local UI/flow review verdict, mọi finding vật chất đã xử lý/recapture; final `/verify` pass.
- [ ] Owner UAT trên local preview pass; production Pages deploy là task riêng và không được phép bởi spec này.
