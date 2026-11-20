# PREP deploy G3 — Li Web host-2 (assignment G1+G2) — 2026-11-20 04:35 UTC

- Assignment: `peer_20261120043110_cc464ea2` (owner duyệt G1+G2 trực tiếp 2026-11-20, thay GO misrouted đã thu hồi)
- Scope: deploy LiX build chứa T1 lên host-2 + UAT matrix G5 (spec :302-314). Serve 47900 (G4) KHÔNG trong assignment.
- Phase hiện tại: **CANDIDATE READY / NOT DEPLOYED** — dependency đã thỏa (`li/stable` source+artifact), fixed `deploy.py --plan` PASS. Owner đã trả lời G3 visible UFW + no-turn gates trong ask_user của worker; chưa có host snapshot/T20/stop/apply.
- Toàn bộ quan sát dưới đây là read-only SSH (`ssh prodesk-home`), timestamp **Fri Nov 20 04:33:16 UTC 2026**.

## G3 checklist — kết quả PREP từng mục

### 1. Giải trình 2 PID lệch tuổi 3674256/3674266 — ✅ RESOLVED, không cần kill

Cả hai là **Chromium subprocess hợp lệ của chính service tree**, không phải process lạ:

| PID | Loại | PPID | Spawn |
| --- | --- | --- | --- |
| 3674256 | `--type=renderer` | 1252552 (zygote con của service) | Tue Nov 17 12:02:04 UTC |
| 3674266 | `--type=utility` audio service | 1252541 (service MainPID) | Tue Nov 17 12:02:04 UTC |

Renderer/audio utility được Electron respawn khi app có activity sau service start (Nov 16 13:56) — hành vi bình thường. Pre-deploy chỉ cần dừng cả service tree như kế hoạch (stop unit sẽ hạ toàn bộ cGroup).

### 2. Service/gateway hiện tại — ✅ active, khớp preflight

- `systemctl --user status pi-desktop-app`: **active (running) since Nov 16 13:56:33 UTC** (3 ngày), MainPID 1252541, 43 tasks, mem 205.3M. NRestarts=0.
- ⚠️ **Lưu ý vận hành**: units là **user units** (`~/.config/systemd/user/pi-desktop-app.service`, Linger=yes) — mọi lệnh quản trị phải dùng `systemctl --user`; `systemctl` system-level trả "not-found" (đã thử và xác nhận). Deploy flow phải ghi `systemctl --user daemon-reload/restart`.
- Gateway: `LISTEN 0.0.0.0:47900`, owner process = pid 1252541 (fd 87) — gateway sống trong app như thiết kế.

### 3. ufw 47900 — ✅ OWNER CONFIRMS TAILSCALE-ONLY (visible TTY; raw stdout not retained)

`sudo -n ufw status` thất bại qua SSH non-interactive. Sau đó owner dùng fixed ProDesk visible TTY (`terminal run 12cfd096-3fbb-4b4a-81ce-a03d7e7c0d19`) cho `sudo ufw status numbered | grep -E 'Status:|47900'`; owner chọn `Tailscale-only` khi được hỏi nếu rule chỉ giới hạn `tailscale0`. Terminal output không được tool trả lại nên receipt ghi đây là **owner attestation**, không phải raw output. Không có firewall mutation. Ask_user result thuộc worker session `01a17601-464d-721f-9668-9fa142f7e3ce`; không có `msg_...` id riêng.

### 4. Dừng turns trước --apply — ✅ OWNER CONFIRMS NONE

Không có endpoint auth-free để đếm active turn trên gateway. Owner trả lời rõ `Xác nhận không có turn` trong cùng ask_user form trước mọi service stop. Chưa có stop/restart nào xảy ra.

### 5. Rollback 0.7.12 — ✅ sẵn sàng

- Unpacked dir `/home/quoc/apps/pi-desktop/0.7.12/` (có `resources/app.asar`) + AppImage `pi.Desktop-0.7.12-x86_64.AppImage` (225,109,692 bytes, Nov 15).
- `current` → `0.7.13-9c8f2650` (symlink). Rollback = đổi symlink + restart `--user` unit.

