---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-26-li-tui-pair-panel"
status: "archived"
title: "Li TUI Pair Panel — lấy mã pair laptop/ProDesk từ Li TUI"
archived_at: "2026-11-26T23:37:21+07:00"
source_file: "SPEC-2026-11-26-li-tui-pair-panel.md"
source_sha256: "57bbe9f23034137dc3b1217fdf3cbb28289b71ca2b26710d7e15b5c2497d1620"
implementation_ref: "7d8401021727ae4a3b47fc3404e85dd460ea4aac"
working_tree: "dirty"
related_paths: ["src/main/remote/**", "src/main/remote-host-electron.ts"]
---

# Spec: Li TUI Pair Panel — lấy mã pair laptop/ProDesk từ Li TUI

> Rev 2.6 (2026-11-26): owner xác nhận UAT PASS hai host. Không lưu screenshot chứa QR/live pair token vì đó là credential one-shot; owner visual test + render/unit tests là evidence, không đính token-bearing captures. Full unit root có 3 lỗi cũ được tái hiện trên clean HEAD (không thuộc diff); scoped suite và typecheck đều PASS.
> Rev 2.5 (2026-11-26): live smoke xác nhận sau gateway restart `currentPairing` có thể chưa được tạo (`webPairing:null`); panel giữ fail-closed, hiển thị `chưa có mã pair · r sinh mã mới` — không tự tạo token ngầm. Journey/UAT ghi thêm 1 phím `r` trong state này. R8 ProDesk apply thành công (`0.7.14-df1ec746`), pair scan/revoke UAT còn chờ owner.
> Rev 2.4 (2026-11-26): Gemini security re-review phát hiện startup `adminToken()` ném raw filesystem path trước khi HTTP handler tồn tại; `RemoteGateway.start()` giờ map thành `admin_token_unavailable`, có regression test. Commit pi-app `7d840102`.
> Rev 2.3 (2026-11-26): vá post-handoff review: ProDesk revoke gửi body qua SSH stdin (`--data-binary @-`), laptop regenerate POST body rỗng, mọi API validate HTTP/envelope và không giả-success, picker probe async có kết quả online/offline, viewport test dùng link độ dài production; admin HTTP boundary không lộ raw filesystem error/path, token file chmod trước khi đọc. Commits: pi-app `1321317`, extension `4b4993c3`; review lại đang chạy.
> Rev 2.2 (2026-11-26): vá theo Maker-Checker W1 (Argon P2 + 3 P3, GLM 8/8 gates APPROVE) — admin response strip `status.pairing` (mobile link, chỉ còn webPairing 1 credential lane), gate đếm rawHeaders chặn duplicate Host (Node merge gộp vào giá trị đầu), regenerate/revoke với body không rỗng → 400, token file chmod idempotent mỗi lần đọc; field pin cho panel: `devices[].lastSeenAt` (ms), `revokedAt` có → filter khỏi devices view. Rev 2.1 vá theo verify Opus vòng 2 (Host regex riêng, sameSecret export, W2 URL 127.0.0.1).
> Rev 2 (2026-11-26): vá theo review 4 lane (opus/luna/glm/gemini-flash) — 25 findings + 2 gaps, 0 bị phản bác. Điểm thay chính: token path canonical pin từ folder thật 2 máy, SSH lane an toàn (stdin + id validate + timeout), Host header check, webPairing shape chính xác vs code, polling 2s + latest-wins, states loading/pair-success, copy thuần Việt, viewport 2 chiều, test gates cụ thể. Chi tiết từng finding gốc nằm trong review reports (batch `e4a29030`).

## Context Snapshot

