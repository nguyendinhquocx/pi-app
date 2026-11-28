---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-27-li-kaneo-card-command"
status: "archived"
title: "Li Web hiển thị lệnh gán Kaneo card"
archived_at: "2026-11-28T17:47:57+07:00"
source_file: "SPEC-2026-11-27-li-kaneo-card-command.md"
source_sha256: "d9539c30d2aa892b2466e4b7f2495d6ff589a3068846e7d87055dd8a6607f18f"
implementation_ref: "e47008c17b87d62be3b859edfbcc4facdd8b7835"
working_tree: "dirty"
related_paths: ["apps/web/src/workbench/Workbench.tsx", "apps/web/src/workbench/Composer.tsx", "apps/web/src/workbench/components.test.tsx", "apps/web/src/workbench/workbench-layout.test.tsx", "apps/web/public/404.html", "packages/shared/remote/methods.ts"]
---

# Spec: Li Web hiển thị lệnh gán Kaneo card

## Context Snapshot

- **Project / module:** LiX desktop + Li Web (`https://li.quoc.app`), source chính `D:\pcloud\workspace\code\android\pi-app\pi-app`; Kaneo extension source `D:\pcloud\workspace\code\python\app_presets\pi\extensions\kaneo-mcp`.
- **Stack:** Electron/React/TypeScript; Li Web React/Vite; host RPC tới Pi worker. Repo dùng `package-lock.json` và npm scripts.
- **Current behavior:** Pi extension đã đăng ký `/kaneo-card <task-id|authenticated-task-url>`, `/kaneo-card` (show), `/kaneo-card off`. Kaneo binding là per-session, server giữ generation/CAS; extension trên host gọi API, browser không giữ API key. LiX Desktop có command catalog từ worker. Li Web gọi `command.list`; host trả slash-prefixed names, còn Composer lọc như tên không có `/` và lại thêm `/` khi render/chọn.
- **Status:** DONE 2026-11-28. Commits `34f261b` (normalize), `4e0a4e5` (picker corrections) và `e47008c` (404) được hai reviewer cuối APPROVED, push lên `li-web/fix-create-open`; deployed production Cloudflare Pages (`li-quoc-app`, branch `main`) — root 200, unknown path 404. Owner UAT PASS bind/show/off trên cả Li Web và LiX Desktop (owner-attested 2026-11-28). Check bổ sung: nhắn session qua composer li app hoạt động sẵn qua `turn.send`, không cần TUI.
- **Observed evidence:** real Brave trên `li.quoc.app` hiển thị suggestion dạng `//add-kaneo`; gõ `/kaneo-card` không hiện suggestion. Source: `apps/web/src/workbench/Composer.tsx:498,531-533`, `src/main/remote-host-electron.ts:listCommands`, `src/main/commands-catalog.ts`. Candidate issue `iss_20261127085232_1374504b9e`.
- **Desired behavior:** Li Web slash picker hiển thị `/kaneo-card` đúng một lần và tìm được khi user gõ `/kaneo`; command vẫn được host Pi xử lý trên đúng session hiện chọn.
- **Relevant files:** `apps/web/src/workbench/Workbench.tsx` (nhận `command.list`), `apps/web/src/workbench/Composer.tsx`, `apps/web/src/workbench/components.test.tsx`, `packages/shared/remote/methods.ts` (kiểu command list), `src/main/remote/rpc.ts` và `src/main/remote-host-electron.ts` (host command list/send). Tham khảo command handler `python/app_presets/pi/extensions/kaneo-mcp/index.ts`; không sửa extension/API trong scope này.
- **Existing constraints:** giữ Kaneo binding API/generation hiện tại; không chuyển API key, host identity hoặc session ID authority về browser. Li Web chỉ gửi qua host/session đã pair; không thay `task_run`, presence hay binding protocol.

## Objective

- Gõ `/kaneo` trong Li Web phải tìm được `/kaneo-card`, và command được hiển thị/chèn với đúng một dấu `/`.
- Không tạo cơ chế gán card thứ hai: khi command được gửi lúc session idle, host Pi chạy extension hiện có trên đúng session; không biến lệnh đã chọn thành prompt nói chuyện với model.

## Scope

- **In:** chuẩn hóa tên command tại Web boundary; sửa Composer picker + regression tests; thêm static `apps/web/public/404.html` vì production Pages hiện trả 200 cho URL không tồn tại; push branch và deploy bundle lên Cloudflare Pages project `li-quoc-app`.
- **Out:** Kaneo API/backend, `kaneo-mcp` binding logic, LiX Desktop slash-catalog implementation, UI picker/search card riêng, command chạy khi session đang bận, đổi hosting/platform hoặc host sync.

## UX Baseline

