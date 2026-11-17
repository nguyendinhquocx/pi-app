# T2 Status — LiX gateway, pairing, host-side RPC parity (SPEC-2026-11-16-li-web)

Updated: 2026-11-17. Owner: Pi Android session. Parent verify entry: this file + `peer_result` evidence.

## DONE (code + tests, chưa commit — đợi parent verify rồi mới commit theo lane)

### 1. SDK bump (version gate T0 → thực hiện T2)
- `package.json`: `@earendil-works/pi-coding-agent` registry pin giữ `1.0.2` làm baseline; `scripts/link-local-sdk.mjs` (postinstall) thay node_modules copy bằng **symlink tới pi-mono-li fork builds** (coding-agent + pi-ai/pi-agent-core/pi-tui/pi-mcp/pi-codemode/pi-telemetry). `PI_MONO_LI_ROOT` override cho host khác.
- **TẠI SAO không dùng `file:` dep như spec ghi:** npm arborist crash (`loadPeerSet edgesOut`) khi resolve nhiều file: directory links không lockfile; và file: link chỉ áp cho root dep — transitive deps của nó (`pi-ai`) resolve registry 1.3.0 THIẾU fork symbols (`getLatestToolSelectionSnapshot`). Symlink postinstall là đường duy nhất chắc chắn cả hai host chạy đúng fork API. T5 build hai host dùng cùng script (Linux: PI_MONO_LI_ROOT).
- pi-mono-li monorepo **rebuild toàn bộ** (`npm run build`) để dist chứa T1 + pi-ai dist khớp source (dist cũ stale).
- Verify: `node -e "import('./node_modules/@earendil-works/pi-coding-agent/dist/core/session-owner-protocol.js')"` → OWNER_PROTOCOL_VERSION=1.

### 2. Ownership gate (mọi entry point ghi)
- Worker (`worker-owner-protocol.ts` mới): `enableOwnerStrictMode()` set `PI_SESSION_OWNER_STRICT=1` trước khi dựng session; `claimOwnerHandoffFromEnv()` consume `PI_SESSION_OWNER_CLAIM` TRƯỚC khi mở session (fail-closed exit 1 nếu SDK không có module); `classifyOwnerError()` map SDK errors → `writer_conflict`/`owner_unavailable` + parse owner pid.
- Worker handlers: init/loadSession/steer/followUp bắt owner errors → typed reply `{code, ownerPid}`; handler mới `ownerStatus` (getOwnerStatus từ T1 SDK).
- Main (`worker-owner-conflict.ts` mới): `WorkerOwnerConflictError` + `throwIfWorkerReplyError`; worker-manager sendPrompt/steer/followUp/loadSession throw typed; remote rpc dispatch catch → `RpcFail('writer_conflict'|'owner_unavailable')`. Desktop IPC cùng đường (workerManager chung).
- `frames.ts` ERROR_CODES thêm `writer_conflict`, `owner_unavailable` (backward-compatible: old client thấy code mới, hiển thị lỗi, không crash).

### 3. Handoff + leaf override
- Worker init-done/loadSession-done trả `ownerEpoch`; worker-manager `noteSessionOwnerEpoch(sessionFile, epoch)` (session-leaf-override.ts): epoch mới hơn → xoá in-memory leaf tip (thuộc branch view của writer cũ) + reload disk leaf. Epoch map xoá khi clear override.

### 4. Security
- Gateway `onUpgrade`: Origin allowlist (`https://li.quoc.app` + dev localhost/127.0.0.1) → 403 TRƯỚC handleUpgrade; no-Origin (native) đi thẳng handshake (Noise IK vẫn là gate). Host header chỉ private/tailnet/loopback (DNS-rebinding refuse).
- `/assets/*`: CORS chỉ allowlist + OPTIONS preflight 204/403.
- Session-key wire guard (`wireSessionKeyIsResolvable`): chỉ `.jsonl`, không null byte, không `..` — unknown keys refused trước khi đụng filesystem.
- Secret masking: extensions.list (name/version/loaded), skills.list (name/desc/enabled/source), host.status (versions + ownerProtocol + serve config) — không có credential value nào trong response.

### 5. Transport
- `isAllowedEndpoint`: `ws:` giữ port bắt buộc; **`wss:` mới** (default 443, Serve TLS). Serve hostname đọc từ auth-store config `serve` (read-only mirror; activation là release gate riêng).
- Gateway endpoints thêm `wss://<serve-host>/ws` khi config; host.hello trả `ownerProtocol` + `webPairLink` (`encodeWebPairLink` mới — `https://li.quoc.app/#pair=`); `decodePairLink` parse cả `pidesk://pair#` lẫn web link. Old Android: fields optional, pidesk:// giữ nguyên.
- Revoke: socket đóng 4006 (có sẵn) + handshake refused `revoked` (có sẵn) — tests phủ.