## Phát hiện phụ (không block, cần sửa doc)

- **HOMELAB.md :77 stale về path**: ghi runtime trong `/home/quoc/apps/pi-desktop/releases/` — thực tế KHÔNG có `releases/`; versioned dirs nằm trực tiếp trong `/home/quoc/apps/pi-desktop/` (0.7.7/0.7.10/0.7.11/0.7.12/0.7.13-9c8f2650 + `incoming/` + AppImage files). Preflight 2026-11-19 đã đúng. Đề xuất owner sửa HOMELAB.md.
- Journal histórico: lần restart duy nhất gần nhất là Nov 16 13:56:32 (core-dump `status=4/ILL` rồi start lại ngay) — đúng chuỗi deploy 0.7.13, không phải sự cố mới.

## EXEC path B (owner G1+G2 approved; parent decision `msg_20261120071156_81c2001b5e32`)

1. Candidate `LiX 0.7.14` built via Docker trixie; fixed deploy preset pins hashes; `deploy.py --plan` PASS. See `.agent-workbench/lix-web/deploy-candidate-host2-0.7.14-20261120.md` and artifact `build-receipt.json`.
2. Parent chose existing atomic installer; no deployer edits. Sequence: snapshot ProDesk `.pi` locally and verify counts/SHA; backup host-local registry+T20 canary; T20 reapprove on host using candidate SDK receipt/hash + ProDesk launcher path; then immediately atomic `deploy.py --apply --yes` with no turns admitted between.
3. If T20 gate doesn't pass, stop. If `--apply` fails/auto-rolls back to .7.13, restore both host T20 files from backup before old app accepts work. Verify user service, gateway 47900 and asar hash after apply.
4. UAT matrix spec T5 :302-314 (pairing, host isolation, owner handoff, event stream, extension/terminal, model/settings, attachment + negative set) — report each gate in `.agent-workbench/lix-web/`.
5. Serve 47900 KHÔNG đụng (G4 gate riêng). Candidate REBUILT r2 from SDK `cb84283857` per parent `msg_20261120123426` — release `0.7.14-58eb28f5`, `--plan` re-run PASS; snapshot cũ vẫn hợp lệ, không retake. ProDesk-local `.pi` snapshot **DONE**: ID `prodesk-lix-host2-pre-0.7.14-20261120T072256Z`; 9,686 files, 10 symlinks, 1 socket skipped, archive 45,590,306 bytes; independent SHA/count/tar readability PASS, hash/content remain on host. Registry/canary backup + T20 reapproval pending; no service stop or `--apply` yet. Next path B: host-local registry/canary backups → T20 pin `9cf819d2…` + launcher + gate verify → immediate atomic `--apply`; restore both T20 files if rollback/failure.

6. EXEC attempt log 2026-11-20: T20 promote PASS (`38f016b9`) → apply×3 (`b8cce605` STAGE_DIR r1 leftover → fixed; `01533f33` staging non-empty → cleared; `d591c5f7` switched + app boot crash ERR_MODULE_NOT_FOUND chalk) → auto-rollback completed → manual recovery + T20 restore PASS (`a74e5c56`). Host stable 0.7.13-9c8f2650, gateway listening. Root cause + fix options reported to parent `msg_20261120154335_23d75f647b87`; no further host mutation until approved.

7. R3 apply PASS 2026-11-20 16:24: owner fresh reconfirm → stale staging cleaned → T20 re-pin (`009778cc`, canary `220bdadeff62`, stamp `20261120T162355Z`) → atomic apply (`3a83c45c`, `LIX_DEPLOY_RESULT status=installed`, stage_cleanup=pass) → post-verify (`f8d95cff`): `0.7.14-6a3a8547` active, asar matches, gateway up, journal zero errors, rollback retained. G5 next; G4/G6/G7 unchanged.
