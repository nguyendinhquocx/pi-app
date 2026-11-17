# T3 Status — Browser transport + host manager (SPEC-2026-11-16-li-web)

Updated: 2026-11-17. Owner: parent. Design tokens: `apps/web/DESIGN.md` (verified 2 nguồn).

## DONE (code + tests trên pi-app, parent)

### 1. `apps/web` scaffold (standalone Vite PWA)
- `apps/web/{index.html, vite.config.ts, tsconfig.json, tsconfig.sw.json, public/{_headers, manifest.webmanifest, icon.svg}}`.
- Scripts mới root: `web:dev` (vite, port 5183), `web:build` (→ `apps/web/dist`), `web:preview`, `web:typecheck` (2 tsconfig: app DOM + sw WebWorker).
- `index.html`: meta robots `noindex, nofollow` + referrer no-referrer + **CSP meta đúng spec** (`default-src 'none'; script-src 'self'; connect-src 'self' wss://*.ts.net; …`, không unsafe-eval); anti-FOUC theme bootstrap (pattern LiX, key `lix-web-ui`).
- `_headers` (Cloudflare Pages): CSP authoritative + `X-Robots-Tag: noindex, nofollow` + nosniff + Permissions-Policy (camera=self cho QR) — frame-ancestors chỉ hiệu lực qua header nên có cả hai lớp.
- Dev-only transform mở rộng connect-src cho HMR localhost; production CSP giữ nguyên văn spec.

### 2. Transport (`apps/web/src/transport/`)
- `endpoint.ts`: chọn endpoint từ PairOffer — **trang HTTPS chỉ nhận `wss://`** (mixed-content refuse là error có hướng dẫn bật Serve), dev HTTP nhận cả hai, wss ưu tiên; mọi endpoint vẫn qua `isAllowedEndpoint` shared (private/tailnet host guard).
- `device-keys.ts`: **device key X25519 riêng mỗi host** trong IndexedDB (`lix-web`/`device-keys`, keyPath hostId) — record giữ priv/pub b64url, hostPub pin, endpoints, deviceId từ hs2, lastConnectedAt; `createDeviceKey` tái sử dụng key cũ per host (ổn định qua pair lại); Memory store cho test; forget = xoá record (revoke server-side ở LiX desktop — UI ghi chú rõ).
- `handshake.ts`: Noise-IK client handshake **byte-for-byte qua `@shared/remote/crypto` isomorphic** (cùng @noble/fflate với Android); `prepareHs1` tách build/send — finisher phải gắn TRƯỚC khi hs1 rời socket (host trả hs2 sync trong send); wrong-host key → hs2 không decrypt → refuse.
- `host-connection.ts`: state machine idle/connecting/handshaking/online/reconnecting/closed/error; typed RPC qua `REMOTE_METHODS` schemas (params + result parse); events dispatch qua `REMOTE_EVENTS`; **ping protocol frame 30s** (host idle 75s); reconnect **exponential backoff + jitter** (base 500ms, factor 2, cap 30s, jitter ±25%, rng injectable) reset khi handshake thành công; **resume watched sessions sau reconnect bằng cursor {epoch, seq}** (turn.patch cập nhật cursor, text.append dùng seqTo); `resync: epoch_changed|gap|evicted` → `onResync` (forced snapshot resync — envelope contract mức remote layer: hello.ownerProtocol ≥ 1 + session.open cursor); **offline mutation reject ngay (DisconnectedError), KHÔNG queue khi delivery ambiguous**; pending requests fail khi socket đứt; onclose idempotent (hs_err + close chỉ reconnect một lần).
- `reconnect.ts`: policy testable (rng inject).

### 3. Host manager (`apps/web/src/hosts/`)
- `host-store.ts`: paired hosts trong IndexedDB per host — `pairWith` tạo/refresh + ghi endpoint đã chọn; `markConnected` stamp deviceId; `forget` xoá local key (no-op lần hai).
- `pair.ts`: parse cả `pidesk://pair#` lẫn `https://li.quoc.app/#pair=`; **exp check 5 phút**; endpoint filter theo page policy; lỗi có hướng dẫn (Serve mixed-content, expired, bad_link). `pairFromFragment` pre-fill từ URL hash rồi clear fragment (single-use).
- `HostManager.tsx`: màn đầu liệt kê host đã pair + **online state** (dot + label per-state); pair flow **QR scan + paste cùng màn hình**; giải thích host identity (public key + địa chỉ tailnet, single-use, 5 phút) — không giảng network internals; nút Kết nối/Quên; ghi chú revoke ở desktop.
- `QrScanner.tsx`: BarcodeDetector feature-detect + getUserMedia camera (Permissions-Policy camera=self); không hỗ trợ → chỉ paste.

