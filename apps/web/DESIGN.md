# Li Web — Design Tokens (T3)

> **Trạng thái:** VERIFIED hai nguồn (spec T3: "token values từ LiX source + đối chiếu runtime
> screenshot").
>
> - **Source of truth (mã nguồn):** `src/renderer/src/styles/globals.css` (block `:root` light —
>   dòng 1-180; block `.dark` — dòng 182-260) + `tailwind.config.ts` (fontSize 2xs→2xl,
>   surface tiers, motion durations).
> - **Runtime evidence:** `.agent-workbench/lix-web/lix-runtime-capture.png` — LiX v0.7.13
>   (electron-vite dev) chạy thật trên Windows, light theme, chụp 2026-11-17 22:31. Ảnh README
>   (`doc/assets/readme/en/overview.png`, `phone.png`) chỉ là historical marketing (v0.6.0
>   "pi Desktop"), KHÔNG dùng làm evidence token.
>
> **Nguyên tắc:** Preserve the incumbent — Li Web kế thừa visual language của LiX, không tạo
> visual world mới. Mọi giá trị dưới đây copy nguyên văn, không "cải tiến".

## 1. Surfaces & backgrounds

| Token | Light | Dark (VS Code Dark Modern) | Ghi chú |
| --- | --- | --- | --- |
| `--bg-base` | `#ffffff` | `#1f1f1f` | editor.background |
| `--bg-1` | `#f9fafb` | `#252526` | list / cards |
| `--bg-2` | `#f2f3f5` | `#2b2b2b` | textCodeBlock |
| `--bg-3` | `#e5e6eb` | `#313131` | input.background |
| `--bg-hover` | `#e8eaed` | `#313338` | list hover |
| `--bg-active` | `#e3e4e8` | `#3a3a3d` | |
| `--message-user-bg` | `#F6F6F7` | `#2b2b2b` | |

Runtime check (capture): sidebar nền trắng thuần `--bg-base`, hàng session hover lift nhẹ —
khớp bảng trên. Dark mode của Web chưa bật trong T3 (chỉ light-first theo capture); cả hai bộ
giá trị đã chốt sẵn cho T4.

## 2. Text

| Token | Light | Dark | Ghi chú |
| --- | --- | --- | --- |
| `--text-primary` | `#12141a` | `#cccccc` | tránh pure black |
| `--text-secondary` | `#454d5f` | `#9d9d9d` | descriptionForeground |
| `--text-disabled` | `#c9cdd4` | `#6e7681` | editorLineNumber |

Runtime check: tiêu đề session `#12141a` đậm vừa, meta "22:31 17 thg 11" secondary xám nhẹ — khớp.

## 3. Brand (AOU Purple) + semantic

| Token | Light | Dark |
| --- | --- | --- |
| `--brand` | `#7583b2` | `#8b93b0` |
| `--brand-light` | `#eff0f6` | `#2b2b2b` |
| `--brand-hover` | `#b5bcd6` | `#a0a8c4` |
| `--aou-1 … --aou-10` | `#eff0f6 → #0d101c` | `#252528 → #f2f2f2` |
| `--primary-semantic` | `#165dff` | `#4daafc` |
| `--success-semantic` | `#00b42a` | `#3fb950` |
| `--warning-semantic` | `#ff7d00` | `#d29922` |
| `--danger-semantic` | `#f53f3f` | `#f85149` |
| `--status-live / warn / error / idle` | `#00b42a / #ff7d00 / #f53f3f / #454d5f` | `#3fb950 / #d29922 / #f85149 / #9d9d9d` |
| `--diff-added / --diff-removed` | `#059669 / #e11d48` | `#34d399 / #fb7185` |

Runtime check: spinner "đang chạy" trên session `li.quoc.app` trong capture dùng đúng cam
`--warning-semantic #ff7d00` — accent ≤10% mặt hình, brand purple chỉ ở selected row tint.
Li Web status dot (online/connecting/error) map thẳng vào `--status-*`.

## 4. Border, focus, elevation

| Token | Light | Dark |
| --- | --- | --- |
| `--border-base` | `#dfe0e6` | `#2b2b2b` |
| `--border-light` | `#f2f3f5` | `#252526` |
| `--focus-border` | `#e1e0ff` | `#3794ff` |
| `--focus-shadow` | `0 2px 20px rgba(225,224,255,.6)` | `0 0 0 1px #3794ff55, 0 2px 12px rgba(0,0,0,.35)` |
| `--composer-shell-radius` | `14px` | (giữ nguyên) |
| `--main-chat-surface-radius` | `16px` | (giữ nguyên) |

Runtime check: search box "Tìm phiên hoặc tin nhắn đầu tiên" bo ~7-8px hairline
`--border-base`, không drop-shadow — elevation tối giản. Host card của Li Web dùng cùng kiểu
(10px radius, 1px border, nền `--bg-1`).

## 5. Typography & motion

- `--font-sans`: system stack (`system-ui, -apple-system, …` — LiX từ chối Inter vì thin-text).
- `--font-mono`: `'Geist Mono', ui-monospace, …` — Web dùng fallback ui-monospace (không bundle
  Geist Mono ở T3; T4 cân nhắc copy nếu cần).
- Type scale: `2xs 10px · xs 11px · sm 12px · base 13px (UI chính) · lg 14px · xl 16px ·
  2xl 20px` — **cấm `text-[Npx]` tự do** (rule tailwind.config.ts).
- Motion: `--motion-fast 150ms · --motion-normal 200ms · --motion-slow 240ms ·
  --motion-ease cubic-bezier(0.22, 1, 0.36, 1)` — phản hồi desktop-độ-tốc, không animation dài.

## 6. Li Web surface map (T3 shell)

| Bề mặt | Token dùng |
| --- | --- |
| Nền app | `--bg-base` |
| Host/pair card | `--bg-1` + border `--border-base`, radius 10px |
| Host row | `--bg-base`, hover `--bg-hover` |
| Status dot | `--status-live / --status-warn / --status-error / --status-idle` |
| Nút chính | `--brand-light` nền, border `--brand`, hover `--brand-hover` |
| Nút "Quên" (danger-outline) | chữ `--status-error`, border `--status-error` |
| Pair textarea | mono 12px, border `--border-base`, focus `--brand` |
| Notice lỗi / thành công | `--status-error / --status-live` |

## 7. Dark mode & theme bootstrap

Web copy pattern anti-FOUC của LiX (`index.html` inline script, key `lix-web-ui` trong
localStorage; class `dark` trên `<html>`; follow `prefers-color-scheme` khi chưa chọn). Bộ
giá trị dark đã chốt ở bảng trên — T4 mới xây UI switch, T3 chỉ bootstrap class.

## 8. Điều đã chủ đích KHÔNG mang sang (T3)

- Tailwind pipeline: shell T3 dùng CSS variables thuần (subset trên) thay vì kéo tailwind +
  shadcn — T4 workbench sẽ quyết định setup đầy đủ khi có composer/timeline.
- Shiki themes, scrollbar overlay, composer shadows chi tiết — ngoài scope T3.
