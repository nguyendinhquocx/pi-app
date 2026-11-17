# T1 Status — Shared session owner protocol (SPEC-2026-11-16-li-web)

Updated: 2026-11-16. Design doc: `.agent-workbench/lix-web/t1-design.md`.

## DONE (code + tests trên pi-mono-li/packages/coding-agent)

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

Lưu ý xác minh 2026-11-16: `interactive-mode-suspend` 2 failures là PRE-EXISTING (fail trên HEAD sạch qua stash check, không liên quan T1 changes).

## Handoff cho Pi Android (T2 phụ thuộc)

- Bump SDK pin → build chứa các symbols trên. Successor claim qua `PI_SESSION_OWNER_CLAIM` env khi spawn worker giữ session từ owner cũ.
- Ownership gate mọi entry point đọc trạng thái qua `session.getOwnerStatus()` / `isIdleForHandoff()`; mutating RPC phải route owner hoặc trả `writer_conflict` (đã có code từ registry).
- Leaf override (host) invalidate khi nhận handoff-claimed (epoch tăng) — chưa làm ở host.
