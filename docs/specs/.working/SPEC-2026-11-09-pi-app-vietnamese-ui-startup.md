# Spec: Pi-app — giao diện tiếng Việt và khởi động cùng Windows

## Context Snapshot
- Project/module: `nguyendinhquocx/pi-app`, Electron desktop + Android companion `pi Remote`.
- Provenance: fork của `justhil/pi-app`; fork hiện bằng upstream (`ahead=0`, `behind=0`). Local checkout cũ `pi-app-main` là snapshot không có `.git`; implementation dùng Git clone từ fork tại `D:\pcloud\workspace\code\android\pi-app\pi-app`.
- Stack: Desktop Electron 43 + React/i18next; Android Kotlin + Jetpack Compose; Desktop dùng npm (`package-lock.json`), Android dùng Gradle wrapper.
- Current behavior: desktop có English/Chinese, fresh install chọn Chinese nếu system locale là zh, còn lại English; Android có System/English/Chinese và mặc định System. Cả hai chưa có Vietnamese. Windows có tray/hide-on-close nhưng chưa có auto-start setting.
- Desired behavior: UI built-in có Vietnamese trên desktop và Android; fresh install mặc định Vietnamese; Windows có toggle chạy cùng user login và tùy chọn khởi động ẩn trong tray.
- Relevant files:
  - `src/renderer/src/lib/i18n.ts`, `src/renderer/src/locales/{en,zh}/`, `src/main/default-language.ts`, `src/main/config-store.ts`
  - `src/renderer/src/features/settings/settings-general-appearance.tsx`
  - `apps/mobile/androidApp/src/main/res/{values,values-zh,xml}/`
  - `apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/AppLocale.kt`, `UiPrefs.kt`, `ui/inbox/InboxScreen.kt`, `ui/Format.kt`
  - `src/main/index.ts`, `src/main/window.ts`, `src/main/tray.ts`, `src/main/ipc/handlers/settings.ts`, `src/main/ipc/schemas.ts`
- Constraints: giữ English + Simplified Chinese; giữ app/package IDs hiện tại; không đổi UI Pi agent, nội dung model, tên model/provider, command/skill/extension do bên ngoài cung cấp hoặc text do người dùng tạo.

## Objective
- Việt hóa toàn bộ UI built-in của Desktop và Android trong cùng một thay đổi source; mỗi platform vẫn build thành artifact riêng.
- Thiết lập Vietnamese là locale cho cài mới, không ghi đè ngôn ngữ đã được lưu rõ ràng trên bản đang dùng.
- Khi bật Windows startup, pi Desktop tự mở cùng user login; nếu bật thêm hidden thì cửa sổ không lóe lên, gateway vẫn hoạt động và có thể khôi phục từ tray.
- Android pi Remote nhận session list, turn patches, thinking và answer trực tiếp, không cần thoát vào lại session để đồng bộ.

## Scope
- In:
  - Bổ sung Vietnamese cho desktop i18next namespaces và Android resources; hoàn chỉnh language selectors, locale config, system tray/menu và các hard-coded built-in labels tìm thấy trong phạm vi UI.
  - Giữ các lựa chọn English/Chinese; lưu ngôn ngữ độc lập theo từng thiết bị/cài đặt.
  - Windows-only: `Start with Windows` và `Start hidden in tray` trong Settings → General; hidden chỉ áp dụng khi Windows khởi động app, mở app thủ công vẫn hiện cửa sổ.
  - Đổi nguồn kiểm tra release mặc định sang fork để custom build không gợi ý cài bản upstream làm mất phần tùy chỉnh.
  - Windows Desktop ↔ Android pi Remote: canonicalize session key xuyên wire/client; không drop turn/UI events do khác separator; bảo toàn live stream qua open/reopen, sequence gap và reconnect; trạng thái gửi không được treo vô hạn.
  - Build Windows installer và Android APK để test cục bộ; không tạo GitHub Release.