| # | Requirement | Pass condition |
|---|---|---|
| 1 | Keyboard | `/` mở command list; Arrow/Enter chọn đúng lệnh; Escape đóng và giữ input có thể sửa. |
| 2 | Focus | Focus hiện tại của Composer giữ nguyên; không thêm focus ring/chrome mới. |
| 3 | A11y | Popover tiếp tục dùng listbox/option và accessible name hiện có. |
| 4 | Viewport | Không tràn ngang ở 320–1440px; popover vẫn nằm trong viewport. |
| 5 | States | Danh sách rỗng/loading giữ hành vi hiện tại; không giả báo đã bind khi chỉ mới gửi. |
| 6 | Nhất quán | Dùng styles/tokens hiện có trong `apps/web/DESIGN.md`; không thêm dependency. |
| 7 | Platform | Web PWA; không đổi host RPC hay Pi TUI. |
| 8 | Copy | Tên command xuất hiện đúng một dấu `/`, ví dụ `/kaneo-card`. |

## Thuật ngữ

- **Slashless command name:** tên trong `CommandInfo` không có `/` đầu, ví dụ `kaneo-card`.
- **Session binding:** liên kết server-side giữa một Pi session cụ thể và một Kaneo task; không phải task assignee hay worker lease.

## Assumptions

1. Owner muốn dùng slash command trực tiếp như TUI, không cần nút/picker riêng để tìm card.
2. LiX desktop đã có command list và host-side extension dispatch; task này chỉ sửa Li Web command discovery/selection.
3. **Owner decision 2026-11-27:** scope đầu tiên chỉ hỗ trợ lệnh khi session idle. Không thêm busy dispatch; Pi không thực thi extension commands qua `steer/followUp`.
4. Li Web command list có thể nhận tên slash-prefixed từ host; Web-local state sẽ chuẩn hóa chúng, không đổi shared RPC contract.
5. **Owner decision 2026-11-28:** cho phép push + production deploy; đồng ý thêm 404 page tối giản khi live probe xác nhận URL không tồn tại trả HTTP 200.

## Open Questions

- Không còn product-scope question cho bản đầu: owner chốt idle-only ngày 2026-11-27.
- Runtime-missing contract: `command.list`/extension inventory có thể là disk probe, không phải proof worker đã load. Nếu `kaneo-card` vắng khỏi catalog, picker không gợi ý. UAT chỉ gửi lệnh khi runtime đã được xác nhận; nếu command không được consume hoặc `turn.send` chỉ accepted mà không có binding evidence, giữ PARTIAL. Không test bằng cách gửi slash lệnh chưa đăng ký vì Pi có thể đưa text đó cho LLM.

## Approach

- Chọn: chuẩn hóa `command.name` về dạng slashless ngay khi `Workbench.refreshSessionContext` nhận response, dùng `name.replace(/^\/+/, '')`; Composer tiếp tục sở hữu đúng một slash cho match, display và insertion.
- Lý do: host catalog hiện có thể trả `/name`, còn Web Composer query là `name`; thống nhất ở biên Web sửa một lỗi chung, không thêm logic đặc biệt cho Kaneo hay đổi contract LiX Desktop.
- Pre-lock rút gọn: chỉ sửa tên trong Composer đã ổn định; không đổi journey, layout hoặc visual direction.
- Không sửa server binding: `/kaneo-card` vẫn đi qua Pi extension và binding API hiện hữu trên host. Không gửi credential tới browser.

## Bỏ qua

- Không thêm Kaneo endpoint, binding table, principal, credential hay extension command mới; binding API hiện tại là authority.
- Không thêm card search/picker riêng; owner yêu cầu slash command tương tự TUI.
- Không hỗ trợ bind lúc session bận; owner đã chốt idle-only.

## Risks

- `command.list`/extension inventory hiện có thể là disk probe; tên command xuất hiện trong picker chưa chứng minh worker thật đã load extension.
- Pi có thể đưa unknown extension slash command thành prompt thường. UAT phải xác nhận command được host consume, không tạo assistant/model turn ngoài ý muốn.
- Trước bổ sung `404.html`, production `li.quoc.app/__pi-deploy-404-check__` trả HTTP 200; deploy static bundle thiếu 404 sẽ giữ soft-404 và không đạt release preflight.
- Busy composer route qua `steer/followUp`; Pi từ chối extension commands ở hai mode đó. Busy dispatch nằm ngoài scope của correction này.

## Task List

### T1 — Chuẩn hóa command catalog cho Li Web

