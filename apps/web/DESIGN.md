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
- Nút và control có vùng chạm tối thiểu 44px. Keyboard focus dùng cue rõ; search fields không có outline box, chuyển sang soft surface + weight. `prefers-reduced-motion` tắt transition/animation.
- Elevation chỉ cho popover, dialog, composer shell và nút “Về cuối”; không dựng card chrome quanh mọi dòng.
- `--composer-shell-shadow`: bóng nhẹ trên surface sáng, bóng sâu hơn ở dark theme.

## 3. Bản đồ workbench

| Bề mặt | Hành vi đã tích hợp | Điểm triển khai |
| --- | --- | --- |
| Top bar | Toggle Sessions trái; theme toggle và Inspector bên phải; không đặt host chips ở đây. | `.workbench-topbar`, `Workbench.tsx` |
| Host picker | Nằm ở footer SessionRail; menu liệt kê cả host offline/endpoint-error. Rail thu gọn thì mở lại trong một thao tác. | `HostManager.tsx`, `.rail-footer`, `.host-menu` |
| Host dialog | Hai tab “Đã ghép nối”/“Ghép nối mới”; phân biệt chưa ghép host với đã ghép nhưng mất kết nối. Forget có xác nhận; token pair chỉ giữ trong memory. | `HostManager.tsx`, `.host-dialog` |
| SessionRail | Desktop collapse/resize; ≤768px thành drawer + scrim, Escape/scrim đóng và focus quay về toggle. Running session có chấm xanh; ô search không có icon trang trí. | `SessionRail.tsx`, `.session-rail`, `.live-dot` |
| Timeline | Prompt bubble lệch phải, assistant/tool output trái; giữ `turn.page`, anchor ≤8px, follow-live và “Về cuối”. Trong lượt chạy chỉ lộ tool rows thật + một activity cue; settled mới hiện transcript đầy đủ. Copy prompt/answer nằm ngoài bubble/dưới answer tương ứng; tool failure chỉ có dot nhỏ, chi tiết mở chủ động. Reset/gap resync giữ nội dung hiện tại, buffer patch mới và thay snapshot không làm trắng màn. | `Timeline.tsx`, `.timeline` |
| Extension dialogs | Ask User dùng nhóm lựa chọn dạng card gọn, category và số thứ tự; custom answer riêng; selected/focus rõ, submit có pending/error, responsive một cột mobile và hai cột khi đủ rộng. | `ExtensionDialogs.tsx`, `.ask-user` |
| Composer | Shell gọn; model searchable theo id/name/provider, thinking và Gửi/Steer/Follow-up dùng menu; attach vẫn prompt-only ≤10 MiB. Context chỉ báo từ 80%. | `Composer.tsx`, `.composer-shell` |
| Inspector | Mặc định đóng; chỉ hiện Terminal + menu export gọn. Max width = một nửa viewport (≥1000px), center giữ ≥360px; theme terminal theo theme app (localStorage → class → OS) và repaint live khi toggle. Không có tab strip/divider/khung PTY thừa. | `Inspector.tsx`, `.inspector` |
| Phiên mới | Composer nằm đáy như session thường; không landing copy; Inspector toggle luôn hiển thị; tin nhắn đầu vẫn tạo session. Host cuối dùng được nhớ device-local (`li-web-last-host`) và restore khi tải lại. | `Workbench.tsx`, `.empty-session` |
| Terminal | Chỉ Terminal lộ trong Inspector theo owner UAT; PTY thật, giữ input/resize/close và lọc OSC 52. Các panel Files/Review/Context/Tree/Agents/Settings còn code nhưng hiện ẩn, không có tab navigation. | `Inspector.tsx`, `features/terminal.ts` |
| Layout prefs | `localStorage['li-web-layout']`: trạng thái rail/Inspector và width thiết bị-local; không gửi lên host. | `Workbench.tsx`, `loadLayout()` |

## 4. Responsive và focus contract

- ≤768px: một cột; SessionRail là drawer, Inspector là bottom sheet; không ép center tối thiểu 360px.
- 769–999px: rail + center; Inspector phủ center và có scrim khi rail mở. Nếu rail đóng, Inspector dock bên phải.
- 1000–1024px: ba track rail/center/Inspector; center tối thiểu 360px.
- ≥1025px: ba pane có separator kéo được; center vẫn ≥360px. Width solver shrink Inspector trước, rồi rail.
- Drawer/Inspector modal trap Tab, Escape đóng, focus trở lại toggle. Inspector docked không mang `aria-modal`; menu export hỗ trợ Arrow/Home/End/Escape.
- Scrollbar chrome ẩn ở page và nested panes nhưng `overflow` vẫn cuộn. Copy actions chỉ lộ khi đúng message hover/focus (touch giữ action khả dụng, đặt ngoài bubble để không kéo chiều cao tin nhắn).
- Captures synthetic không overflow ngang tại 320/375/414/768/769/999/1000/1024/1025/1280/1440; 1024px chụp đủ 4 tổ hợp rail/Inspector. Có drawer, host picker, Terminal/export menu, Ask User ở 320/375/1280 light+dark, message copy hover, model/thinking menus và host/pair dialogs.

## 5. Theme và giới hạn sản phẩm

- Theme bootstrap light/dark hiện có và terminal palette được giữ; nút đổi sáng/tối nằm ở topbar, lưu device-local vào `lix-web-ui`. Toggle của preview harness không được port nguyên trạng.
- Demo HTML, wrapper, caption/banner, scene buttons và fake data chỉ là tài liệu/fixture QA; không nhúng vào production Workbench.
- Không đổi RPC, protocol, gateway, pairing authorization, model availability, file authorization hay terminal safety. Screenshot chỉ lưu local; không upload.
- Vite fixtures ở `src/dev` dùng host/session/model giả lập, không kết nối host thật và không chứng minh live UAT.