### 4. Service worker (`apps/web/src/sw.ts` — precache-only)
- Build plugin (vite closeBundle + esbuild) bundle sw.js với `__PRECACHE__` inlined từ output dir (5 files ở build hiện tại; sw.js và `_headers` không vào precache).
- Fetch handler: bypass network-only mọi URL `*.ts.net`, mọi non-GET, mọi origin khác, mọi path ngoài precache; precache GET hit cache, miss → network, **không bao giờ ghi cache runtime**. RPC/session/attachment không bao giờ qua SW.
- Đăng ký chỉ khi HTTPS (`sw-register.ts`).

### 5. `apps/web/DESIGN.md`
- Tokens copy nguyên văn từ `src/renderer/src/styles/globals.css` (:root light + .dark) + `tailwind.config.ts`.
- **Runtime evidence:** `.agent-workbench/lix-web/lix-runtime-capture.png` — LiX v0.7.13 dev chạy thật, chụp 2026-11-17 (sidebar + session list + spinner cam #ff7d00 khớp token). Ảnh README v0.6.0 được ghi rõ là historical, không làm evidence.
- Surface map T3 + dark values chốt sẵn cho T4.

### 6. Shared fix (dead code, không đụng schema)
- `packages/shared/remote/crypto.ts`: xoá 4 dòng dead `PKCS8_PREFIX/SPKI_PREFIX` (top-level `Buffer.from` — **crash browser import** vì không có Node Buffer). Không đổi wire format, không đổi schemas.

## VERIFY RESULTS
- `npx vitest run apps/web`: **39/39 PASS (7 files)** — endpoint policy (mixed-content, public-host refuse), device keys (Memory + fake-indexeddb persist across instances, per-host key stability, b64 round-trip), **crypto conformance khớp Android golden vectors** (`crypto-vectors.json`: hs1 byte-for-byte, hs2 payload, session keys c2s/s2c, frames hai chiều client+host, wrong-host key refuse), reconnect backoff (growth/cap/jitter band/reset/max), HostConnection (handshake→hello ownerProtocol, typed RPC schema parse, not_supported typed error, offline mutation reject ngay, pending fail on drop, resume từ cursor {e_1,8}, epoch_changed forced resync, keepalive ping, stop no-reconnect, not_found drop watch set), pair parsing (web + pidesk link, expired, ws-only trên HTTPS, bad_link, fragment), host store (per-host records, forget, IndexedDB persist).
- `npm run test:unit` toàn repo (2 lần chạy liên tiếp): **2382 passed / 0 failed** (lần đầu có 4 fail flake parallel-load — documented pre-existing pattern; lần 2 + 3 sạch).
- `npm run typecheck`: **PASS** (web + node). `npm run web:typecheck`: **PASS** (app + sw).
- `npm run web:build`: **PASS** — `apps/web/dist` đầy đủ (index 1.64KB, css 3.94KB, js 282KB gzip 90KB, `_headers`, manifest, icon, sw.js precache 5 files).
- `vite preview` smoke: index/sw/manifest/headers 200; CSP meta đúng nguyên văn spec.
- Lưu ý vận hành: `npm install` (thêm fake-indexeddb dev-dep) **gỡ symlink SDK** → phải chạy lại `node scripts/link-local-sdk.mjs` (đã chạy; đây lý do typecheck lỗi nhất thời `getOwnerStatus` giữa chừng).

## MANUAL_SMOKE_NEEDED (T5 hai host)
- WSS pair thật từ browser qua Tailscale Serve trên host thật (release gate riêng — owner duyệt Serve).
- QR scan camera thật trên mobile browser.
- Live handoff TUI ↔ Web với provider thật (long tool >90s).

## SCOPE_DEVIATIONS
- Không có so spec. Ghi chú: `owner_capability`/envelope T1 là worker-level RPC — web không claim ownership, nhận epoch/resync qua remote layer (`hello.ownerProtocol`, `session.open` cursor/resync) đúng vai trò viewer/operator trong spec.

## OUT_OF_SPEC_ADDITIONS
- BarcodeDetector QR scan (spec T3 chấp nhận "QR scan or pasted web pair link" — đã feature-detect + degrade paste).
- `fake-indexeddb` dev-dep cho IndexedDB tests.

## NEXT (T4)
- Workbench UI (host rail/timeline/composer/inspector) + extension parity theo matrix T0; quyết định Tailwind/shadcn setup khi đó; DOMPurify + OSC 52 off; subagent-tab flow; per-host version display.