### 6. Crypto isomorphic
- `crypto.ts`: bỏ `node:crypto` (X25519 keygen/DH + hkdfSync) và `node:zlib` → `@noble/curves` (x25519), `@noble/hashes` (hkdf+sha256), `fflate` (raw deflate/inflate). Fflate `deflateSync` chính là raw DEFLATE (byte format unchanged). Decompression-bomb guard: inflate vào reusable 16 MiB cap buffer (thay maxOutputLength).
- Golden `crypto-vectors.json` regenerate: chỉ compressed frame đổi (compressor khác, cùng raw format); handshake keys vectors KHÔNG đổi. **Android CryptoVectorsTest 5/5 PASS** sau regenerate.

### 7. RPC parity v1 (mutations đóng băng theo matrix T0)
- Methods mới: `file.read/create/rename`, `session.rename/delete/clone`, `terminal.open/input/resize/close` (+ events `terminal.data`/`terminal.exit`), `host.status`, `skills.list/setEnabled`, `extensions.list`.
- turn.abort truthful: `{aborted, wasRunning, stopped, restored}` — aborted chỉ true khi wasRunning && stopped. steer/followUp trả `disposition` (handled|queued); no-session là typed error (không còn ambiguous success). worker-manager.abort trả `{wasRunning, stopped}` từ slot state + worker ack.
- Terminal lane riêng: `remote-terminal-bridge.ts` — mỗi terminal một PtyManager, output chỉ route về connection mở nó; cap 8 terminals; close khi connection đứt (`detachTerminals`).
- Kotlin (`apps/mobile/shared Methods.kt`): models + table entries cho toàn bộ methods/events mới; HelloResult/AbortResult fields optional backward-compatible.

## VERIFY RESULTS
- `npm run test:unit`: **2343 passed / 12 skipped / 0 failed** (394 files) — gồm tests mới: origin/host policy, wire session-key guard, owner bridge (9), terminal lifecycle + per-connection ownership, truthful abort, webPairLink, file/session ops, masked skills/extensions/status.
- `npm run typecheck` (web + node): PASS. `eslint` (toàn bộ files T2): PASS.
- Android `:shared:jvmTest`: **BUILD SUCCESSFUL** — CryptoVectors 5/5, EndpointPolicy 3/3, FixtureRoundTrip PASS (sau khi thêm Kotlin serializers cho methods/events T2).
- SDK runtime verify: owner protocol v1 + session-manager load từ node_modules fork.

## MANUAL_SMOKE_NEEDED (T5 hai host)
- Live handoff LiX worker ↔ external `li` TUI với provider thật (long tool >90s) — T1 remaining #3, T5 gate.
- Tailscale Serve activation + WSS pair từ browser PWA — release gate riêng (owner approval).
- Android app build + pair lại thật trên device (Kotlin unit PASS nhưng UI pairing flow chưa chạy).

## SCOPE_DEVIATIONS
- SDK bump dùng postinstall symlink thay `file:` pin (lý do kỹ thuật ở mục 1 — không phải thoái thác; pin registry baseline vẫn ghi trong package.json).
- `session.export` contract drift (matrix gap #11) KHÔNG fix — export không vào mutations v1 (orphan handler, cần owner xác nhận trước).

## OUT_OF_SPEC_ADDITIONS
- Không có. pi-mono-li không đụng (chỉ build). apps/web không đụng. Không public listener, không Serve activation, không DNS/tunnel.

## RISKS
- Envelope `{owner_epoch, seq}` opt-in (parent vừa hoàn tất) CHƯA consume ở SessionHub — cần parent confirm handshake flag shape khi T3 wire web client; SessionHub hiện vẫn cursor epoch per-hub (đạt yêu cầu "không tự sửa pi-mono-li").
- `li` runtime drift hai host (baseline version-gate #4) — chưa re-sync, lane riêng owner approval.
- Fflate inflate truncate-ở-cap: frame bomb bị cắt → JSON parse fail → socket close 4002 (an toàn, khác zlib throw path — đã test bomb logic trong unit? chưa — ghi GAP nhỏ, verify bằng test bomb riêng nếu parent yêu cầu).

## GAPS
- Decompression-bomb unit test riêng chưa viết (guard có qua cap buffer; behavior trunc→parse-fail→close đã reasoning, chưa assert).
- `session.export` drift giữ nguyên (out of v1).
- Serve config không có UI set flow (chỉ read mirror) — activation lane riêng.

## NEXT_ACTION
- Parent verify: replay T2 host security tests + review diff scope. Sau verify: commit theo lane (parent chủ trì), rồi T3.
