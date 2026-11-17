# T1 Design — Shared Pi session owner protocol (SPEC-2026-11-16-li-web)

Trạng thái: DESIGN LOCKED cho implementation. Parent-owned files trong `pi-mono-li/packages/coding-agent`.

## Hiện trạng verified (recon 2026-11-16)

- `session-open-lease.ts` (1756 dòng): registry file-based cross-process; `LEASE_REGISTRY_PROTOCOL_VERSION=1`; claim có `owner_pid` + `owner_start_utc`; `isProcessAlive`; `recoverStaleClaim` (verifier `stageReload` từ disk); `writer_conflict` code CÓ SẴN; `canonicalTranscriptIdentity` (path hash).
- `agent-session.ts`:
  - `_ensureSessionAccessGuard()` đã throw `SessionDataLockedError` khi claim của process khác còn sống → hai AgentSession KHÔNG mở được cùng file (strong hơn spec nghĩ).
  - **Lỗ fail-open thật** (GLM F4 chính xác): acquire fail hoặc `readClaim` error → `_markSessionAccessUnguarded()` → continue append KHÔNG guard. Chỉ trim bị disable, write vẫn chạy.
  - Idle predicate: `_pendingSessionWorkDetails()` 12 trường (steering/follow_up/next_turn/custom/bash/deferred_settled/agent_queue/agent_run/compacting/emitting_settled/retrying/failed_response) + `_hasPendingSessionWork()`.
  - Pending UI request KHÔNG nằm ở core (ExtensionUIContext là bridge; RPC emit `extension_ui_request` và chờ response) → cần flag trên runtime.
- `rpc-mode.ts` (832 dòng): JSON stdin/stdout; events stream qua `output()`; commands switch-case; `runtimeHost.session`. Chưa có owner/handoff/turn-status methods; abort chưa trả `wasRunning`.
- Event fan-out hiện chỉ tới MỘT client (stdout của process). Cross-process fan-out là việc của LiX SessionHub (T2) — T1 chỉ cung cấp envelope + epoch + heartbeat contract.

## Thiết kế

### 1. Module mới `src/core/session-owner-protocol.ts`

- `OWNER_PROTOCOL_VERSION = 1`.
- `OwnerStrictMode`: bật bởi env `PI_SESSION_OWNER_STRICT=1` HOẶC `writerEnforcement: "strict"` khi tạo runtime. Strict = reference implementation của owner protocol (LiX worker, RPC attach, tests). TUI local KHÔNG strict → giữ degrade cũ (an toàn người dùng hiện hữu; WSL boundary GLM gap).
- `OwnerUnavailableError` — strict mode + registry unavailable/acquire fail/readClaim error → **refuse write** (thay thế continue-unguarded). Message nêu path hash + reason; không bao giờ kế thừa `_sessionAccessUnguarded` continue trong strict.
- `OwnerHandoffRecord` mở rộng claim: `owner_epoch` (int, tăng mỗi handoff), `owner_kind` (`tui`|`lix-worker`|`protocol-test`), `writer_state` (`idle`|`running`|`handoff-pending`), `heartbeat_utc`.
- Handoff state machine (trên registry file, CAS theo claim):
  1. `requestHandoff(fromOwner)` — verify caller là owner hiện tại (claim khớp pid/start + epoch) hoặc holder handoff token.
  2. Idle check: `_hasPendingSessionWork() === false` && `uiPendingCount === 0`. Không thỏa → `handoff_refused` + pending details (tái dùng `_pendingSessionWorkMessage`).
  3. Idle → ghi `writer_state=handoff-pending`, owner cũ release claim (claim record chuyển tombstone `released_epoch=N+1`), owner cũ KHÔNG ghi thêm gì sau điểm này (transcript đóng băng).
  4. Owner mới acquire → nhận `owner_epoch = N+1`, BẮT BUỘC `stageReload` từ disk trước write đầu tiên; không dùng cache in-memory hay leaf override (liX side T2 invalidate `session-leaf-override`).
  5. Concurrent claim trong transition → `writer_conflict`. Không timeout takeover, không auto-kill. Hung owner: hiển thị `owner_pid` + hướng dẫn kill → kill tạo death proof → `recoverStaleClaim` tự chạy (đã có).
- `OwnerHeartbeat`: khi strict + running, owner emit heartbeat mỗi 15s (event `owner_heartbeat` + cập nhật `heartbeat_utc` trong claim). **Heartbeat trumps file-silence**: viewer giữ `running` khi có heartbeat mới hơn 90s, bất kể JSONL quiet. Flip idle chỉ khi heartbeat stale >90s AND file quiet AND (death proof hoặc pid dead). Thỏa acceptance long-tool>90s + giữ backstop chỉ cho owner-death.