- Out:
  - Đồng bộ language setting giữa desktop và Android; hai app lưu preference riêng.
  - Việt hóa câu trả lời của model, extension/skill/command do người dùng cài, native UI của Windows/Android, README tiếng Trung/Anh toàn bộ.
  - Autostart Linux/macOS, sửa ProDesk host, thay Pi SDK hoặc thiết kế lại toàn bộ giao diện.

## UX Baseline
1. Keyboard: language selector và Windows switches dùng control hiện có, Tab/Space/Enter theo thứ tự hợp lý.
2. Focus: giữ focus indicator/semantics của component hiện tại; không làm switch thành control custom.
3. A11y: label/state gắn đúng với switch/selector; Android TalkBack đọc tên và trạng thái; tiếng Việt không bị cắt.
4. Viewport: desktop settings resizable; Android kiểm tra compact phone và font scale lớn, không tràn/cắt label.
5. States: lựa chọn locale hiện rõ; lỗi cập nhật Windows startup hoàn nguyên switch và báo cách khôi phục; hidden bị vô hiệu hóa khi startup tắt.
6. Nhất quán: dùng `SettingRow`/`Switch` hiện có trên desktop và Compose `Segmented` hiện có trên Android; không thêm style system.
7. Platform: Windows startup dùng login item theo user; Android dùng app locale/native resources.
8. Copy: tiếng Việt ngắn, trung tính, không dịch tên model/provider/command; ngôn ngữ trong selector hiển thị tên tự thân.

## Approach
- Chọn: dùng catalog native hiện có của từng UI (`i18next` JSON trên desktop, `strings.xml` trên Android), thêm `vi` cho cả hai và mở rộng parity tests. Không tạo generator dịch chung.
- Lý do: hai app có key set, runtime và vòng đời locale khác nhau; generator mới thêm mapping/build failure surface nhưng không làm hai UI dùng chung một artifact. Một source revision cập nhật cả hai catalog; Windows installer và Android APK vẫn build riêng, preference language vẫn riêng từng cài đặt.
- Fresh install mặc định `vi`; preference đã lưu được giữ. Desktop chọn `vi` ngay ở initial i18n để tránh flash English trước khi IPC hydrate. Android phân biệt "chưa chọn lần nào" với "đã chủ động chọn System": thiếu preference thì khởi tạo `vi` trước composition; chọn System phải lưu marker rõ để first-run initializer không ghi đè.
  - Android 13+: nếu chưa initialized và không có app locale được chọn, ghi per-app locale `vi` trước khi dựng UI; lựa chọn System trong app ghi preference `system` và clear app locale, lần sau không bị ép lại `vi`.
  - Android 12 trở xuống: preference thiếu nghĩa là `vi`; preference `system` đã lưu thì `wrap()` dùng system locale.
  - `AppLocale.tag/fromTag` phải round-trip `vi`/`vi-*`; app language list Android phải khai báo `vi`.
- Windows startup mặc định opt-in (`startOnLogin=false`); khi user bật, `startHidden=true` là default nhưng có toggle để hiện cửa sổ. Dùng `app.setLoginItemSettings` theo user, không đòi admin/task scheduler. Không dùng `openAsHidden`: startup hidden dùng custom argv `--hidden`, đăng ký cùng `path: process.execPath`; `getLoginItemSettings` phải nhận đúng cùng `path` và `args`.
  - Main process chỉ coi `--hidden` là chế độ hidden-start; `ready-to-show` bỏ `show()` ở lần launch này. Launch thủ công không có arg vẫn hiện cửa sổ; tray/second-instance khôi phục cửa sổ; gateway vẫn start.
  - Typecheck bắt buộc chạy với Electron `43.7.7` trong lockfile; nếu type/API khác docs thì sửa theo API của version đang khóa, không đoán.
