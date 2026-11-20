# ProDesk host-2 LiX preflight — 2026-11-19 (READ-ONLY)

- Worker session: `01a1baba-08e2-7789-80ae-166243abb0e4` (pi android lane)
- Trigger: peer request `peer_20261119102149_78c71792` (parent `01a17601-464d-721f-9668-9fa142f7e3ce`)
- Gate: Pi-Mono owner release `msg_20261119112238_6bba00ab817b` (owner "duyệt" cả 3 mục trong parent session, 2026-11-19)
- Boundary: read-only. KHÔNG merge, KHÔNG T20 mutation, KHÔNG restart/kill, KHÔNG đụng firewall/DNS/Serve.

## 1. Version / hash — PASS, khớp pin laptop

- `current` → `0.7.13-9c8f2650` (symlink, Nov 16 13:56 UTC; atomic versioned dir, không phải `releases/` subfolder)
- Live `app.asar` sha256:
  `9c8f2650fe4f9bab5cf824d3db2dc1a47eca1b903a2113c53435ddd6814b5ec9`
  = laptop pin `app_presets/home_server/pi-desktop-remote/release-lock.json` (`v0.7.13`, `source_commit e9131eae…8588`, asset `LiX-0.7.13-x86_64.AppImage` sha256 `ed62d289…bb75` — artifact archive, không nằm trên host vì install unpacked).
- Host app root: versioned dirs `0.7.7 / 0.7.10 / 0.7.11 / 0.7.12 / 0.7.13-9c8f2650` + AppImage file cho 0.7.7/0.7.10/0.7.11/0.7.12 (rollback target `0.7.12` đủ dir + AppImage).
- `release-lock.json` / `SHA256SUMS*` KHÔNG có trên host (pins sống laptop-side; receipts ở `D:\pcloud\workspace\archive\home-server-artifacts\lix-0.7.13\`).

## 2. Service state

| Unit | State |
| --- | --- |
| `pi-desktop-app.service` | active / enabled, MainPID 1252541, started **Mon 2026-11-16 13:56:33 UTC** (trùng receipt deploy), NRestarts=0, uptime ~2d21h |
| `pi-desktop-xvfb.service` | active |
| `pi-desktop-vnc.service` | inactive (chưa chạy — observation, không đổi) |

## 3. Gateway 47900

- `LISTEN 0.0.0.0:47900` (mọi interface; ufw active — policy 47900 chưa kiểm, observation only)
- HTTP alive: `GET /` → 404 `not found`; không có `/healthz`.

## 4. Tailscale Serve (tailnet only)

- `https://prodesk-home.tailff3893.ts.net:8443` → `127.0.0.1:4533`
- `https://prodesk-home.tailff3893.ts.net:8444` → `127.0.0.1:8096`
- `https://prodesk-home.tailff3893.ts.net:8445` → `localhost:5984`
- **KHÔNG có mapping cho 47900** → endpoint Li Web Serve chưa active; Serve activation vẫn là release gate riêng.

## 5. Process / session-turn liveness

- 9 process `comm=pi-desktop`:
  - 7 PID cùng uptime với service start (~2d21h): 1252541, 1252551, 1252552, 1252621, 1252624, 1252650, 1252680
  - 2 PID khác lệch tuổi: 3674256, 3674266 (start ~1d23h trước — KHÔNG phải con của service start này; chưa xác định nguồn)
- Tổng 13 cmdline references `apps/pi-desktop`.
- Session/turn contents KHÔNG đọc (ngoài phạm vi); không có endpoint auth-free để đếm active turn.

## 6. Host nền (fixed toolkit preflight `home_server.preflight` / `.status`)

- docker/containerd/tailscaled/ssh.socket active; srv present; project allowlist present; ufw active
- uptime 1,815,684s; load 1m = 1.49 / 6 cores; mem 27%; root disk 66%

## 7. Kết luận cho deploy/UAT

- Trạng thái 0.7.13 đã deploy còn nguyên vẹn, hash khớp pin, service ổn định → preflight PASS cho host-2.
- Trước `--apply` (nếu có deploy mới): runbook bắt buộc stop running turns; cần giải trình 2 process lệch tuổi (3674256/3674266) trước khi restart service.
- Không mutation nào đã thực hiện.