### 2. Sửa `agent-session.ts`

- `_ensureSessionAccessGuard()`: strict mode → mọi path fail (unavailable/acquire fail/readClaim error) throw `OwnerUnavailableError`; non-strict giữ nguyên behavior.
- `isIdleForHandoff()`: `_hasPendingSessionWork() && uiPendingCount === 0`; expose `incrementUiPending()/decrementUiPending()` (gọi từ interactive/rpc layer khi emit UI request / nhận response).
- `_acquireSessionOpenLeaseIfNeeded()`: strict → acquire fail throw; ghi `owner_epoch`/`owner_kind`/`writer_state` vào claim.
- Write path: envelope mỗi event/session-append với `{owner_epoch, seq}` (seq per-epoch tăng dần) để viewer phát epoch change → forced snapshot resync.

### 3. Mở rộng `rpc-mode.ts` + `rpc-types.ts`

- Methods mới: `owner_status` → `{protocolVersion, ownerEpoch, ownerKind, writerState, isOwner, pid, idleForHandoff, pendingWork}`; `owner_handoff` → `{accepted|refused(reason, pendingWork)}`; `get_turn_status` → `{running, startedAt?, currentTool?}` (truth source `isAgentRunActive`); `owner_capability` handshake đầu tiên: client gửi `{protocolVersion, ownerKind}` — mismatch → typed error `protocol_mismatch`, fail closed.
- `abort` response thêm `wasRunning` (truth từ session state trước abort).
- Event envelope: mọi event ghi ra stdout bọc `{epoch, seq, type, payload}`; epoch đổi → viewer phải resync (contract ghi rõ; LiX hub map hai tầng cursor ở T2).

### 4. Test `test/session-owner-handoff.integration.test.ts` (mới)

Hai process THẬT qua `dist/bundle/rpc-entry.js` (hoặc `tsx` src) + protocol test client (Node child_process, JSONL stdin/stdout — chính là "protocol test client tối giản" spec yêu cầu; KHÔNG chứng minh gateway/browser thật, ghi rõ trong test header):

1. T1.1 handoff idle: A send turn xong → B handoff → accepted, epoch+1, B reload entries khớp A, B send tiếp OK, A bị từ chối ghi sau release.
2. T1.2 handoff khi running → `handoff_refused` + pendingWork `agent_run=true`; sau khi turn xong → retry handoff OK.
3. T1.3 handoff khi UI pending (incrementUiPending mà không decrement) → refused `pending_ui=1`.
4. T1.4 concurrent claim: A giữ, B force-acquire → `writer_conflict`; không tự takeover.
5. T1.5 death proof: kill -9 A → B attach → recoverStaleClaim → B owner, transcript nguyên vẹn, không replay turn.
6. T1.6 heartbeat: A chạy long tool (sleep 100s) → B viewer thấy `owner_heartbeat` đều, giữ running; A bị kill giữa chừng → heartbeat stale + pid dead → viewer flip + death proof path.
7. T1.7 epoch resync: sau handoff, events từ B mang epoch mới; client của A nhận epoch change → buộc snapshot.
8. T1.8 protocol mismatch: client khai `protocolVersion: 0` → `protocol_mismatch` fail closed.
9. T1.9 strict fail-closed: registry dir read-only → A strict refuse write với `OwnerUnavailableError`; non-strict vẫn degrade (regression guard cho TUI local).
10. T1.10 idle predicate regression: steering queue còn JIT → refused với details.

Acceptance mapping spec: canonical single writer (registry + guard, verified T1.4/T1.5), fan-out envelope (T1.7), handoff idle/reload (T1.1–T1.3), death/hung (T1.5/T1.6), long tool (T1.6), SDK mismatch fail-closed (T1.8), fail-closed registry (T1.9), 1.3.x↔1.3.x PASS + legacy fail closed (T1.8/T1.9).

## Không thuộc T1

- LiX SessionHub epoch/cursor mapping hai tầng — T2 (Pi Android) tiêu thụ envelope từ T1.
- Browser/Web client — T3.
- `session-leaf-override` invalidate — T2 side (host), hợp tác với handoff event.
- Pi Web archives — không dùng runtime.

## Open items khi implement

- `OwnerHandoffRecord` extend `LeaseClaimRecord` hay file riêng trong registry dir → quyết định khi đọc `parseClaimRecord` kỹ (ưu tiên extend, giữ format version bump nếu cần).
- Heartbeat timer lifecycle với `killTrackedDetachedChildren`/abort paths — không leak timer sau session close.