- Android artifact giữ `applicationId=dev.pi.remote` theo lựa chọn user: upstream APK ký bằng keystore mà fork không có, nên custom APK không thể cài đè trực tiếp. Cài bản Việt hóa sẽ cần gỡ app upstream trước; app-local preferences/host pairing sẽ mất và phải pair lại. Build local không set release-keystore env, ký bằng debug key của máy build; không phát hành APK public.
- Custom Desktop build có một nguồn repo mặc định `nguyendinhquocx/pi-app` cho update checker và mọi link mở release. Giữ override `PI_DESKTOP_GITHUB_REPO` nếu cần test; build không env không được trỏ upstream. Trước release đầu tiên của fork, manual Check update có thể báo `no_release`; đây là trạng thái chuyển tiếp, không phải build failure.
- Task 5 dùng canonical session identity ở biên protocol/client; `entry.sessionFile` raw chỉ dùng host I/O. Android sync tuần tự snapshot/live patches theo `(epoch, seq)`, buffer patch đến trước open response, dedupe overlap, bounded resync khi gap/overflow, bỏ open response cũ. `turn.send` ACK nghĩa host nhận lệnh, không đồng nghĩa model đã hoàn tất.

## Flow delta

Current:
1. Windows login → không có pi Desktop tự chạy.
2. Muốn điện thoại truy cập → mở pi Desktop, rồi có thể đóng X để ẩn tray.
3. Android/desktop chọn locale riêng; chưa có Vietnamese.

Target:
1. User bật `Khởi động cùng Windows` một lần trong General Settings.
2. Nếu `Khởi động ẩn trong khay` đang bật, lần Windows login sau app khởi động ẩn, gateway chạy; mở từ tray khi cần.
3. Nếu mở app bằng tay, cửa sổ vẫn hiện; nếu tắt startup, Windows login không mở app.
4. Cài mới Desktop hoặc Android → Vietnamese mặc định; user đổi ngôn ngữ riêng trên từng thiết bị nếu muốn.

Pre-lock rút gọn: chỉ thêm lựa chọn locale và hai setting rows vào màn hình General/menu hiện có; không thêm màn hình hay đổi visual world.

## Assumptions
- User muốn UI built-in của cả Android và Desktop, không chỉ Settings.
- Cài đặt Windows phải giữ app ID/data; Android custom APK dùng cùng applicationId nhưng vì signature khác sẽ thay app gốc theo lựa chọn đã xác nhận.
- Ngôn ngữ mới mặc định Vietnamese chỉ áp cho cài mới/no preference; preference đã lưu được bảo toàn.
- Bản Windows được build để cài cục bộ trên laptop; không phát hành/publish artifact trong task này.

## Open Questions
- Không còn câu hỏi blocking. Nếu project scan phát hiện strings không thuộc UI built-in hoặc platform API không hỗ trợ, giữ nguyên và báo cụ thể thay vì dịch nhầm.

## Bỏ qua
- Không tạo nguồn dịch chung + codegen; hai catalog native được cập nhật đồng bộ trong cùng source revision và khóa drift bằng test parity.
- Không bật autostart mặc định cho mọi người cài fork; opt-in một lần là đủ để app tự chạy những lần sau.
- Không cố giữ pairing Android cũ: chữ ký khác khiến cài đè không thể, user đã chọn gỡ app gốc và pair lại.

## Risks
- UI có thể còn text hard-coded ngoài catalog; cần audit built-in literals, notification copy và platform menus, rồi ghi allowlist rõ cho dynamic/non-product strings.
- Android 13+ per-app locale rỗng có nghĩa System; first-run initializer phải có marker để set `vi` đúng một lần mà không đè saved `system`. Trước app lần đầu mở, Android system language page không phân biệt được "chưa chọn" với "System"; behavior mặc định là ép `vi`, sau đó user có thể chọn System từ app.
- Windows login item có thể launch app trước khi mạng sẵn sàng; gateway phải retry/reconnect theo logic hiện tại, không chặn UI.
- Hidden startup dùng custom `--hidden` arg; nếu packaged OS bỏ/đổi args thì cửa sổ có thể lóe. Phải typecheck locked Electron version và smoke packaged Windows thật.
- Android gỡ app gốc sẽ xóa host profiles/pairing keys local; host ProDesk/laptop/session không bị xóa, nhưng phải pair lại từ QR.
- Fork chưa có release đầu: manual update check báo `no_release`; auto-check chỉ ghi log. Khi phát hành fork sau này mới hết trạng thái này.
- Chromium `vi` language pack làm tăng kích thước installer một ít; chấp nhận để built-in Chromium locale surfaces không rơi về en/zh.

