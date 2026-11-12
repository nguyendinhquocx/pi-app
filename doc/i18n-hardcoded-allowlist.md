# Hard-coded user-facing copy allowlist

Kết quả audit built-in strings khi Việt hóa (SPEC-2026-11-09-pi-app-vietnamese-ui-startup).
Mọi literal user-facing KHÔNG liệt kê ở đây đã được localize qua i18n catalog (`locales/*/`)
hoặc helper `src/main/ui-language.ts` (`uiText`/`uiLanguage`). Các nhóm sau GIỮ NGUYÊN có chủ đích:

## Brand / provider / model names
- `pi Desktop`, `pi Remote`, `pi` — product brand (tray tooltip, dialog title, notification project label).
- Tên model/provider trong presets và catalogs: `Claude`, `Codex`, `GLM`, `智谱 GLM`, `DeepSeek`, `Qwen`, `Gemini`, `OpenAI`, `Anthropic`… (`model-provider-presets.ts`, models settings) — không dịch tên riêng.
- Icon set names (Phosphor/Lucide/Fluent/Hugeicons/Iconoir) — catalog keys.

## Protocol / config literals
- URL, `pidesk://`, `host:port` samples, env var names, `reasoning_effort`, `provider/modelId`, CSS placeholders (`:root{...}`).
- `codex-theme-v1:` / `pi-theme-v1:` import strings.
- Validation messages trả về cho IPC schema (`image too large`, `unknown settings key`) — protocol-level, không render trực tiếp.

## Extension / user content
- `src/main/pi-packages-sync.ts` — `git:github.com/justhil/pi-search`, `pi-fast-context`: entry nhận diện package mà USER đã cài từ terminal pi (repo thật nằm ở upstream); đổi sang fork sẽ sai vì fork không host các package này.
- `src/main/extension-compat/extension-probe.ts:173` — comment parse GitHub URL cho extension mẫu upstream.
- Command palette search keywords CJK (`command-palette.tsx`) — từ khóa tìm kiếm, không phải label hiển thị.
- Nội dung do model/extension/user tạo (timeline tool output, session titles, model replies) — không dịch.

## Diagnostic / OS-provided copy
- Electron/OS role labels trong macOS app menu (`appMenu`, `undo`, `copy`…) — hệ điều hành cung cấp, theo OS locale; menu custom labels (Chỉnh sửa/Tài liệu) đã localize. Menu build lúc startup — đổi ngôn ngữ cần restart app để ăn.
- Error strings chỉ ghi log (`console.error/warn`, `electron-log`) — không hiển thị UI.
- ASR/SDK diagnostics hiển thị trong voice settings probe (`codex-auth.ts` details, `sdk-manager.ts`, `pi-sdk.ts`…) — giữ tiếng Anh trung tính như technical error copy; đây là ranh giới scope đã chốt trong spec (Open Questions: giữ nguyên và báo thay vì dịch nhầm).

## Behavior notes (hidden startup, Windows)
- Auto update check khởi tạo trong `win.once('show')`: launch ẩn từ login item chưa bao giờ `show` → auto-check chỉ chạy sau lần đầu user mở cửa sổ. Chủ đích: tránh dialog updater hiện lên khi app nằm trong tray.
- Toggle startup trong dev (unpackaged) không đụng registry (`app.isPackaged` guard) — `process.execPath` là electron.exe.