- Project / module: cross-repo — (1) `D:\pcloud\workspace\code\android\pi-app\pi-app` (gateway admin endpoint, branch `li-web/fix-create-open` @ `7d840102`); (2) extension Li runtime `pair-panel` (source `D:\pcloud\workspace\code\python\app_presets\pi\extensions\`, deploy `C:\Users\quocn\.pi\agent\extensions\`). Spec sống ở pi-app vì gateway là nguồn truth của contract.
- Stack / runtime: pi-app = Electron + TypeScript, test `npm run test:unit` (= `vitest run`, `package.json:24`). Extension Li = TS load trực tiếp trong Pi runtime — KHÔNG cần build pi-mono-li (pattern như picron), test `tsx --test`. Gateway code chạy trong Electron main (laptop) và systemd service cùng module (ProDesk).
- Current behavior: lấy mã pair (web link `https://li.quoc.app/#pair=<token>`, one-shot TTL 5 phút) chỉ có 1 đường: Electron GUI (IPC `ipc:remote.regeneratePairing`). ProDesk headless không có đường nào. Gateway HTTP hiện chỉ serve `/assets/*` + WS `/ws`.
- Desired behavior: `/pair` trong Li TUI → chọn laptop/prodesk → thấy serve hostname + web pair link + QR trong terminal → phone scan là pair xong. Kèm regenerate + list/revoke devices.
- Relevant files to read:
  - `src/main/remote/gateway.ts` — `onHttp()` :303 (route dispatch), `hostHeaderAllowed()` :51 (đã dùng cho WS :271), `pairLink()` :343, `webPairLink()` :390 (trả `string | null`, KHÔNG có exp), `regeneratePairing()` :405 (**trả MOBILE link — bẫy tên hàm**), `status(enabled)` :430 (bắt buộc param), `serveHostname()` :357 (private)
  - `src/main/remote/auth-store.ts` — `sameSecret()` :45 (constant-time + guard length), `newPairToken()` :154, `currentPairing` :160 (trả `{token, exp}`), `revokeDevice()` :232
  - `src/main/remote/host-port.ts` — `port.storage` abstraction (get/set, KHÔNG lộ path vật lý)
  - `src/main/remote-host-electron.ts` :474-487 — pattern file trong userData (host key file), đây là pattern admin token file theo
  - `src/main/remote/__tests__/gateway.test.ts` — test pattern hiện có (file duy nhất; không có `src/main/remote/gateway.test.ts`)
  - `C:\Users\quocn\.pi\agent\extensions\picron\` — pattern extension TS + `package.json` + devDep `tsx`
- Existing constraints:
  - Pair token là credential one-shot; không được log vào transcript/session/log nào.
  - Security matrix G6 hiện có (tailnet-only serve, origin gate, replay `pair_used`, revoke đóng live connection bằng **close 4006 `revoked`**; 4004 chỉ là mã handshake bị từ chối) — KHÔNG nới lỏng lớp nào.
  - Build/deploy LiX là owner gate — đi đúng quy trình R7 (runbook `D:\pcloud\workspace\code\HOMELAB.md` + Python deployer).
  - Owner feedback UI: "phẳng và tinh tế, dễ sử dụng, không rườm rà, rác".

## Objective

- Control plane của remote gateway nằm ngay trên host, truy cập được từ Li TUI trên bất kỳ máy nào trong tailnet: lấy mã pair, sinh mã mới, revoke device — không cần mở GUI, không cần Telegram.
- Success: đứng ở Li TUI laptop, `/pair` → chọn prodesk → điện thoại scan QR hiển thị trong pane → web client pair thành công và panel xác nhận `✓ Đã kết nối`; revoke từ panel → phone mất kết nối ngay (close 4006) và offline banner.

## Scope

- In:
  - Admin HTTP loopback endpoint v1 trên gateway: status / regenerate / revoke device.
  - Extension Li `/pair`: host picker (laptop/prodesk), flat panel, QR block-char, copy link, regenerate, devices list + revoke, polling trạng thái pair.
  - Error states: gateway off, SSH fail, mã hết hạn, pane hẹp/thấp.
  - Deploy: laptop (Electron rebuild) + ProDesk (service rebuild R8-flow; `node:22-trixie`, pin/plan/apply receipt in deployer branch) + extension runtime deploy laptop.
- Out:
  - remove device hoàn toàn, set device role, sửa projects allowlist (phase sau).
  - Mobile-app pair link (`encodePairLink`) — panel chỉ dùng web pair link.
  - Đổi bất kỳ logic pair/handshake/origin nào của gateway.
  - Telegram pair path (bỏ — chốt 2026-11-26).

## Thuật ngữ (cross-model — bắt buộc)

- **gateway** = singleton `RemoteGateway`: Electron main process trên laptop, systemd service trên ProDesk, nghe TCP :47900.
- **LiX** = app Electron của repo pi-app — tên hiển thị người dùng (`productName: LiX` trong electron-builder.yml). "Bật trong LiX → Remote" = mở app, mục Settings Remote.
- **admin endpoint** = các route HTTP `/admin/v1/*` mới thêm vào gateway, CHỈ nhận connection loopback + Host header loopback + Bearer token.
- **admin token** = secret file nằm trong userData của app, CẠNH host key file hiện có: laptop Windows `%APPDATA%\PI-Desktop\admin-token` (casing `PI-Desktop` — xác nhận từ folder thật), ProDesk Linux `~/.config/pi-desktop/admin-token` (viết thường — xác nhận từ folder thật). Pattern source: `app.getPath('userData')` như host key (`remote-host-electron.ts` :480). File 0600, tạo lúc gateway start nếu thiếu; mỗi máy 1 token riêng.
- **web pair link** = `https://li.quoc.app/#pair=pt_…` — credential one-shot, TTL 5 phút. Khác mobile pair link (`encodePairLink`, out of scope).
- **serve hostname** = hostname HTTPS do `tailscale serve` expose (vd `ts-li-host.tail1234.ts.net`) — endpoint phone thật sự kết nối.
- **panel** = modal TUI của extension `/pair` trong Li runtime.
- **host** = máy chạy gateway: `laptop` | `prodesk` (mở rộng sau).
- **loader check** = verify extension load được trong Pi runtime thật: dep resolve + command đăng ký (KHÔNG phải performance test).
- **R7** = quy trình deploy LiX (build container + T20 pin + hash/canary + atomic apply), runbook `HOMELAB.md` — chỉ parent + owner gate thực thi.
- **deploy gate** = owner duyệt rebuild/redeploy LiX.

## Assumptions

- Extension Pi load được npm dep của riêng nó (picron có package.json riêng; `qrcode-terminal` 0-dep). Loader check ở T2 chốt — fail thì vendor single-file `qr.js`.
- `ssh prodesk-home '<cmd>'` non-interactive hoạt động từ laptop (đã dùng nhiều lần; `-o BatchMode=yes` bắt buộc để không treo prompt).
- Admin route đặt trong `onHttp()` dispatch hiện có — chặn loopback + Host + Bearer trước khi match path.
- ProDesk service chạy cùng module `remote-gateway-service` → T1 merge xong, rebuild ProDesk là có endpoint.

## Open Questions

- Không còn. (Rev 1 có câu QR lib — đã chuyển thành loader check của T2, không block approach.)

## Approach

- Chọn: **admin endpoint loopback + extension TUI mỏng** (owner chốt 2026-11-26).
- Lý do: 100% logic pair đã nằm trong `RemoteGateway` — chỉ thiếu cửa. Endpoint loopback + Bearer + Host header không mở bề mặt mạng mới (giữ đúng G6); ProDesk lấy qua SSH non-interactive có sẵn; Telegram bỏ vì credential đi qua server thứ 3.
- Phụ thuộc: contract Admin API v1 (dưới đây) là hợp đồng giữa 2 repo — W2 implement theo contract, không đọc code pi-app.
- Risk chính: (1) admin route lộ ra ngoài loopback → test hard-fail (bao gồm IPv4-mapped non-loopback); (2) token rò log/transcript → test assert; (3) shell injection qua SSH lane → id validate + stdin payload; (4) rebuild deploy đè chip → owner gate R7.

## Contract: Admin API v1

Cùng server :47900 hiện có (bind `0.0.0.0`), dispatch trong `onHttp()`. Mọi route `/admin/` phải qua **4 lớp gate theo thứ tự**, sai lớp nào → 403 ngay, không phản chiếu lý do chi tiết:

1. **Loopback check**: `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`}. Bắt buộc test mapped-non-loopback `::ffff:192.168.1.22` → 403.
2. **Host header check**: `req.headers.host` phải khớp regex loopback riêng: `/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i`. **KHÔNG dùng `hostHeaderAllowed()` :51** — hàm đó reject `localhost` (`isPrivateHost('localhost') === false`) và cho phép cả LAN IP + MagicDNS `*.ts.net`, sai cả 2 chiều so với yêu cầu chỉ-loopback (đây là trap rev 2 đã vá theo verify Opus vòng 2). Chặn DNS-rebinding defense-in-depth.
3. **Bearer token**: header `Authorization: Bearer <token>` so với token file bằng helper `sameSecret()` :45 (đã guard length — CẤM gọi `timingSafeEqual` trực tiếp, khác độ dài sẽ `RangeError` crash process).
4. **Body limit** (POST): đọc stream tối đa 16KB, quá → 413 + huỷ; `JSON.parse` bọc try/catch, sai → 400.

- Không set CORS header cho `/admin/*`; không log token/header/response chứa `pt_`.

| Route | Method | Body | Response |
|---|---|---|---|
| `/admin/v1/status` | GET | — | `{v: 1, status, webPairing, serveHostname}` |
| `/admin/v1/regenerate` | POST | — | như status (token cũ `spend` ngay, token mới) |
| `/admin/v1/revoke` | POST | `{id}` | `{v: 1, ok: boolean, status, webPairing, serveHostname}` (idempotent — đã revoked → `ok: false`) |

Field semantics (pin chính xác, không đoán):

- `status` = object `GatewayStatus` ĐẦY ĐỦ, build bằng `this.status(this.auth.config.enabled)` (param bắt buộc) — **trừ field `pairing` bị strip thành `null` trong admin response** (rev 2.2: chỉ 1 credential lane, webPairing); mọi route admin KHÔNG chứa mobile link `pidesk://` (test assert trên toàn body 3 route).
- Host header gate đếm `rawHeaders` — đúng 1 Host header; `Host: localhost` + `Host: evil.com` (Node merge gộp giá trị đầu) → 403 (rev 2.2).
- POST `/regenerate` nhận body rỗng; body không rỗng → 400 `unexpected_body` (rev 2.2).
- `webPairing` = `{link, exp} | null` — build `link` từ `this.webPairLink()` và `exp` từ `this.auth.currentPairing?.exp`. **CẤM dùng return của `regeneratePairing()`** — hàm đó trả mobile pair link (`encodePairLink`), sai định dạng cho web. Regenerate = `this.auth.newPairToken()` rồi build payload như status.
- `serveHostname` = `string | null` — host của endpoint kind `tailscale` trong `endpointInfo` (parse host từ `wss://<host>/ws`), hoặc `this.serveHostname()` nếu expose được. W2 chỉ đọc field này, không tự parse endpoints.
- `status.devices[]` thật (đã đối chiếu code 2026-11-26): `{id, name, platform, role, createdAt, lastSeenAt (ms), revokedAt?, fingerprint, online}` — panel filter `revokedAt` có giá trị, dùng `lastSeenAt` cho "dùng HH:MM" (rev 2.2 pin).

## Diagram

```mermaid
sequenceDiagram
    actor User as Phone (web)
    participant TUI as Li TUI /pair (laptop)
    participant LGW as Laptop gateway :47900
    participant SSH as ssh prodesk-home
    participant PGW as ProDesk gateway :47900

    TUI->>LGW: GET /admin/v1/status (loopback + Host + Bearer)
    LGW-->>TUI: status + webPairing{link,exp} + serveHostname
    TUI-->>TUI: render QR block-char
    Note over User,TUI: phone scan → li.quoc.app → WS handshake (token consumed)
    TUI->>LGW: poll status 2s → devices count tăng → "✓ Đã kết nối"
    User->>LGW: WS handshake (pair token one-shot)
    LGW-->>User: paired

    alt chọn prodesk
        TUI->>SSH: ConnectTimeout=2, BatchMode; curl đọc token nội bộ trên ProDesk
        SSH->>PGW: same 4-layer gate
        PGW-->>TUI: JSON qua stdout (payload POST qua stdin)
    end
```

## Bỏ qua

- **Telegram pair path**: credential đi qua server thứ 3 + nằm vĩnh viễn trong chat history; TUI giải đúng gốc rễ. Owner chốt 2026-11-26.
- **Admin endpoint trên tailnet IP / password prompt trong TUI**: SSH đã giải multi-host, không mở bề mặt mới.
- **CLI riêng gọi module gateway**: singleton trong process đang chạy — tạo instance thứ 2 đụng config. Bị loại.
- **Token trong `/proc` của curl trên ProDesk**: Bearer expansion trong shell remote khiến cmdline curl chứa token — với homelab single-user, process cùng user đã đọc được mọi secret khác (SSH key, Chrome session) → P3 chấp nhận, ghi nhận trong Security Notes. Không build cơ chế header-file tạm trong MVP.

## Risks

- Admin route lộ ngoài loopback (bind 0.0.0.0 hiện có) → 4-layer gate + test mapped-non-loopback + Host header là gate bắt buộc T1.
- Token rò log/transcript → guard không-log + test serialize session entries (T2).
- Shell injection qua SSH khi ghép `id` → validate `^[a-zA-Z0-9_-]+$` trước + payload qua stdin (`--data-binary @-`), id không vào command string.
- SSH treo làm đơ panel → `-o ConnectTimeout=2 -o BatchMode=yes` + fetch timeout 3s mọi lane SSH.
- `timingSafeEqual` crash khác độ dài → dùng `sameSecret()` có sẵn.
- Rebuild deploy đè chip đang chạy → deploy chỉ chạy sau owner gate, đúng quy trình R7.

## UX Baseline (Module A — khai 1 lần)

1. **Keyboard**: `/pair` mở picker; ↑↓ chọn; Enter xác nhận; phím action chữ thường không modifier; Esc thoát mọi view, không confirm.
2. **Focus**: dấu `❯` + bold làm focus indicator — không phụ thuộc màu đơn thuần.
3. **A11y**: contrast theo theme Pi; không dùng màu làm tín hiệu duy nhất (luôn kèm chữ: `online`/`offline`, `hết hạn`).
4. **Viewport (2 chiều)**: pane **ngang < 60 cột HOẶC dọc < 18 dòng** → link-only mode (bỏ QR, hiện link + ghi chú mờ `pane hẹp/thấp — mở rộng để hiện QR`). QR block cần ~17-25 dòng dọc.
5. **States**: `loading` (picker fetch, regenerate, revoke — dòng mờ `đang kiểm tra…`/`đang tạo mã mới…`, không block chọn laptop) / `success` pair (`✓ Đã kết nối: <name>`) / no pairing / gateway off / SSH fail / hết hạn / revoke ok — mỗi state 1 dòng inline tại chỗ, lỗi đỏ kèm recovery (`r`). No-pairing sau gateway restart không tự xoay token; hiện `chưa có mã pair · r sinh mã mới`.
6. **Nhất quán**: component/màu TUI Pi runtime đang có; không tự chế hex mới.
7. **Platform surfaces**: N/A — terminal.
8. **Copy**: thuần Việt, gọi đúng hành động: `c chép link`, `r mã mới`, `d thiết bị`, `x thu hồi`, `esc thoát`. Error nêu vấn đề + recovery trong 1 dòng.

### Journey (flow, chốt 1 lần)

- Default path: `/pair` → Enter (laptop mặc định) → nếu có offer còn hạn thì QR hiện ngay; nếu gateway mới restart/chưa có offer thì hiện `chưa có mã pair · r sinh mã mới`, bấm `r` → QR → phone scan → panel tự xác nhận `✓ Đã kết nối` → Esc. ≤3 phím từ ý định đến QR; picker render NGAY, host chậm hiện `đang kiểm tra…` mờ — không block.
- `/pair laptop|prodesk` nhảy thẳng; state không có mã/đã hết hạn không tự sinh mã ngầm để tránh xoay credential bất ngờ.
- Recovery: gateway off → dòng đỏ + `r`; SSH fail → dòng đỏ + `r`; hết hạn → dòng đỏ + `r` (không tự regenerate ngầm).
- Multi-host: `/pair laptop`, `/pair prodesk` nhảy thẳng.

### Cơ chế polling (chốt 1 lần — giải 3 bài toán bằng 1 cơ chế)

Panel mở → poll `GET /admin/v1/status` mỗi **2s** (loopback fetch rẻ; SSH lane poll mỗi 5s). Dùng chung 1 poll để:
1. **Pair success**: devices count tăng so với baseline → hiện `✓ Đã kết nối: <device mới>` (token consumed, QR chết — thay QR bằng dòng success).
2. **Expired flip**: `exp` quá thời điểm hiện tại → lật state "hết hạn" đúng lúc, không cần timer đếm giây.
3. **Race guard — latest request wins**: mọi response fetch gắn sequence number; response của request cũ đến sau regenerate/revoke → bỏ qua, không ghi đè. Test bắt buộc: `late_status_does_not_overwrite_regenerated_pair`.

### Visual direction + Visual Ref

- Direction chốt bởi owner: **phẳng, tinh tế, không rườm rà** — text-first, không khung viền, không submenu lồng, không countdown giây (giờ hết hạn tuyệt đối).
- Surface mode: Operate utility trong TUI terminal — Quick route, dùng theme Pi runtime, không tạo DESIGN.md mới.
- Visual Ref: `refs/pair-panel-mock.txt` — bản rev 2 đã vá theo lane Gemini; mốc so khi verify.
- QR render: margin/quiet zone ≥ 2 module, gate chốt = scan thật trong UAT (đã trong User Test).

### View/State Matrix

| View | State | Hiển thị |
|---|---|---|
| picker | ok | host list + `online`/`offline`; host chậm → mờ `đang kiểm tra…`, không block chọn laptop |
| picker | fetch fail | host `offline` + nguồn lỗi ngắn 1 dòng |
| panel | ok | header + serve hostname + link + hạn + QR + actions |
| panel | loading regenerate | dòng mờ `đang tạo mã mới…` thay QR, input vẫn nhận `esc` |
| panel | pair success | QR thay bằng `✓ Đã kết nối: <name>` + actions rút gọn |
| panel | gateway off | dòng đỏ `gateway off — mở LiX → Remote để bật · r thử lại` |
| panel | ssh fail | dòng đỏ lỗi 1 dòng + `r` |
| panel | no pairing | dòng đỏ `chưa có mã pair · r sinh mã mới` (sau gateway start/restart) |
| panel | expired | dòng đỏ `mã hết hạn · r sinh mã mới` |
| devices | ok | list (name + online + lần dùng cuối) + `[x] thu hồi` + confirm `y/n` tại dòng |
| devices | revoke ok | dòng xanh `đã thu hồi <name>` + list refresh |

## Task List

### Task 1: Admin endpoint v1 trong gateway
- Acceptance:
  - 3 route đúng contract: 4-layer gate, response có `v: 1`, `webPairing {link, exp}` từ `webPairLink()` + `currentPairing.exp`, `serveHostname`, `status(this.auth.config.enabled)`.
  - Regenerate: `newPairToken()` + build web payload — response KHÔNG chứa mobile link.
  - Token file tạo đúng userData path (pattern host key), chmod 0600 idempotent TRƯỚC khi đọc file cũ (Windows: read-only flag — single-user desktop chấp nhận, ghi nhận).
  - Lỗi filesystem lúc start gateway và trong admin HTTP handler đều trả lỗi chung; không echo/log raw exception (tránh lộ userData path). Test regression xác nhận `admin_token_unavailable` không chứa userData path.
  - Test bắt buộc (mỗi cái là gate, thiếu = fail):
    - `admin_allows_ipv4_mapped_loopback_and_denies_mapped_non_loopback` — `::ffff:127.0.0.1` + Bearer pass; `::ffff:192.168.1.22` → 403.
    - `admin_allows_localhost_and_127_host_headers_denies_lan_hostname` — `Host: localhost:47900` và `Host: 127.0.0.1:47900` + Bearer pass; `Host: evil.com` và `Host: 192.168.1.22:47900` → 403.
    - `sameSecret` export từ auth-store (hiện private :45 — thêm `export`) và dùng cho mọi so-token, không gọi `timingSafeEqual` trực tiếp.
    - Bearer sai độ dài/khác token → 403, không crash (`sameSecret`).
    - POST body > 16KB → 413; JSON lỗi → 400.
    - `revoke` với id chứa ký tự ngoài `[a-zA-Z0-9_-]` → 400, không ghép vào command.
    - Regenerate response: `webPairing.link` bắt đầu `https://li.quoc.app/#pair=`; token cũ bị spend.
    - Không có call logger với chuỗi `pt_` trong flow admin.
  - Remote suite trong scope xanh; root `npm run test:unit` có 3 failure baseline ngoài scope (`session-tree-from-file`, `session-jsonl-timeline-skill`, `worker-http-connect`), cùng failure được kiểm chứng trên clean HEAD. Gate là không có regression mới; KHÔNG sửa logic handshake/origin gate hiện có.
- Reproduce: `cd D:\pcloud\workspace\code\android\pi-app\pi-app && npm run test:unit`
- Verify: remote suite `src/main/remote/__tests__/` pass + typecheck; root suite so sánh clean-HEAD baseline, không có failure mới; security diff review (Maker-Checker).
- Files:
  - `src/main/remote/gateway.ts` — pattern: `onHttp()` :303 (dispatch), `hostHeaderAllowed()` :51 (reuse), status :430
  - `src/main/remote/auth-store.ts` — pattern: `newPairToken()` :154, `sameSecret()` :45 (**cần thêm `export`** — hiện private)
  - `src/main/remote-host-electron.ts` :474-487 — pattern file userData (host key)
  - `src/main/remote/__tests__/gateway.test.ts` — test pattern

### Task 2: Extension `/pair` panel (pi-mono-li runtime)
- Acceptance:
  - Tạo `package.json` (pattern picron: script `test` = `tsx --test *.test.ts`, devDep `tsx`, dep `qrcode-terminal`).
  - `/pair` → picker 2 host, render ngay không block; `/pair laptop|prodesk` nhảy thẳng.
  - Laptop: fetch loopback + Bearer đọc từ token file path đã pin; regenerate là POST body rỗng. ProDesk: SSH an toàn — `ssh -o ConnectTimeout=2 -o BatchMode=yes prodesk-home` + curl chạy remote đọc token nội bộ (`Authorization: Bearer $(cat ~/.config/pi-desktop/admin-token)`), revoke payload qua stdin (`--data-binary @-`), fetch timeout 3s; port mặc định 47900, đọc config cùng thư mục nếu đổi.
  - Mọi API client kiểm HTTP status + JSON envelope `v:1`; revoke chỉ báo thành công khi `ok:true`; lỗi HTTP/parse/envelope → error state, không false-success. Picker probe async phải settle online/offline, không kẹt `đang kiểm tra…`.
  - Panel đúng Visual Ref rev 2: polling 2s (SSH 5s), latest-request-wins, states đủ Matrix, copy thuần Việt, giờ hết hạn tuyệt đối.
  - `id` device validate regex trước khi ghép SSH command; body POST luôn qua stdin.
  - Pane <60 cột hoặc <18 dòng → link-only mode.
  - QR margin ≥2.
- UX Contract: theo UX Baseline + Matrix + polling section — không lặp.
- Skills: pi-build-extension, flow.
- Visual Ref: `refs/pair-panel-mock.txt` (rev 2)
- Reproduce: `cd D:\pcloud\workspace\code\python\app_presets\pi\extensions\pair-panel && pnpm test` (chạy được sau khi manifest tồn tại) + loader check: chạy Li thật, `/pair` đăng ký được, `qrcode-terminal` resolve được (fail → vendor single-file).
- Verify: unit tests pass (gồm các test bắt buộc dưới) + loader check + smoke 1 lần với gateway thật.
  - Test bắt buộc: `late_status_does_not_overwrite_regenerated_pair`, `panel_render_respects_59_and_60_column_boundary` (production-shaped pair link dài), `prodesk_status_uses_remote_admin_token` (mock SSH: đọc token remote, payload qua stdin), `prodesk_revoke_posts_stdin_body` (assert `--data-binary @-` + payload), laptop regenerate rỗng body, HTTP non-2xx / malformed envelope thành error, picker probe settle online/offline, `pair_command_does_not_persist_pair_secret` (serialize session entries + captured logs, assert không chứa `pt_`).
- Files:
  - `D:\pcloud\workspace\code\python\app_presets\pi\extensions\pair-panel\index.ts` — pattern: `picron\index.ts`
  - `...\pair-panel\panel.ts` — pattern: `C:\Users\quocn\.pi\agent\extensions\pi-ask\component.ts`
  - deploy target: `C:\Users\quocn\.pi\agent\extensions\pair-panel\`

### Task 3: Deploy + UAT 2 host
- depends_on: [T1, T2]
- Acceptance:
  - Laptop rebuild + reload (owner gate) → `/pair laptop` thật, scan thật → pair thành công + panel hiện `✓ Đã kết nối`.
  - ProDesk rebuild R8-flow (app `7d840102` + SDK `dbe3953a`, `node:22-trixie`; hash/canary/atomic) → `/pair prodesk` → scan → pair. R7 `monoli-r7` build workspace đã dọn; không tái dùng artifact cũ.
  - Revoke từ panel → phone mất kết nối ngay (**close 4006 `revoked`**; reconnect bị từ chối 4004 handshake) + offline banner.
  - Negative: gateway off đúng error state; token file xoá → gateway start tự tạo lại; SSH ProDesk chết (stop tailscale) → timeout 3s + error state, không đơ panel.
- Reproduce: User Test checklist — chạy tay trên máy thật.
- Verify: ProDesk deploy receipt + live status/negative-gate smoke PASS trên hai host; owner xác nhận UAT PASS cả hai host ngày 2026-11-26. Không lưu ảnh QR/link vì chứa credential one-shot.
- Files: không sửa code — deploy + evidence `uat/`.

## Checkpoints

- Sau T1: suite xanh + Maker-Checker security diff (4-layer gate + không đụng handshake/origin) trước khi T2 parse contract thật.
- Sau T2: loader check + smoke local trước khi đụng ProDesk.
- Trước DONE: cả 2 host UAT pass + negative states pass.

## External Review Brief

### Review lanes (owner chỉ định 2026-11-26; vòng 1 xong — rev 2 đã vá)
1. **Opus** (arch+security) — 9 findings rev 1, đã vá: token path canonical, SSH injection/timeout, Host header, sameSecret, body limit, webPairing shape.
2. **Luna** (correctness+test) — 6 findings, đã vá: mapped loopback test, session transcript test, race latest-wins, 59/60 biên, manifest tsx, prodesk bearer test.
3. **GLM** (cross-model) — 7 findings, đã vá: token path, 4006, regenerate trap, status semantics, thuật ngữ, forbidden rule-based, serveHostname.
4. **Gemini Flash** (UI/UX/flow riêng) — 6 findings + 2 gaps, đã vá: loading/pair-success states, cắt port/serve, viewport 2 chiều, feedback copy + pair success, copy thuần Việt, tách dòng hạn/URL, polling cơ chế, QR quiet zone.

### Kết quả review
- Spec round 1: Opus/Luna/GLM/Gemini Flash, 25 findings + 2 gaps; đã vá và verify.
- Post-handoff review: Luna ACCEPT; Gemini startup error-path finding P3 vá trong `7d840102`, bounded re-review PATCH-OK.
- R8 deployer pin review: historical README wording finding đã vá; fresh review PATCH-OK. Deploy pin `7d840102`, hashes và installer contract nhất quán.

### Reviewer nên đọc trước
- Spec rev 2.6 + mock rev 2 + gateway.ts :45-75, :300-445 + auth-store.ts :45-240

### Reviewer không cần phán
- Telegram path, mobile pair link, deploy pipeline chi tiết, chọn QR lib cụ thể, thẩm mỹ (đã duyệt flat).

## User Test

| Hành động | Kết quả kỳ vọng | Chuẩn nhìn |
|---|---|---|
| Gõ `/pair` trong Li TUI laptop | Picker hiện ngay, laptop sẵn, prodesk `đang kiểm tra…` mờ nếu chậm | Flat, không khung, không block |
| Chọn host sau gateway vừa restart, panel báo chưa có mã | Bấm `r` một lần → mã mới + QR hiện | Có dòng `đang tạo mã mới…`, không tự xoay mã ngầm |
| Enter chọn laptop, phone scan QR | Web pair thành công, panel tự hiện `✓ Đã kết nối: <tên>` | QR nguyên vẹn scan được trong <2s cầm máy |
| Bấm `c` | Dòng action hiện `✓ đã chép link` ~1.5s | Phản hồi tức thì, không im lặng |
| Bấm `r` | `đang tạo mã mới…` → link/QR mới, hạn mới | Mã cũ chết ngay, không cần confirm |
| `/pair prodesk` | QR ProDesk hiện trong TUI laptop ≤3s | Lỗi SSH → dòng đỏ + `r`, không treo |
| `d` → `x` trên device online | `thu hồi <tên>? y/n` → phone mất kết nối ngay | Dòng xanh `đã thu hồi` + list refresh |
| `/pair` khi gateway off | Dòng đỏ hướng dẫn + `r` | Vấn đề + recovery trong 1 dòng |
| Thu pane <60 cột hoặc <18 dòng | Link-only mode, không QR vỡ | Không tràn, không ký tự lỗi |

5 câu Y/N:
1. Panel có vừa pane ≥60 cột và ≥18 dòng, không cắt nội dung cần dùng không?
2. Mọi thao tác (chọn host, chép link, mã mới, thu hồi, thoát) có làm được bằng keyboard thuần không?
3. Focus indicator (`❯` + bold) có thấy rõ không dùng chuột không?
4. Gateway off / SSH fail / hết hạn có nêu rõ chuyện gì + cách phục hồi trong 1 dòng không?
5. Toàn bộ view có đạt "phẳng, tinh tế, không rườm rà" so với `refs/pair-panel-mock.txt` không?

## UAT Receipt

- Owner xác nhận qua chat ngày 2026-11-26: “đã test và hoạt động. uat pass”; xác nhận cả hai host và revoke theo checklist.
- Live admin smoke độc lập: laptop 8/8; ProDesk status valid, unauthorized/evil Host → 403, invalid revoke ID → 400.
- Không lưu screenshot chứa QR hoặc full pair URL vì đó là credential one-shot; test render-state + owner visual UAT thay cho ảnh token-bearing.

## Completion Gates

- [x] Gate kỹ thuật: remote suite `130/130` + extension `24/24`, typecheck PASS; deployer wrapper `14/14`, ProDesk fixture `5/5`; root suite `2573 pass / 3 known clean-HEAD failures`, không regression mới.
- [x] Gate UI: owner xác nhận live UAT pass; render matrix/unit tests pass. Không lưu ảnh có pair secret (xem UAT Receipt).
- [x] Gate review: 4 lane spec review; post-handoff Luna ACCEPT, Gemini security startup-path fix PATCH-OK, R8 deployer pin README review PATCH-OK.
- [x] UAT: owner xác nhận pass cả laptop+ProDesk; QR pair và revoke theo checklist.
- [x] Deploy gate: owner duyệt deploy cả hai host + fresh no-turn reconfirm; ProDesk R8 apply PASS, R7 rollback giữ nguyên.

## MODULE B — Multi-agent

### Implementation Handoff

##### Delegation Decision
- Mode: Supervised parallel (2 lane, khác repo)
- `agent-loop-orchestration`: yes — Maker-Checker cho W1 (auth surface).
- Parent giữ: contract v1 (bất biến giữa chừng), integrate, security review W1, deploy orchestration, UAT.
- Giao worker: W1 (T1), W2 (T2). KHÔNG delegate: T3 (deploy owner gate), mọi logic handshake/origin.

##### Worker Slices

| Slice | Role | Mode | Risk | Tasks | Files allowed | Files forbidden | Verify gate |
|---|---|---|---|---|---|---|---|
| W1 | Worker | implement | T3* | T1 | pi-app `src/main/remote/**`, `src/main/remote-host-electron.ts` (chỉ thêm token file helper cạnh host key) | `src/worker/**`, `apps/web/**`; KHÔNG sửa logic handshake/origin gate/handoff hiện có | `npm run test:unit` + security diff review |
| W2 | Worker | implement | T2 | T2 | extension dir `pair-panel/**` + deploy target | pi-app repo toàn bộ, extension khác | extension tests + loader check + smoke |

*W1 risk T3 vì đụng auth surface → Maker-Checker: reviewer độc lập re-read diff trước khi parent accept.

##### Parallelization Plan
- Safe parallel: W1 (pi-app) ∥ W2 (extension, mock contract) — khác repo.
- Shared: contract v1 bất biến. Lane phát hiện contract thiếu field → STOP, báo parent, không tự đổi.
- Integration owner: parent. Max parallel: 2. Worktree: no (khác repo).
- Wave 1: [T1, T2] → Wave 2: [T3] sau khi cả hai PASS + owner duyệt deploy.

##### Context Pack (W2)
- Đọc trước: spec rev 2, mock rev 2, picron pattern, pi-ask component pattern.
- Contract: bảng Admin API v1 + field semantics — source of truth duy nhất, KHÔNG đọc code pi-app.
- Token path: laptop `%APPDATA%\PI-Desktop\admin-token`; ProDesk remote `~/.config/pi-desktop/admin-token` (curl đọc nội bộ, không gửi token qua SSH).
- Port: mặc định 47900; đọc config cùng thư mục nếu user đổi. URL mặc định dùng `http://127.0.0.1:47900` (KHÔNG dùng `localhost` — gateway chỉ chấp nhận Host loopback theo regex riêng, tránh phụ thuộc phân giải localhost trên Windows).
- Decisions chốt: flat UI, không countdown giây, giờ hết hạn tuyệt đối, polling 2s/5s latest-wins, Telegram bỏ, copy thuần Việt.

##### Scope Guard
- W1 rule-based: chỉ thêm nhánh route `/admin/` mới trong `onHttp()` + helper token file; KHÔNG sửa logic origin gate/handshake hiện có; KHÔNG đổi type `GatewayStatus` trừ phần contract yêu cầu (`serveHostname` ở response root, không trong type cũ).
- Ngoài `Files allowed` → reject. Thêm dep trong scope T2 (ghi report).

##### Retry / Escalation
- Fail verify lần 1 → feedback + retry 1. Lần 2 → stop, parent tự xử.
- Đụng handshake/origin hoặc sửa ngoài scope → reject không retry.

##### Worker Report Required
- STATUS / ROLE / SCOPE / FILES_READ / FILES_TOUCHED / COMMANDS_RUN / EVIDENCE / RISKS / GAPS / NEXT_ACTION / DIFF_SCOPE / VERIFY_RESULTS / SKILLS_READ
- W1 thêm SECURITY_NOTES (4-layer gate + không-log assert + id validation)
- OUT_OF_SPEC_ADDITIONS: `None` hoặc ledger 1 dòng
