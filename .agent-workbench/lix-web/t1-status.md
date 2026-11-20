# T1 Status — Shared session owner protocol (SPEC-2026-11-16-li-web)

Updated: 2026-11-20. Receipt host-2: `.agent-workbench/lix-web/receipt-host2-20261120.md`; candidate/plan: `.agent-workbench/lix-web/deploy-candidate-host2-0.7.14-20261120.md`. **G1+G2 owner-approved** (`peer_20261120043110_cc464ea2`); Candidate r2 rebuilt from SDK `cb84283857` per parent decision `msg_20261120123426_848bf36e58e6` (r1 `0fe3c21764` superseded: custom_message normalization risk); new hashes AppImage `d09942da…` / asar `58eb28f5…` → release `0.7.14-58eb28f5`, packaged verify + `--plan` PASS. Parent supplied citeable UFW + no-turn owner evidence (`msg_20261120072026_bacc835c062d`). Parent chose atomic-installer path B: local ProDesk `.pi` snapshot + host T20 reapprove immediately before `--apply`, no laptop registry copy. ProDesk-local `.pi` snapshot PASS: `prodesk-lix-host2-pre-0.7.14-20261120T072256Z`, independent counts/SHA/archive check. Parent path B (`msg_20261120071937_ec95f0c87c7e`): host-local registry/canary backup + T20 reapprove candidate immediately before atomic `--apply`; no laptop registry copy. r3 FIXED + DEPLOYED (option B, parent msg_20261120154748): +28 fork-pinned deps, copy materialization incl pi-schema, audit gate + asar smoke in pipeline; apply PASS → host-2 runs `0.7.14-6a3a8547` (AppImage `24087eb4…`), service active, gateway up, T20 pinned `9cf819d2…`, rollback 0.7.13 retained, journal clean. G5 UAT next. G4 Serve 47900 remains separate.

Design doc: `.agent-workbench/lix-web/t1-design.md`.

## T1 core primitives DONE; end-to-end TUI↔Web acceptance NOT YET VERIFIED

- `src/core/session-open-lease.ts`:
  - LeaseRecord owner extensions (owner_epoch/owner_kind/writer_state/heartbeat_utc/owner_protocol_version/handoff_token/handoff_epoch) — optional, legacy records parse tiếp.
  - `getLeaseForPath`, `isOwnedByCurrentProcess`.
  - Token-based handoff CAS: `beginHandoff` (owner cũ, mint token, handoff-pending) → `claimHandoff` (successor, epoch+1, consume token) → `abortHandoff`. Atomic qua `withIdentityGuard`; không timeout takeover, không gap window.
  - `heartbeatLease` — heartbeat_utc + writer_state dưới identity guard.
  - `acquireLease` single-writer enforcement CHO owner protocol callers (có ownerKind): same-process adopt, live-other-owner → `writer_conflict`, dead owner → reclaim bằng death proof. Legacy callers (không ownerKind) giữ hành vi cũ 100% (29 legacy tests pass).
- `src/core/session-owner-protocol.ts` (MỚI): `OWNER_PROTOCOL_VERSION=1`, heartbeat constants (15s/90s stale), `SessionOwnerUnavailableError`, `SessionHandoffError`, `OwnerProtocolMismatchError`, `resolveOwnerStrictMode` (env `PI_SESSION_OWNER_STRICT=1` / binding `writerEnforcement:"strict"`), `checkOwnerProtocolVersion` (handshake fail-closed), `claimSessionHandoffFromEnv` (successor claim TRƯỚC khi mở session qua `PI_SESSION_OWNER_CLAIM=agentDir|pathHash|token|sessionId`).
- `src/core/agent-session.ts`:
  - Options mới `writerEnforcement` + `ownerKind`; strict resolve lúc construct.
  - Strict fail-closed: registry unavailable/acquire fail/readClaim error → `SessionOwnerUnavailableError` thay vì mark-unguarded-continue. Non-strict giữ nguyên degrade (local TUI không phá).
  - Lease adopt cho handoff successor; heartbeat timer 15s (unref, clear khi release); `getOwnerStatus()`; `isIdleForHandoff()` (pendingWork + uiPendingCount); `incrementUiPending/decrementUiPending`; `beginSessionHandoff()` (idle check + registry begin).
  - `releaseSessionDataAccess` dọn heartbeat timer.