## Task List

### Task 1: Desktop Vietnamese locale + fresh-install default
- Acceptance:
  - Language selector có Tiếng Việt, English, 简体中文; cài mới dùng `vi` ngay frame đầu, không flash English; saved `en`/`zh`/`vi` hiện có được giữ.
  - Toàn bộ built-in desktop UI strings có bản `vi`, gồm renderer catalogs, tray/notification/completion preview và menu macOS; dynamic model/provider/extension text không dịch.
  - `AppLanguage`, `LanguageChoice`, IPC schema và all language normalizers chấp nhận `vi`; `document.documentElement.lang` map thành `vi`.
  - Catalog parity test đệ quy so key paths + số lần xuất hiện từng interpolation placeholder ở cả 12 namespaces `en`/`zh`/`vi`; `completion-preview` tests kiểm tra ba locale.
  - Audit hard-coded user-facing literals trong `src/main`, `src/renderer`, `packages/shared`; mỗi literal thuộc UI built-in phải được localize hoặc ghi vào allowlist rõ ràng (brand, dynamic data, protocol/code, user/extension content).
  - `electron-builder.yml` giữ Chromium locale packs cho `en-US`, `zh-CN` và thêm `vi` để native Chromium surfaces không thiếu locale.
- UX Contract:
  - Surface: Settings → General và các màn desktop hiện tại, không thay layout.
  - States: `vi`, `en`, `zh`; saved choice được hydrate sau launch.
  - Keyboard/A11y: dùng button/setting patterns hiện hữu; focus/selected state không đổi.
  - Copy: dùng tiếng Việt trung tính, không thêm hướng dẫn chỉ để lấp chỗ trống.
- Skills: `ui-design`, `implement`.
- Visual Ref: `src/renderer/src/features/settings/settings-general-appearance.tsx` và sibling settings; giữ style hiện tại.
- Reproduce: `npm run test:unit -- src/main/default-language.test.ts src/renderer/src/lib/__tests__/i18n-startup.test.ts`.
- Verify: catalog key/placeholder parity + `packages/shared/completion-preview.test.ts` + `npm run typecheck` + `npm run test:unit`.
- Files:
  - `src/renderer/src/locales/vi/*.json` — pattern: `src/renderer/src/locales/en/*.json` và `zh/*.json`.
  - `src/renderer/src/lib/i18n.ts` — types, initial locale, normalization, document lang, resource registration.
  - `src/main/default-language.ts`, `default-language.test.ts`, `src/main/config-store.ts`, `src/main/ipc/schemas.ts` — default, persisted type và IPC enum.
  - `src/renderer/src/features/settings/settings-draft.ts`, `settings-draft-context.tsx`, `settings-general-appearance.tsx` — type/normalization/selector hiện có.
  - `src/main/tray.ts`, `src/main/index.ts` — tray và native macOS menu labels.
  - `src/main/desktop-alerts.ts`, `packages/shared/completion-preview.ts`, `packages/shared/completion-preview.test.ts` — notification copy/fallbacks.
  - `electron-builder.yml` — Chromium locale packs.
  - Tạo `src/renderer/src/lib/__tests__/i18n-catalog-parity.test.ts`; mở rộng `i18n-startup.test.ts` cho fresh `vi` và saved `en`/`zh`/`vi`.

### Task 2: Android Vietnamese locale + fresh-install default
- Acceptance:
  - Android menu có System, Tiếng Việt, English, 简体中文; thiếu preference trên cài mới luôn thành `vi`, không phụ thuộc system locale.
  - Chưa có preference và đã chọn `System` là hai trạng thái khác nhau: fresh-run default `vi`; lựa chọn `system` được lưu rõ, giữ sau restart và không bị first-run initializer ghi đè.
  - Android 13+: first run chưa initialized ghi `applicationLocales=['vi']` trước khi dựng UI; sau đó app/system chọn System thì rỗng per-app locale thật sự có nghĩa System. Android 12 trở xuống: preference thiếu nghĩa `vi`; preference `system` dùng system locale.
  - `AppLocale.tag()` nhận `vi`; `fromTag()` nhận `vi`/`vi-*`; `locales_config.xml` có locale `vi`.
  - `values-vi/strings.xml` đủ keys và placeholder multiplicity; parity test so `values`, `values-zh`, `values-vi` với allowlist `app_name`, kiểm tra mỗi placeholder đúng số lần trong mỗi string/plural.
  - Date/relative-time labels do app tự format hiển thị tự nhiên theo Vietnamese.
