# Li Web — Design System

> **Phạm vi:** workbench React thật trong `apps/web/src`; token kế thừa LiX, flow và bố cục theo demo đã duyệt.
> **Source of truth:** CSS variables trong `apps/web/src/styles.css`; không thêm Tailwind hay styling framework thứ hai.
> **Visual evidence:** `apps/web/dev/captures-workbench-demo-integration/`, sinh bằng `node apps/web/scripts/capture-responsive.mjs`. Tất cả fixture/screenshot là dữ liệu tổng hợp local, không phải live-host UAT.
> **Nguồn token:** `src/renderer/src/styles/globals.css` và `tailwind.config.ts`; LiX runtime capture lịch sử: `.agent-workbench/lix-web/lix-runtime-capture.png`.

## 1. Màu và bề mặt

| Token | Light | Dark |
| --- | --- | --- |
| `--bg-base` | `#ffffff` | `#1f1f1f` |
| `--bg-1` | `#f9fafb` | `#252526` |
| `--bg-2` | `#f2f3f5` | `#2b2b2b` |
| `--bg-hover` | `#f0f0f0` | `#313338` |
| `--bg-active` | `#eff0f6` | `#303137` |
| `--message-user-bg` | `#F6F6F7` | `#2b2b2b` |
| `--text-primary` | `#12141a` | `#e4e4e4` |
| `--text-secondary` | `#454d5f` | `#b6bac4` |
| `--text-disabled` | `#6b7280` | `#9297a3` |
| `--border-base` | `#dfe0e6` | `#3b3b3d` |
| `--border-light` | `#f2f3f5` | `#303032` |
| `--brand` | `#7583b2` | `#a0a8c4` |
| `--brand-light` | `#eff0f6` | `#2b2b2b` |
| `--brand-hover` | `#b5bcd6` | `#bac1d7` |
| `--status-live / warn / error / idle` | `#16823c / #a55b00 / #a12b2b / #454d5f` | `#66bd7a / #d7a34d / #dc7777 / #b6bac4` |
| `--focus-border` | `#e1e0ff` | `#a0a8c4` |
| `--diff-added / --diff-removed` | status live / status error | status live / status error |

Nền trắng là mặt chính; fill nhạt chỉ dùng cho user bubble, hover và grouping. Status text dùng màu đạt tương phản trên surface; dot dùng token tương ứng làm tín hiệu phi văn bản.

## 2. Kiểu chữ, focus và elevation

- `--font-sans`: system stack; `--font-mono`: ui-monospace fallback. Base UI 13px, transcript 14px, meta 10–12px.
- Nút và control có vùng chạm tối thiểu 44px. `:focus-visible` dùng outline 2px theo `--brand`; `prefers-reduced-motion` tắt transition/animation.
- Elevation chỉ cho popover, dialog, composer shell và nút “Về cuối”; không dựng card chrome quanh mọi dòng.
- `--composer-shell-shadow`: bóng nhẹ trên surface sáng, bóng sâu hơn ở dark theme.

## 3. Bản đồ workbench

| Bề mặt | Hành vi đã tích hợp | Điểm triển khai |
| --- | --- | --- |
| Top bar | Toggle Sessions và Inspector ở hai đầu; không đặt host chips ở đây. | `.workbench-topbar`, `Workbench.tsx` |
| Host picker | Nằm ở footer SessionRail; menu liệt kê cả host offline/endpoint-error. Rail thu gọn thì mở lại trong một thao tác. | `HostManager.tsx`, `.rail-footer`, `.host-menu` |
| Host dialog | Hai tab “Đã ghép nối”/“Ghép nối mới”; phân biệt chưa ghép host với đã ghép nhưng mất kết nối. Forget có xác nhận; token pair chỉ giữ trong memory. | `HostManager.tsx`, `.host-dialog` |
| SessionRail | Desktop collapse/resize; ≤768px thành drawer + scrim, Escape/scrim đóng và focus quay về toggle. | `SessionRail.tsx`, `.session-rail` |
| Timeline | User bubble lệch phải, assistant/tool output lệch trái; giữ `turn.page`, anchor ≤8px, follow-live và nút “Về cuối”. | `Timeline.tsx`, `.timeline` |
| Composer | Shell gọn; model searchable theo id/name/provider, thinking và Gửi/Steer/Follow-up dùng menu; attach vẫn prompt-only ≤10 MiB. Context chỉ báo từ 80%. | `Composer.tsx`, `.composer-shell` |
| Inspector | Mặc định đóng, Terminal đầu tiên; tabs Terminal/Context/Review/Files/Tree/Agents; export ở menu tiêu đề, không chiếm footer. | `Inspector.tsx`, `.inspector` |
| Files/Terminal | File/folder dùng icon; giữ preview/create/rename. Terminal tiếp tục dùng PTY thật và lọc OSC 52 clipboard write. | `Inspector.tsx`, `features/terminal.ts` |
| Layout prefs | `localStorage['li-web-layout']`: trạng thái rail/Inspector và width thiết bị-local; không gửi lên host. | `Workbench.tsx`, `loadLayout()` |

## 4. Responsive và focus contract

- ≤768px: một cột; SessionRail là drawer, Inspector là bottom sheet; không ép center tối thiểu 360px.
- 769–999px: rail + center; Inspector phủ center và có scrim khi rail mở. Nếu rail đóng, Inspector dock bên phải.
- 1000–1024px: ba track rail/center/Inspector; center tối thiểu 360px.
- ≥1025px: ba pane có separator kéo được; center vẫn ≥360px. Width solver shrink Inspector trước, rồi rail.
- Drawer/Inspector modal trap Tab, Escape đóng, focus trở lại toggle. Inspector docked không mang `aria-modal`.
- Captures không overflow ngang tại 320/375/414/768/769/999/1000/1024/1025/1280/1440; 1024px chụp đủ 4 tổ hợp rail/Inspector. Có drawer, host picker, Inspector, model/thinking menus và host/pair dialogs.

## 5. Theme và giới hạn sản phẩm

- Theme bootstrap hiện có và terminal palette được giữ; không mang toggle Sáng/Tối của demo vào UI.
- Demo HTML, wrapper, caption/banner, scene buttons và fake data chỉ là tài liệu/fixture QA; không nhúng vào production Workbench.
- Không đổi RPC, protocol, gateway, pairing authorization, model availability, file authorization hay terminal safety. Screenshot chỉ lưu local; không upload.
- Vite fixtures ở `src/dev` dùng host/session/model giả lập, không kết nối host thật và không chứng minh live UAT.