- `src/modes/rpc/rpc-mode.ts` + `rpc-types.ts`:
  - `owner_capability` handshake fail-closed (protocol mismatch → typed error); `owner_status`; `owner_handoff` (`handoff_refused` + pendingWork details); `get_turn_status`.
  - `abort` truthful: `{aborted, wasRunning, stillRunning}` từ `session.isStreaming`.
  - UI pending hook: extension dialog emit → increment; settle/timeout/abort → decrement (dialog chờ = KHÔNG idle).
- `src/rpc-entry.ts`: successor claim env xử lý trước khi dựng session.
- Tests: `test/fixtures/owner-protocol-child.ts` (protocol test client, hai process THẬT qua `--experimental-strip-types`) + `test/session-owner-handoff.integration.test.ts`:
  - acquire/conflict (`writer_conflict`), handoff token transfer epoch 1→2, wrong token fail, abort handoff + stale token fail, heartbeat state, death proof (SIGKILL → registry thấy dead → reclaim path), legacy parse compat.
  - Kết quả: 5/5 integration + full legacy lease suite 29/29 + in-place refresh 14/14 + retry/concurrent 18/18 + typecheck sạch.
  - Full-suite run có flake ở integration (parallel CPU load, spawn chậm) — isolated PASS; ghi nhận để T5 dùng timeout rộng hơn.

## Khai báo phạm vi harness (theo spec T1)

Harness hai-process chứng minh: single-writer registry, token handoff, conflict, death proof, heartbeat. KHÔNG chứng minh: gateway/browser transport, live event stream với provider thật — T2/T4/T5 verify.

## REMAINING (T1 continuation trước T2 integration)

