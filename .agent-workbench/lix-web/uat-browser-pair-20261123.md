# Browser pairing UAT — R6 `0.7.14-df4d7582` (2026-11-23)

STATUS: PASS

## Scope

Browser pairing UAT trên production origin `https://li.quoc.app` bằng Chrome thật của owner
(missing piece cuối của R6: CSP/PWA đã verify 2026-11-22, WSS handshake đã verify bằng
curl/Python/local-origin; còn thiếu flow pair full từ origin production).

## Result

- Owner pair từ `https://li.quoc.app` bằng web pair link (payload decode từ QR desktop).
- Host side (Settings → Mobile → Devices): `Li Web — Chrome · Online · inc9nf1i`, role Full.
- Owner xác nhận "test đã hoạt động" — sessions load qua `wss://prodesk-home.tailff3893.ts.net/ws`.
- Gateway advertises đúng tailnet WSS endpoint trong Addresses + pair offer:
  `wss://prodesk-home.tailff3893.ts.net/ws` (+ 4 endpoint LAN/Tailscale cũ).
- 2 device rác "Li Web — Unpaired" từ lần pair headless 2026-11-23 sáng đã Remove khỏi danh sách;
  chỉ còn SM-A556E (android-36) và browser thật của owner.

## Environment

- Host-2: release `0.7.14-df4d7582` (app.asar `df4d7582…249a26`), gateway 47900, service active.
- Route: `sudo tailscale serve --bg --https=443 --set-path=/ws http://127.0.0.1:47900` (tailnet-only, không Funnel).
- Pair link: QR trên desktop (Settings → Mobile → New code) → chụp qua x11vnc loopback → decode
  bằng `zxing-cpp` (cv2 QRCodeDetector chịu thua QR dither) → đổi prefix `pidesk://pair#` thành
  `https://li.quoc.app/#pair=` (cùng payload, decodePairLink chấp nhận cả hai).

## Ops note (lần sau)

- Pair token chỉ nằm in-memory trong Electron app (auth-store), không đọc được từ disk; đường
  lấy link duy nhất là QR/copy trên desktop UI.
- vncdotool 1.3.0: không có wheel/scroll; click = mouseMove + mouseDown/Up; captureScreen cần
  cursor wiggle trước nếu frame tĩnh; process hay treo ở disconnect → kết thúc bằng `os._exit(0)`.
- Clipboard ServerCutText của x11vnc không tới được vncdotool client (stub copy_text rỗng) —
  "Copy pairing link" không dùng được qua VNC client này.

## Cleanup

- VNC service stopped (loopback-only), SSH tunnel 15900 closed, file chứa QR/token đã xoá.
- R5 `0.7.14-3e78241b` vẫn giữ làm rollback.