- UX Contract:
  - Surface: Inbox settings sheet hiện có, không thêm screen.
  - States: `vi`, `en`, `zh`, `system`; fresh default `vi` khác saved `system`; cả hai hiển thị đúng selector state sau restart.
  - A11y: giữ `Segmented` semantics/touch target hiện có; không rút gọn label đến mức khó hiểu.
  - Visual Ref: `apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/ui/inbox/InboxScreen.kt` và `AppLocale.kt`.
- Skills: `ui-design`, `android-taste-chatgpt-calm`, `implement`.
- Reproduce: `cd apps/mobile && gradlew.bat --no-daemon :androidApp:testDebugUnitTest`.
- Verify: Robolectric tests API 32/33 cho fresh default, saved `system`/`en`/`zh`/`vi`, restart; `:androidApp:testDebugUnitTest` + APK build + resource/placeholder parity.
- Files:
  - `apps/mobile/androidApp/src/main/res/values-vi/strings.xml` — pattern: `values/strings.xml`.
  - `apps/mobile/androidApp/src/main/res/xml/locales_config.xml` — pattern: locales hiện tại.
  - `apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/AppLocale.kt`, `UiPrefs.kt`, `PiRemoteApp.kt` — pattern: locale persistence/wrap hiện tại.
  - `apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/ui/inbox/InboxScreen.kt`, `ui/Format.kt` — pattern: language selector và localized date.
  - `apps/mobile/androidApp/src/test/kotlin/dev/pi/remote/app/StringsParityTest.kt` — pattern: key/format parity; đổi placeholder check từ Set sang multiset.
  - Tạo `apps/mobile/androidApp/src/test/kotlin/dev/pi/remote/app/data/AppLocaleTest.kt` — Robolectric API 32/33 first-run, saved System, locales and restart.

### Task 3: Windows startup + hidden-in-tray options
- Acceptance:
  - Settings → General có toggle `Khởi động cùng Windows` và subordinate `Khởi động ẩn trong khay`.
  - Startup mặc định off; bật/tắt cập nhật/gỡ login item theo user. `getLoginItemSettings` đọc lại cùng `path: process.execPath` và cùng `args` đã đăng ký.
  - `--hidden` chỉ được thêm vào startup args khi cả startup và hidden đều bật; main nhận arg này, giữ BrowserWindow `show:false`, và `ready-to-show` không gọi `show()` ở login launch. Không dùng Electron `openAsHidden`.
  - App launch thủ công không có `--hidden` vẫn hiện cửa sổ kể cả setting hidden đang bật; second-instance/Start Menu khôi phục cửa sổ; tray restore/quit vẫn hoạt động.
  - Hidden login launch không lóe cửa sổ, gateway Mobile vẫn start; startup tắt không tạo login item.
  - Lỗi native login-item API hoàn nguyên switch và báo lỗi localized; setting chỉ xuất hiện/hữu hiệu trên Windows.
- UX Contract:
  - Surface: thêm 2 `SettingRow` vào General Settings; không thêm dialog/màn mới.
  - States: startup off/on; hidden off/on; hidden disabled khi startup off; native API failure có phục hồi.
  - Keyboard/A11y: `Switch` existing, label/state link đúng; Tab/Space hoạt động.
  - Visual Ref: existing General Settings rows và `src/main/tray.ts`.