- **Acceptance:**
  - `Workbench.refreshSessionContext` chuẩn hóa host command list tại boundary: slash-prefixed/slashless/repeated-prefix input thành một Web-local name `kaneo-card`.
  - Regression test nhắm đúng boundary `command.list → Workbench commands → Composer`; host catalog thiếu `kaneo-card` thì picker không tạo entry giả.
  - Gõ `/kaneo` hiện đúng suggestion `/kaneo-card`; suggestion không có `//`.
  - Keyboard khi idle: ArrowDown/ArrowUp đổi option; Enter chọn option (chỉ chèn, chưa gửi); Escape đóng picker và giữ draft; Enter khi picker đóng vẫn gửi như trước.
  - A11y: textarea công bố quan hệ combobox ↔ listbox bằng `aria-controls`/`aria-expanded`/`aria-activedescendant` khi picker mở; focus ở textarea, active option được screen reader nhận biết, option đang chọn tự cuộn vào vùng nhìn thấy.
  - Khi session running, không chặn Arrow/Enter/Escape bằng picker handler; giữ nguyên semantics steer/keyboard hiện tại. Command dispatch busy vẫn ngoài scope.
  - 320/375/1280px: popover không tràn ngang/cắt option; mobile list có thể cuộn trong giới hạn hiện có.
  - Chọn suggestion chèn chính xác `/kaneo-card `; không đổi command text hiện có `/review`, `/model`, prompt và skill commands.
  - Li Web gửi command qua session/host đang chọn; không truyền Kaneo API key, `agentPrincipalId` hay host authority từ browser.
  - Không đổi server `command.list`, `turn.send`, binding API, LiX Desktop catalog hoặc `kaneo-mcp` trong task này.
  - LiX Desktop không đổi source; UAT xác nhận command vẫn xuất hiện và chạy như TUI. Nếu UAT phát hiện gap desktop, tách scope trước khi sửa.
- **UX Contract:**
  - Surface: Operate — Composer slash popover hiện có; không thêm screen/control.
  - Flow: gõ `/` → tìm `/kaneo-card` → chọn → nhập task ID/URL → gửi khi session idle.
  - State: nếu catalog không có command thì không gợi ý; nếu runtime không consume thì không coi `turn.send accepted` là bind thành công. Không đổi generic fallback cho các slash command khác.
  - Keyboard khi idle: ArrowUp/Down chọn, Enter chèn đúng một dấu `/` mà không gửi ngay, Escape đóng popover nhưng giữ nguyên draft. Textarea giữ focus và công bố active option qua combobox/listbox ARIA; lựa chọn luôn visible khi danh sách cuộn.
  - Responsive: popover giữ trong viewport 320–1440px, không tạo horizontal scroll; active option cuộn vào view trong list dài.
  - Busy session: ngoài scope; không intercept key bằng picker — Enter/Arrow/Escape giữ semantics hiện tại.
- **Skills:** `ui-design` (Quick, sửa trong surface ổn định), `flow` (delta flow), `mobile-responsive`.
- **Visual Ref:** `apps/web/DESIGN.md` và command popover hiện có trong `apps/web/src/workbench/Composer.tsx`; không tạo visual artifact mới vì chỉ sửa cách hiện tên.
- **Reproduce:** `cd /d/pcloud/workspace/code/android/pi-app/pi-app && npm run test:unit -- apps/web/src/workbench/components.test.tsx`
- **Verify:** focused unit tests + full `apps/web/src/workbench` suite + `npm run web:typecheck` + `npm run web:build`. Regression: normalization (including repeated prefixes), no fabricated command, idle keyboard/ARIA/scroll, busy behavior unchanged. Confirm `dist/404.html` ships with no JS and fixture is absent from production output. Browser evidence at 320/375/1280px + zero horizontal overflow; after deploy verify root HTTP 200 + unknown URL HTTP 404.
- **Files:**
  - `apps/web/src/workbench/Workbench.tsx` — pattern: `refreshSessionContext()` lấy `command.list`; chuẩn hóa dữ liệu trước `setCommands`.
  - `apps/web/src/workbench/Workbench.tsx` + `apps/web/src/workbench/workbench-layout.test.tsx` — test đúng boundary remote response → local command state, không chỉ test Composer fixture slashless.
  - `apps/web/src/workbench/Composer.tsx` — pattern: `slashMatches` và `.slash-popover`; bổ sung keyboard selection/cancel, Composer giữ ownership của dấu `/` hiển thị.
  - `apps/web/src/workbench/components.test.tsx` — test slash-prefixed/slashless list, keyboard select/Escape, exact insertion, và render tại viewport hẹp.

## Checkpoints

1. Slash-prefixed và slashless fixture đều normalize về cùng một entry; focused component test PASS.
2. Web typecheck/build PASS; UAT xác nhận command hiện một dấu `/` và chọn đúng.
3. UAT bind/show/off PASS trên Li Web và LiX Desktop (owner thực hiện 2026-11-28); command được host consume, không tạo model turn.

## External Review Brief