1. ~~Event envelope~~ — DONE 2026-11-16: `owner_capability` nhận `wantsEnvelope: true` → events stream bọc `{type:"owner_event", owner_epoch, seq, event}` (seq per-epoch tăng; viewer thấy epoch đổi → forced snapshot resync). Opt-in, default raw events cho legacy clients.
2. ~~Interactive-mode (TUI) UI-pending hook~~ — DONE 2026-11-16: `trackedDialog` wrap select/confirm/input/editor trong `createExtensionUIContext`; dialog chờ → incrementUiPending, settle → decrement (handoff refused khi dialog mở).
3. Full rpc-entry hai-process với provider thật (long tool >90s, real turn) — T5 UAT gate.
4. Test case double-begin handoff — registry đã chặn (`handoff already pending`); thêm case khi làm envelope tests.
5. **REJECTED / BLOCKED sau Maker-Checker 3 lens (2026-11-19):** kiến trúc vẫn Option A staged C-first (ghi trong spec), nhưng core commits `287ed30dda`/`34ca5fe798` chưa đạt T1. Parent rerun 75/75 targeted tests + root/examples TypeScript + Biome 2,654 files + static checks PASS; `interactive-mode-suspend` giữ nguyên 2 known baseline failures `this.showStatus is not a function`. Test pass không đóng finding.

   **P1 cần sửa:** `releaseLease(lease_id)` có thể xóa lease successor sau claim; `SessionDataLock` thay rồi clear strict owner write gate; `SessionManager.open()` ghi header file 0-byte và `main.ts --name` ghi trước AgentSession/lease; claim env không kiểm canonical path/session cuối; bridge predecessor cleanup unlink discovery/token successor.

   **P2/gaps:** `steer`/`followUp` admission chưa được reserve trong async input hooks; bridge token sống qua session switch, auth global thay vì per-socket; epoch/reconnect chưa buộc snapshot resync, bridge capability handshake chưa bắt buộc; bridge test dùng `FixtureBridgeSession`, không phải AgentSession/TUI thật; death-proof test chỉ xác minh PID chết, chưa reclaim. Chi tiết gate bổ sung nằm trong spec Task T1 Maker-Checker addendum.

   Issue candidates: `iss_20261119132509_0a9b506625`, `iss_20261119133124_f358e47663`, `iss_20261119133124_e21a57b03e`, `iss_20261119133151_64ec5e74c6`, `iss_20261119133151_a468484805`, `iss_20261119133348_ab7a283187`, `iss_20261119133608_16e02489e7`, `iss_20261119133624_5dbf74d58b`, `iss_20261119133643_a569a7002f`. Pi-Mono owner đã cấp repair carve-out trực tiếp cho parent/integrator, giới hạn `packages/coding-agent/**` trên local `li/stable`; chỉ code/tests/targeted checks, không push/build/dist/T20/ProDesk/Serve/process kill. Parent đang sửa các P1 và thêm regression; T2/T5 vẫn đóng.

   **2026-11-20 02:49 — T1 REPAIR COMPLETE (parent report, msg_20261120024945, lane đã xác nhận diff 12 file +722/-114 atop `34ca5fe798`):** Maker-Checker 2 vòng — reviewer APPROVED (0 H/M, 5 L); delta verifier xác nhận F1-F4 + bridge hardening, 2 finding LOW còn lại đã vá (stale .json sau rotation → `#discoveryIsOurs` nhận expectedFingerprint; dọn param thừa) + test "updateSession rotates the token". Verify cuối parent: tsc sạch, integration 17/17, targeted 65/66+110/110. #33/#34 đóng từ phía parent. Còn lại của OWNER: duyệt commit/push + build refresh (dist d.ts stale; build bị cấm theo grant). **Contract mới cho LiX viewer khi integrate (T2 host lane):** subscribe gửi `protocolVersion` (thiếu → `protocol_mismatch` fail-closed); mọi subscribe/reconnect fetch full snapshot (ack `resync_required:true`); từ chối event có epoch cũ hơn epoch đã snapshot; xử lý hint `{type:"owner_epoch_changed", previous_epoch, owner_epoch, resync_required:true}` emit trước event đầu epoch mới (seq reset về 1).

   **2026-11-19 21:40 — FREEZE theo yêu cầu parent (msg_20261119142707):** diff unstaged 10 file trong `packages/coding-agent/**` (301+/58-) atop HEAD `34ca5fe798` là repair lane này thực hiện TRỰC TIẾP (parent-owned repair, không có child sống). Nội dung: (1) `releaseLease` fenced theo identity đầy đủ + regression stale-predecessor-release; (2) composite write gate `_sessionWriteGateRefusal` (handoff/data-lock + strict lease) không còn bị thay/xóa bởi `acquireSessionDataLock`; (3) `SessionManager` defer empty-header init + `main.ts --name` defer tới sau lease (`sessionNameToApply`); (4) claim env bind `expectedAgentDir/pathHash/sessionId` (win32 case-insensitive) + `main()` consume `PI_SESSION_OWNER_CLAIM` cho cả interactive/rpc (rpc-entry đã bỏ claim sớm); (5) strict owner acquire lease TRƯỚC file transcript tồn tại + guard pre-check không đòi existsSync; (6) fixtures `releaseLease` + `emptySessionFile` option; (7) 4 regression tests. Verify: focused suite 50/50 PASS 21:24 (trước 2 test cuối), rồi 13/13 PASS 21:39 gồm regression mới. KHÔNG push/commit mới; tree đóng băng chờ parent inspect/integrate.

Lưu ý xác minh 2026-11-16: `interactive-mode-suspend` 2 failures là PRE-EXISTING (fail trên HEAD sạch qua stash check, không liên quan T1 changes).

## Handoff cho Pi Android (T2 phụ thuộc)

- Bump SDK pin → build chứa các symbols trên. Successor claim qua `PI_SESSION_OWNER_CLAIM` env khi spawn worker giữ session từ owner cũ. LƯU Ý review 2026-11-19: host hiện KHÔNG set env này — `forkWorkerForCwd` (`worker-manager-pool.ts:360`) fork không truyền env; Phase 2 phải nối setter phía host.
- Ownership gate mọi entry point đọc trạng thái qua `session.getOwnerStatus()` / `isIdleForHandoff()`; mutating RPC phải route owner hoặc trả `writer_conflict` (đã có code từ registry).
- Leaf override (host) invalidate khi nhận handoff-claimed (epoch tăng) — chưa làm ở host.