- Skills: `ui-design`, `implement`.
- Reproduce: `npm run test:unit -- src/main/login-item-settings.test.ts`.
- Verify: focused tests cho đăng ký/đọc/xóa login item, argv hidden/manual, ready-to-show, second-instance và API failure; `npm run typecheck` trên Electron `43.7.7`; Windows packaged build + manual startup/tray/gateway smoke.
- Files:
  - `src/main/config-store.ts`, `src/main/ipc/schemas.ts`, `src/main/ipc/handlers/settings.ts` — pattern: settings key/schema/set handler hiện có.
  - Tạo `src/main/login-item-settings.ts` + `src/main/login-item-settings.test.ts` — wrapper cho set/get login item với path/args đồng nhất.
  - `src/main/index.ts`, `src/main/window.ts`, `src/main/tray.ts` — pattern: single-instance/tray/ready-to-show hiện có.
  - `src/renderer/src/features/settings/settings-draft.ts`, `settings-draft-context.tsx`, `settings-general-appearance.tsx` — pattern: existing setting draft + `Switch`.

### Task 4: Fork update source, documentation and local artifacts
- Acceptance:
  - Khi không có env override, update request, fallback `app.openRelease` và nút Open GitHub trong Settings đều dùng `nguyendinhquocx/pi-app`; không còn runtime URL upstream. `PI_DESKTOP_GITHUB_REPO` override, nếu giữ, áp dụng đồng nhất cho cả ba đường.
  - Tests kiểm default fork, override, request URL, fallback release URL và Settings link; cập nhật assertions cũ đang kỳ vọng `justhil/pi-app`.
  - README chỉ cập nhật capability summary về ngôn ngữ + Windows startup/tray; không viết lại README.
  - Build Windows installer và Android APK từ cùng source revision; giữ `com.pi.desktop` và `dev.pi.remote`.
  - Custom version tăng patch từ `0.7.7` lên `0.7.8` để phân biệt artifact; APK local `assembleRelease` được build không set release-keystore env, `applicationId`/versionCode đúng, signer fingerprint khớp debug keystore của máy build.
  - Android app upstream phải được user gỡ trước khi cài bản cùng package ID ký khác; task chỉ build và xác nhận artifact, không tự gỡ/cài thiết bị.
  - Trước release đầu của fork, manual Check update có thể trả `no_release`; auto-check chỉ log, không toast. Đây là hành vi chuyển tiếp mong đợi.
  - Không tạo GitHub Release hoặc publish APK/installer.
- Skills: `implement`, `deploy`.
- Reproduce: `npm run package:win`.
- Verify: `npm run test:scripts`; `npm run typecheck`; `npm run test:unit`; `cd apps/mobile && gradlew.bat --no-daemon :androidApp:testDebugUnitTest :androidApp:assembleRelease`; xác minh output APK bằng `apkanalyzer`/`aapt` (`applicationId`, versionCode) và `apksigner verify --print-certs` so với local debug keystore.
- Files:
  - `src/main/github-release-check.ts`, `src/main/ipc/handlers/settings.ts`, `src/renderer/src/features/settings/settings-general-appearance.tsx` — pattern: repo override hiện có; renderer gọi `app.openRelease` không truyền upstream URL cứng.
  - `src/main/github-release-check.test.ts` — cập nhật default/override URL assertions.
  - `README.md` — chỉ cập nhật capability summary liên quan.
  - `package.json`, `package-lock.json` — version `0.7.8` để artifacts được nhận diện.

### Task 5: Android remote session identity + live timeline sync
- Context: user reports on A55/Android 16 that a prompt reaches Windows Desktop/TUI and finishes, while Android keeps “Đang gửi...” and no thinking/answer until back/re-enter. Source review found a Windows path-key mismatch: session list/open use raw `sessionFile` while `turn.patch`/UI events use normalized `entry.key`; Android performs exact map lookup. Review also found dropped patches during hydration, stale open-response overwrite, replay-Gap cursor advancement, and single-string pending-send state.
- Acceptance:
  - All session identifiers on the wire and Android repository/nav/cache maps use one canonical path key (drive uppercase, slash `/`, UNC leading `//` preserved); raw `entry.sessionFile` stays raw for host filesystem and SDK calls.
  - On Windows, `session.watchList`, `session.open`, `session.create`/`fork`, `turn.patch`, `ui.request`, and `ui.dismiss` for one session resolve to the same canonical key. Client also canonicalizes incoming keys for compatibility with older host payloads.
  - Android never silently drops a live event when a timeline is absent/hydrating. Snapshot and patches reconcile by epoch/seq; duplicate overlap is ignored; gaps/overflow force a bounded resync; a stale open response cannot overwrite a newer timeline.
  - A message sent from a new or existing session updates user turn, thinking/tool activity, answer, running/completed state live without back/re-enter. Initial empty session is distinct from “not loaded”; send is gated/queued until the first snapshot is installed.
  - Pending sends are tracked per message, not as one string/session. Accepted ACK leaves no infinite “Đang gửi...” state; timeline echo reconciles the optimistic bubble; connection-lost/unknown remains explicit and any retry reuses the same `clientMessageId` for host dedupe.