### Reviewer cần phán
- Dedicated UI/UX/flow lens: popover/keyboard flow còn rõ và giữ Composer visual language không?
- Canonical normalization có đúng đặt ở Workbench boundary không, và có vô tình làm mất slash khi gửi prompt không?
- Tests có bắt cả display, filter và insertion không?
- Existing host command dispatch/binding contract có được giữ nguyên không?

### Reviewer nên đọc trước
- `apps/web/src/workbench/Workbench.tsx`, `apps/web/src/workbench/Composer.tsx`, `apps/web/src/workbench/components.test.tsx`, `packages/shared/remote/methods.ts`.
- `SPEC-2026-11-25-kaneo-ui-agent-binding` và `SPEC-2026-11-10-kaneo-card-agent-collaboration` để xác nhận không lặp backend binding.

### Reviewer không cần phán
- Kaneo server/binding API, extension auth/generation protocol, busy-session command execution, visual redesign.

## User Test

| Hành động | Kết quả kỳ vọng | Chuẩn nhìn |
|---|---|---|
| Trong Li Web gõ `/kaneo` | Có suggestion `/kaneo-card` | Chỉ một dấu `/`; không có `//`. |
| Chọn suggestion bằng ArrowDown + Enter; nhấn Escape ở lượt khác (idle) | Enter chèn `/kaneo-card `; Escape đóng picker nhưng giữ draft | Không gửi prompt khi chỉ đang chọn/hủy; screen reader nhận active option. |
| Khi session đang chạy, gõ `/kaneo` rồi Enter | Giữ nguyên hành vi send/steer trước đó | Không biến Enter thành chọn suggestion. |
| Render picker ở 320px, 375px và 1280px | Các command vẫn đọc/chọn được | Không tràn ngang; popover không bị cắt và cuộn khi dài. |
| Mở URL path không tồn tại trên Li Web | Trang 404 có link về `/` | HTTP status là 404, không phải SPA fallback 200. |
| Gửi `/kaneo-card <task-id>` trong session idle | Host extension bind đúng session/card | Có xác nhận từ host; không xuất hiện câu trả lời model như prompt thường. |
| Gõ `/kaneo-card` để xem, rồi `/kaneo-card off` | Hiện binding rồi gỡ đúng binding | Không đổi session khác/host khác. |
| Lặp flow trong LiX desktop | Command có mặt và thao tác tương đương TUI | UAT trên runtime thật; extension phải được xác nhận loaded. |

Câu hỏi Y/N:
1. Gõ `/kaneo` có tìm thấy `/kaneo-card` không?
2. Tên command có hiện đúng một dấu `/` không?
3. Arrow/Enter/Escape có chọn, chèn, đóng picker đúng mà không gửi nhầm không?
4. Ở viewport hẹp, popover có vừa màn hình và cuộn được không?
5. Bind/show/off có tác động đúng session/card, host consume command và không lộ credential hoặc tạo model turn nhầm không?

## Completion Gates

- [x] External spec review + owner duyệt trước implementation (peer R0 NEEDS REVISION đã xử lý → R1 APPROVED `peer_20261127093140_61a66d46`).
- [x] Focused test, Web typecheck, Web build PASS (workbench 114/114).
- [x] `dist/404.html` tồn tại; production root trả 200, URL không tồn tại trả 404.
- [x] Runtime UAT Li Web + LiX Desktop PASS (owner-attested 2026-11-28).
- [x] Regression test xác nhận busy-session keyboard semantics không đổi, combobox/listbox ARIA link hợp lệ và active option được scroll vào view với danh sách dài.
- [x] Không đổi/deploy Kaneo backend hoặc extension (chỉ đụng Li Web surface + static 404).

## Maintenance Context

- Đọc trước: `apps/web/src/workbench/Workbench.tsx` (`refreshSessionContext` chuẩn hóa command name, strip leading `/`), `apps/web/src/workbench/Composer.tsx` (slash picker idle-only, combobox/listbox ARIA, `scrollIntoView`), tests `components.test.tsx` + `workbench-layout.test.tsx`.
- Invariant: normalization chỉ ở Web boundary; host RPC `command.list`/`turn.send` không đổi; busy session không bị picker intercept key; browser không giữ Kaneo API key.
- Verify: `npm run test:unit -- apps/web/src/workbench` (114 tests), `npm run web:typecheck`, `npm run web:build`.
- Known limitation: idle-only picker (busy dispatch out of scope); `command.list` có thể là disk probe — tên trong picker chưa proof worker loaded; Kaneo notification flow (agent reply/update → Kaneo) còn backlog trên card #202.
- Binding flow: `/kaneo-card <id|url>` / show / off qua `kaneo-mcp` extension trên host; messaging session qua composer dùng `turn.send` không cần TUI.