- Approach:
  - Add one KMP `canonicalSessionKey()` mirroring `normalizeSessionFileKey`; normalize all Android session-key boundaries and all server wire outputs, never host I/O paths.
  - Use a per-session serialized sync reducer with open generation + bounded patch buffer. On open response install snapshot/replay, drain only `seq > snapshot.seq`; do not advance cursor on Gap; stale generation responses are ignored.
  - Keep the UI patch minimal: correct sync state first; only then adjust pending status copy/controls if needed. No periodic polling or timeout-only removal of user messages.
- Verify:
  - Gateway regression with a Windows path asserts list/open/create-or-fork/event key parity; this must fail on pre-fix code and pass after the server boundary fix.
  - KMP tests cover Windows drive/backslash, drive-letter case, UNC, and POSIX key normalization.
  - Android repository/sync barrier tests cover event before open response, null timeline, stale concurrent open, replay gap, duplicate/overlap, epoch reset, buffer bound, repeated/identical sends, accepted/unknown/failure and pending reconciliation.
  - Run `npx vitest run src/main/remote/__tests__/gateway.test.ts`; run `cd apps/mobile && gradlew.bat --no-daemon :shared:jvmTest :androidApp:testDebugUnitTest :androidApp:assembleRelease`; run `npm run typecheck`.
  - Manual A55 smoke while app stays foreground: new/existing session, live thinking + answer, repeated sends, temporary network drop/reconnect, no back/re-enter workaround.
- Files:
  - Parent-owned server wire contract/tests: `src/main/remote/session-hub.ts`, `src/main/remote/rpc.ts`, `src/main/remote/__tests__/gateway.test.ts`.
  - GLM worker isolated slice: create KMP helper `apps/mobile/shared/src/commonMain/kotlin/dev/pi/remote/protocol/SessionKey.kt` and its normalization test only; do not touch Repository/TurnStore/server paths.
  - Parent-owned Android integration/core: `apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/RemoteRepository.kt`, `data/Storage.kt`, `ui/session/SessionScreen.kt`, `ui/session/TurnItem.kt`; `apps/mobile/shared/src/commonMain/kotlin/dev/pi/remote/sync/TurnStore.kt` and related tests.
- Skills: `implement`, `test`.

## Checkpoints
- Sau Task 1–2: desktop recursive locale parity + Android placeholder-multiset parity pass; first-run `vi` và saved System/en/zh/vi tests pass.
- Sau Task 3: login-item state/args/rollback tests pass; Windows package mở bình thường, hidden startup không flash, manual/second-instance launch restore window.
- Trước hoàn tất: Windows installer + Android APK build pass; signer/package metadata verify; desktop screenshots và Android API 32/33 QA đủ; giữ working spec tới khi owner UAT pass.

## External Review Brief
### Reviewer cần phán
- Vietnamese có hoàn tất trên hai UI hay sót built-in hard-coded text không?
- Fresh install default có khác upgrade có preference đã lưu không?
- Windows `--hidden` có race với `ready-to-show`/single-instance/tray hoặc làm gateway không chạy không?
- Android locale persistence có giữ đúng `System` và Android 13 app locale không?
- Updater có còn đường nào gọi nhầm upstream không?
- Windows raw session path và canonical event key có cùng identity không; Android có buffer/reconcile patch đến trong lúc mở session không?

### Reviewer nên đọc trước
- `src/renderer/src/lib/i18n.ts`, `src/main/default-language.ts`, desktop locale JSON.
- Android `AppLocale.kt`, `UiPrefs.kt`, `StringsParityTest.kt`, `InboxScreen.kt`.
- `src/main/index.ts`, `window.ts`, `tray.ts`, settings handlers/tests.

### Reviewer không cần phán
- Pi SDK/agent session format, ProDesk deployment, Linux headless mode, visual redesign ngoài hai setting rows.

## User Test

| Hành động | Kết quả kỳ vọng | Chuẩn nhìn |
|---|---|---|
| Cài Desktop build mới trên Windows lần đầu | General, Project Home và session UI dùng Vietnamese | Không trộn nhãn built-in English/Chinese; model/provider/extension names giữ nguyên |
| Đổi Desktop sang English, restart; sau đó đổi sang 简体中文 | Mỗi lựa chọn được giữ đúng | Selector và tray/notification copy cùng locale |
| Gỡ app Android upstream, cài APK custom; test trên Android 12 và 13 | First launch Vietnamese; host profiles cần pair lại | Inbox, session, settings sheet và dialogs hiển thị Vietnamese |
| Trong Android menu chọn System, restart; đổi lại Vietnamese | System thật sự dùng locale máy; Vietnamese chọn lại được | Selector đánh dấu System hoặc Tiếng Việt đúng, không bị first-run ép lại |
| Để startup off rồi đăng nhập Windows | App không tự chạy | Không có process/tray icon mới |
| Bật startup + hidden, đăng nhập Windows | App chạy, không lộ cửa sổ; Android vẫn kết nối được | Tray icon hiện; click tray mở app |
| Giữ startup on nhưng tắt hidden, đăng nhập lại | App tự chạy và hiện cửa sổ | Không cần mở Start Menu thủ công |
| Khi hidden preference on, mở app thủ công/nhấn Start Menu lần nữa | Cửa sổ được hiện/khôi phục, không tạo process thứ hai | `--hidden` chỉ thuộc login item, không áp vào manual/second-instance launch |
| Mở session mới trên Android, gửi ngay khi màn vừa vào | Tin nhắn, thinking và answer tự cập nhật; không cần back/re-enter | Test với Windows Desktop host, giữ màn Android foreground |
| Mở session cũ trên Android rồi gửi prompt | Turn mới và trạng thái completed hiện live | Không có bubble `Đang gửi...` treo sau khi host đã nhận |
| Ngắt mạng ngắn khi đang gửi, kết nối lại | App resync đúng, không mất hoặc nhân đôi tin nhắn | Retry dùng cùng `clientMessageId`; status unknown hiển thị rõ |

5 câu Y/N:
1. Built-in strings trong các view đã liệt kê có vừa viewport và không bị cắt không?
2. Có thể đổi locale bằng keyboard/touch theo đúng platform không?
3. Locale, startup và hidden có hiển thị đúng trạng thái đang bật/tắt không?
4. Lỗi lưu login item có hoàn nguyên control và chỉ rõ cách thử lại không?
5. UI giữ style settings hiện tại, không thêm card/hint/chrome thừa không?

## Completion Gates
- [ ] Desktop unit tests, locale parity, notification tests, scripts tests, typecheck và Windows package pass.
- [ ] Android Robolectric API 32/33 locale tests, resource/placeholder-multiset parity và APK build pass.
- [ ] Task 5 Windows session-key parity, live patch/open-race/replay-gap/pending-send regressions pass; A55 live-stream smoke không cần back/re-enter.
- [ ] APK `applicationId`, versionCode, output path và debug signer fingerprint được xác nhận; không tự uninstall/install thiết bị.
- [ ] UI evidence: representative built-in desktop views + Android API 32/33 locale menu; startup hidden/visible/manual/second-instance states trên packaged Windows.
- [ ] Không ghi đè saved locale; Android replacement warning và re-pair requirement được hướng dẫn rõ.
- [ ] Owner UAT checklist pass; chỉ sau đó mới archive spec.
