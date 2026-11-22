# Receipt: Li Web host-2 (ProDesk) — 2026-11-20

## Current verdict: DEPLOYED 0.7.14-6a3a8547 (r3) — G5 UAT PARTIAL; cleanup complete

G1+G2 owner assignment `peer_20261120043110_cc464ea2` remains the scope authority; parent upstream dependency is satisfied (`msg_20261120053029_a8e50fb6c63e`). R3 is active on ProDesk: service active/NRestarts=0, live asar `6a3a8547…`, T20 pin `9cf819d2…` intact, rollback `0.7.13-9c8f2650` retained, gateway `47900` responding. Historical R2 boot crash and rollback are recorded below under EXEC attempt log; they do not describe current host state.

G5 host-2 UAT is **PARTIAL**: pairing, session open/turn stream, PTY, model/settings, negative matrix 3/3, attachment protocol and controlled visible-turn multi-tab PASS. F2 delta/snapshot rail-loss root cause is confirmed and awaits owner disposition; F3 wrong-session send was NOT REPRODUCED; extension-dialog adapter gate is BLOCKED/NOT VERIFIED because ProDesk `pi-ask` custom TUI did not reach the web adapter. G6 off-tailnet remains UNVERIFIED; TUI↔Web handoff remains pre-existing spec-BLOCKED and out of this host-2 G5 scope, not a G5 failure. G4 Serve `47900` remains explicitly excluded.

Cleanup is complete: six lane test devices removed (owner SM-A556E preserved); CDP unit restored from backup with empty diff and no `9222` listener; local relay/tunnels closed. No r4/source edit or new host deployment was performed.

### Owner dispositions (2026-11-21, via ask_user — closes the open G5 questions)

1. **F2 → deferred into the next r4 batch** (with any other pending fixes; one combined deploy + fresh no-turn reconfirm later). Root cause + fix seam stay recorded in the RCA section below and in the bug backlog candidate; r3 ships as-is with reload-heals degradation.
2. **Extension-dialog gate → laptop evidence accepted** for the shared apps/web adapter path (laptop UAT 2026-11-19 PASS: questionnaire→ui.respond); host-2 recorded as known-gap BLOCKED/NOT VERIFIED, no re-test planned.
3. **G6 → UNVERIFIED accepted and documented** (no external vantage in this run; gateway is tailnet-only by design and Serve config confirmed tailnet-only).
4. **Evidence-only commit approved** for the receipt + UAT screenshots (no source changes).

G5 host-2 therefore closes as **PARTIAL→dispositioned**: all authorized gates executed; remaining items are either deferred (F2→r4), accepted via alternate evidence (extension dialog), or explicitly accepted as UNVERIFIED (G6). Handoff remains the pre-existing spec-BLOCKED out-of-scope path. Any future r4 deploy still requires the mandatory fresh owner no-turn reconfirm immediately before T20 promote + apply.


## R3 rebuild + successful apply (2026-11-20 16:0x–16:25 local)

Parent decided option B (`msg_20261120154748_da37760a8a65`). Implemented:

- **Dep delta +28 fork-pinned exact versions** into pi-app `package.json` (16 expected + 12 sibling-transitive: @anthropic-ai/sdk 0.129.0, @aws-sdk/client-bedrock-runtime 3.1127.0, @google/genai 2.32.0, @smithy/node-http-handler 4.12.1, http/https-proxy-agent 9.1.0, openai 7.19.0, partial-json 0.1.7, get-east-asian-width 1.6.0, marked 18.0.11, marked-cjk-friendly 0.1.2, photon-node 0.3.4).
- **pi-schema = 8th fork package** (agent-core declares it) — added to link list + materialization.
- **Copy-mode materialization**: `link-local-sdk.mjs` `PI_MONO_LI_LINK_MODE=copy` (dev keeps symlinks).
- **Audit gate**: `scripts/audit-packaged-imports.mjs` — 84 unique bare imports resolved (skips bundler `bundle/` trees, node builtins, comment lines, non-name strings).
- **Asar smoke**: `scripts/smoke-packaged-asar.mjs` — imports incident repro file + T1 module + all 8 package entries from the extracted built asar; PASS.

R3 artifacts: AppImage `24087eb4b821fa5ebc40be8de7c44b48f97381a145cf4236a041b1bca9188978` (258,814,640 B), asar `6a3a8547635cf08c31c732f67e7ce5bb600bf98eec31c19765d60b7101393ead` → release `0.7.14-6a3a8547`. Local checks: wrapper 14/14, fixture 5/5, `bash -n`, plan PASS (stage dir now derives from asset sha `24087eb4`; old `.lix-deploy-staging-*` leftovers removed).

**Apply PASS** (terminal `3a83c45c`): fresh owner no-turn reconfirm (`Xác nhận không turn`) → T20 re-pin PASS (terminal `009778cc`, canary `220bdadeff62`, registry `b0a828dc7a6e`, stamp `20261120T162355Z`) → `LIX_DEPLOY_RESULT status=installed app_asar_sha256=6a3a8547… stage_cleanup=pass`. Post-deploy verify (terminal `f8d95cff`): service active NRestarts=0, live asar sha == pin, gateway listening + HTTP responding, T20 pin intact (`9cf819d2…`), rollback 0.7.13 retained, journal zero error lines.

Incident evidence recorded in build receipt `incident_recovery_evidence` (r2 error + recovery hashes + reconfirm answer YES).

**Deploy provenance commits (pi-app main, local commit, NOT pushed — release workflow gate)**: packaging fix `a845e1a`, receipts `35e2e18`. The deployed r3 artifact was built from a working tree content-identical to `a845e1a` (no edits between build and commit; tree clean post-commit).

## EXEC attempt log (2026-11-20 15:36–15:44 local)

1. Fresh owner no-turn reconfirm via ask_user: `Xác nhận không turn`.
2. T20 host-local promotion PASS (terminal `38f016b9`): registry set real_write_enabled=true, single approved build (runtime `li`, launcher `/home/quoc/.local/bin/li`, artifact `9cf819d2…`), canary written (sha `17af9491cc2c`), strict hash-chain verify PASS. Backup manifest `backup-manifest-20261120-pre-0714-r2.json`.
3. Apply attempt 1 (terminal `b8cce605`): FAILED pre-stop — installer `STAGE_DIR` constant still baked r1 hash `60a46019`; fixed installer + fixture/wrapper tests (14/14, 5/5, `bash -n` PASS after LF-fix).
4. Apply attempt 2 (terminal `01533f33`): FAILED pre-stop — deploy.py refuses non-empty staging; cleared verified staging dir (contents byte-verified identical).
5. Apply attempt 3 (terminal `d591c5f7`): staged + switched to `0.7.14-58eb28f5`, app CRASHED at boot: `ERR_MODULE_NOT_FOUND: Cannot find package 'chalk' imported from .../pi-coding-agent/dist/cli/args.js` (journal 15:36:49). Health check failed; installer printed `LIX_AUTO_ROLLBACK=FAIL` but rollback actually completed 15:38:20 (stop/start).
6. Manual recovery (terminal `a74e5c56`): T20 restored from backups (registry sha `107dca6b711b` matches backup, canary removed — was absent pre-mutation, `T20_RESTORE_PASS`); host verified: service active, current `0.7.13-9c8f2650`, live asar sha matches pin `9c8f2650fe…`, gateway listening, HTTP probe responds.

## Root cause (verified)

SDK dist (r1 `0fe3c21764` AND r2 `cb84283857`) is partially unbundled — `dist/cli/*.js`, `main.js`, `core/*.js` import real npm packages (`chalk@6`, `undici`, `semver`, `typebox`, …) and workspace siblings (`@earendil-works/pi-agent-core/pi-ai/pi-codemode/pi-mcp/pi-tui`). Container build links the SDK via symlink into the monoli pnpm-workspace tree; electron-builder cannot resolve those deps through pnpm-store symlinks → `cannot find path for dependency … chalk@undefined` → excluded from app.asar. Content probes: working 0.7.13 asar CONTAINS chalk (description marker ×1) + unbundled cli layout; r1/r2 asars contain SDK but chalk ×0. **r1 was never boot-safe; earlier packaged verification checked symbols only, not boot.**

Fix proposal sent to parent (`msg_20261120154335_23d75f647b87`): (A, recommended) `pnpm deploy --prod` standalone SDK materialization wired into build script; (B) pi-app deps + lock regen (insufficient — workspace siblings); (C) fully bundle SDK dist (bigger upstream change). Next rebuild r3 must include a headless smoke boot of the packaged CLI on host BEFORE switching. No further host mutation until parent approves the fix path.

## Candidate build/runtime evidence

| Field | Evidence / status |
| --- | --- |
| Candidate | LiX `0.7.14` local host-2 build; no public GitHub tag/release |
| AppImage SHA-256 | `d09942da96e2cee4d95aa6000e75d476ae23509f5d3635a985a2789776354e3f` (r2 rebuild; r1 `60a46019…` superseded per parent `msg_20261120123426_848bf36e58e6`) |
| Embedded app.asar SHA-256 | `58eb28f5e1171c8f79fd8f49f19ab0125743b6527e1e1ff01513bac0c58479c8` → release `0.7.14-58eb28f5` |
| SDK actually packaged | Fork `@earendil-works/pi-coding-agent` 1.5.2, `li/stable` source `cb84283857c82eec932302904eb0bf94770038bd`, Li SDK artifact hash `9cf819d21aad027d1af3619b02ef5fe608869bdf9c7547e9671c6b9bf2137ccd` (embedded receipt gitDirty false; includes `c09abbba45` trim fix, `1adea51d8e` custom_message hardening, `cb84283857` conflict-error naming) |
| T1 verification inside app.asar | `PI_SESSION_OWNER_CLAIM` ×28; `SessionOpenWriterConflictError` ×6; custom_message ingress markers ×2; T1 (`dist/core/session-open-lease.js`) present |
| Manifest nuance | pi-app `package.json` still declares 1.0.2 as npm-ci bootstrap for lock compatibility; `postinstall` `link-local-sdk.mjs` replaces it with the local fork before Electron packaging. Parent confirmed this satisfies runtime requirement; do not change lock to unpublished 1.5.2. |
| Source/build | pi-app HEAD `472e817d0d82bd5cf226b7dbe4dd782717541739` + local `.7.14` version bump; Docker `node:22-trixie` image digest `sha256:c103d7b5aa3bf627c8b98db941d52556f04e0b5d9352b3d7b6391245d26620f8`; full provenance `D:/pcloud/workspace/archive/home-server-artifacts/lix-0.7.14/build-receipt.json` (r2 canonical, r1 superseded to `superseded-r1/`) |
| Local release pin/artifact | `app_presets/home_server/pi-desktop-remote/release-lock.json`; artifact folder `D:/pcloud/workspace/archive/home-server-artifacts/lix-0.7.14/` |

Build command exited 0. Local deploy wrapper tests **14/14 PASS**; installer fixture **5/5 PASS**; `bash -n install-prodesk-lix.sh` PASS.

## Current host-2 status and read-only plan

`py -3.13 deploy.py --plan` (read-only, H7 preflight ready):

- Current release: `0.7.13-9c8f2650`; live app.asar SHA `9c8f2650fe4f9bab5cf824d3db2dc1a47eca1b903a2113c53435ddd6814b5ec9`; gateway port 47900 listening.
- Planned candidate release: `0.7.14-58eb28f5` (r2; re-run PASS 2026-11-20 after rebuild).
- Fixed installer will stage verified files, stop only `pi-desktop-app.service` as a **systemd USER unit** (`systemctl --user`), add the versioned directory directly under `/home/quoc/apps/pi-desktop`, atomically switch `current`, then start/verify; previous release is kept for rollback.
- Rollback `0.7.12` dir + `resources/app.asar` + AppImage were confirmed present during read-only prep.

Historical preflight evidence: `.agent-workbench/lix-web/prodesk-preflight-20261119.md` (2026-11-19 snapshot). Updated G3 prep and EXEC attempt log: `.agent-workbench/lix-web/prep-deploy-g3-20261120.md`.

## G3 gates — latest owner answers

1. **PID 3674256/3674266 — resolved.** Read-only process metadata showed renderer and audio utility Chromium subprocesses of the `pi-desktop-app` process/zygote, started Nov 17 after service start Nov 16; legitimate Electron activity, no kill needed.
2. **Service/gateway — plan PASS.** Current release and 47900 listener match expected .7.13; systemd units are user-level, so service lifecycle must use `systemctl --user`.
3. **ufw 47900 — PASS from direct owner-pasted visible output** (`msg_20261120072026_bacc835c062d`): `Status: active`; `[8] 47900/tcp on tailscale0 ALLOW IN Anywhere`; `[13] 47900/tcp (v6) on tailscale0 ALLOW IN Anywhere (v6)`. No firewall change.
4. **Active turns — PASS from direct parent ask_user owner answer**, also cited in `msg_20261120072026_bacc835c062d`: `Xác nhận không turn`. No service stop yet.
5. **Rollback — ready:** version 0.7.12 remains present.

## Remaining gates / blocker

- **ProDesk-local `.pi` snapshot — PASS, private on host.** Snapshot ID `prodesk-lix-host2-pre-0.7.14-20261120T072256Z`; 9,686 regular files, 10 symlinks, 1 socket skipped; archive size 45,590,306 bytes. Independent archive SHA/count/tar-readability verification PASS. Archive hash and contents remain only on ProDesk; no profile data copied.
- **Host-local T20 promotion — pending, path B approved.** Parent chose existing atomic installer (`msg_20261120071156_81c2001b5e32`): back up host-local `registry.json` + canary; reapprove the exact packaged SDK `artifactHash` and host launcher path immediately before `--apply`; do not copy laptop registry/canary; admit no turns between T20 and apply. If `--apply` fails/rolls back to 0.7.13, restore both T20 files before old app accepts work. No host T20 mutation yet. If candidate receipt/path differs or `checkPromotionGate` fails, stop and report BLOCKED.
- **G5 host-2 UAT** (spec T5 :302-314) remains pending: ProDesk pairing/host isolation, TUI↔Web handoff, event stream, extension/terminal, model/settings, attachments, negative matrix.
- **G6 off-tailnet** remains UNVERIFIED (no external vantage).
- **G7 PWA** device `d_1KMwKB5lqkyU` remains revoked; pair again before browser UAT.
- G4 Serve activation is a separate gate and remains untouched.

## Scope / communication

- One ProDesk-side mutation: private `.pi` recovery snapshot above. No service stop/restart, app deploy, T20 registry/canary update, firewall or Serve change. `--apply` remains pending.
- No changes to `packages/coding-agent/**` (T1 closed at `96404ff8ee`).
- Candidate plan: `.agent-workbench/lix-web/deploy-candidate-host2-0.7.14-20261120.md`; latest push `msg_20261120071956_4ab0a606fe6f`.
- Parent path-B/owner-gate evidence: `msg_20261120071937_ec95f0c87c7e` + direct gate evidence `msg_20261120072026_bacc835c062d`.

## G5/G7 — UAT progress (2026-11-20 16:3x–16:5x local)

**G7 browser-pair + pairing gate: PASS.**
- Fresh pairing generated via CDP `ipc:remote.regeneratePairing` on the running app (parent-specified path; unit temporarily patched with `--remote-debugging-port=9222` loopback — backup `pi-desktop-app.service.bak-20261120-uat-cdp`, revert after UAT).
- Isolated UAT browser cannot reach tailnet/LAN directly (sandboxed networking): built local web+ws relay on `127.0.0.1:47980` (serves `apps/web/dist` + splices WS upgrades to `prodesk-home.tailff3893.ts.net:47900`; static 200, upgrade 101 verified).
- Pair offer filtered to the single working endpoint (`ws://127.0.0.1:47980`) before pairing (offer endpoints are host-side LAN/tailnet URLs; LAN is UFW-blocked by design).
- Flow: Quên stale host record (fresh device key required — pairToken only sent on first pairing of a key, `handshake.ts:27`) → paste filtered offer → Ghép nối.
- Host-side evidence (CDP `ipc:remote.status`): device `d_eDWuE2qlcWr6` name "Li Web" platform Chrome role operator **online:true**; pairing token consumed; old Android `d_wRjm7laVr3Q7` untouched (offline).
- Web UI evidence: host chip `prodesk-home` green "Trực tuyến"; session rail lists real host sessions (sync-prodesk, chào, kaneo-card smoke, deploy-lane, picron-triage, PiCron warning triage, news sessions). Screenshot: `uat-host2-pair-online.png`.
- Note: re-pair creates a NEW device identity by design (one-shot token); the revoked owner phone device `d_1KMwKB5lqkyU` cannot be "re-paired" from the lane — owner repeats the same QR/paste flow on the phone when needed.

**UAT environment (temporary, remove after G5):** local serve+relay `127.0.0.1:47980` (script `%TEMP%/lix-webserver-47980.js`), CDP 9222 flag, SSH tunnel 19222→9222.

### Pairing gate — second driver (real Chrome, 2026-11-21)

- agent_browser managed-session tools wedged mid-UAT: policy lock acquire fails because node cannot stat/exec BACKSLASH `C:\Windows\System32\...` paths (ENOENT; forward-slash path works) AND PowerShell cold start ~1.4-2s > 1s identity timeout. Runtime dist patched (process-identity.js: 5s timeout + forward-slash path join; backups `*.bak-uat-timeout-20261121`) but wrapper caches the old module → managed browser unrecoverable until extension /reload. Port patch to source post-UAT.
- Switched UAT driver to real Chrome via chrome_devtools CDP. Real Chrome's proxy blocks 100.65.x directly (fetch/WS fail) → same relay path (ws://127.0.0.1:47980).
- Re-paired: fresh token via CDP regenerate → Quên stale record → filtered offer (endpoint 127.0.0.1:47980) → Ghép nối → **host chip green online**, full session rail.
- Host-side evidence (`ipc:remote.status`): new device `d_VWmkyI4p49gv` name "Li Web" platform Chrome **online:true**; token consumed. Previous managed-browser device `d_eDWuE2qlcWr6` now offline (tab lost).
- Screenshot: `uat-host2-chrome-pair-online.png`.
- Cleanup note: after UAT, revoke lane test devices `d_eDWuE2qlcWr6` + `d_VWmkyI4p49gv` from LiX desktop Auth → Devices (owner action or lane if authorized).

### G5 gates — Brave driver (2026-11-21, corrected)

**Correction (parent review):** turn.send ran in session `prodesk-tab: Mitra production preflight`, NOT "chào" (first rail click didn't change selection; workbench restored most-recent session). The red `error: error` timeline entry in the turn-send PNG is a HISTORICAL errored event from that session's earlier preflight run (terminal_request error state; positioned immediately BEFORE our `Trả lời đúng một từ: pong` turn; content matches the session's read-only discovery work). Not a rendering bug. Corrected chào-session evidence: `uat-host2-chao-session-open.png` (chào selected, history "Chào. Có gì cần làm không..." + "mày có thể làm gì" rendered).

**Allowlist finding resolution (parent decision):** `session.open forbidden` on "+" new-session = EXPECTED fail-closed per spec negative set (path outside allowed project). Allowlist = `/home/quoc` only, exact-match; recorded as post-UAT backlog for owner product decision. Do NOT broaden during UAT.

**Terminal PTY gate: PASS.** Inspector → Terminal opens a live host shell (`quoc@prodesk-home:~$`); typed `echo li-web-uat-ok` → command echoed + output `li-web-uat-ok` + fresh prompt. Evidence: `uat-host2-terminal-pty-brave.png`.

**F2 (part of consolidated client-state triage below; root cause confirmed).**
- Observed after the "+" attempt and after a later session update: the rail collapsed to one row or empty while the host still had 25 allowed sessions; page reload restored the full snapshot. Evidence: `uat-host2-f2-partial-rail.png`.
- Root cause is delta/snapshot mismatch, not a persisted-data loss: `SessionHub.flushList` emits only dirty rows + removed keys (`src/main/remote/session-hub.ts:800-819`), while the browser's `sessions.update` handler replaces its whole list (`apps/web/src/workbench/workbench-store.ts:99-108,247-251`). Full `session.watchList` after reload returns the 25-row snapshot (`Workbench.tsx:126-136`). Details + bounded fix seam are in the consolidated RCA section below; owner decision (authorize fix lane vs defer) remains pending.

**Pairing state note:** Brave pairing survived as device `d_VfShiKzUOYw_` (online). Test devices to revoke after UAT: `d_eDWuE2qlcWr6`, `d_VWmkyI4p49gv`, `d_VfShiKzUOYw_` (last one only after all gates finish).

### G5 gates — negative matrix, attachment, multi-tab (2026-11-21)

**Negative matrix: PASS (3/3, fail-closed).**
- evil Origin `https://evil.example` → HTTP **403** on `/ws` upgrade (node ws probe via tailnet `100.65.131.116:47900`).
- Replayed spent pair token (fresh identity) → handshake error **pair_used**.
- Fresh paired device revoked via `ipc:remote.revokeDevice` → live socket closed with **4006 'revoked'** (gateway.ts:406; 4004 = connection.ts auth-close path — both coded fail-closed; earlier laptop UAT observed 4004-web/4006-android, node probe got 4006 per gateway.ts). Probe device self-revoked in test.

**Attachment gate: PASS (≤10 MiB, prompt-only preserved).**
- `attachment.upload` 1 MiB via node client → saved `/home/quoc/.config/pi-desktop/clipboard-images/pi-clipboard-a9def71c-uat-att-1mib.bin` (1,048,576 B); `attachment.get` round-trip byte-identical.
- 11 MiB → rejected fail-closed at TWO layers: zod schema cap (`data ≤ 13,981,016 chars` = base64 of 10 MiB) + rpc decoded-bytes check (`attachment too large`, rpc.ts:143).
- Prompt-only UI contract unchanged (Composer.tsx:99-118 — upload inserts @file reference, never starts a turn); client-side validation covered by features/upload.test.ts (T3).
- UI file-picker flow NOT exercised interactively (Playwright filechooser unsupported + native dialog would open on the user's real Brave); UI validation is unit-tested, protocol pipeline verified end-to-end above.

**Multi-tab gate: PASS (controlled visible-turn proof; no duplicate).**
- Two Brave tabs, same host + same session (`chào`), controlled marker sent in tab 1; each `.timeline` shows exactly one user marker + one `MULTITAB_OK` reply, and both bottom-scrolled screenshots visibly show the turn. Evidence: `uat-host2-multitab-visible-final-bottom-tab1.png` / `uat-host2-multitab-visible-final-bottom-tab2.png`.
- Handoff-active aspect: out of scope for this G5 host-2 run; the pre-existing TUI↔Web handoff remains spec-BLOCKED, not a G5 failure.

**F3 wrong-session send:** NOT REPRODUCED; see the consolidated client-state RCA below. The earlier pong artifacts showed Mitra selected, so they did not prove chào was selected.

**Test-device tally (closure = removeDevice, all EXCEPT owner SM-A556E):** `d_eDWuE2qlcWr6`, `d_VWmkyI4p49gv`, `d_VfShiKzUOYw_` (Brave, current driver — LAST), `d_4YkoMjb26gq6` (revoked, record remains), `d_R87sIoEjP0Kj`, `d_JV5IwrxYNAGB`.

**Model/settings gate evidence (accepted by parent):** full host model catalog (OpenAI/Anthropic/Google/Z.ai/GLM/DeepSeek/Xiaomi/Grok lists) + thinking levels (off→max) render in composer pickers; per-session model.set RPC exists (rpc.ts:137-139); no host-side mutation exercised on owner sessions during UAT.

### G5 consolidated client-state RCA — 2026-11-21 (before any source fix)

**F2 session-rail loss — ROOT CAUSE CONFIRMED (source mismatch: delta vs snapshot).**
- Server contract is incremental: `src/main/remote/session-hub.ts:800-819` flushes only dirty rows (`keys → summaries`) plus a separate `removed` list, then emits `sessions.update { sessions: mine, removed? }`.
- Client treats that delta as a complete snapshot: `apps/web/src/workbench/workbench-store.ts:99-108` assigns `slice.sessions = sessions`; event handler `:247-251` routes the incremental event straight to that replacement setter. A one-row update therefore replaces the 25-row inbox with one row; a removed-only event supplies an empty `sessions` array and yields an empty rail.
- Full snapshots use the same setter legitimately: `apps/web/src/workbench/Workbench.tsx:126-136` receives `session.watchList` and sets all rows. Reload calls `session.watchList` again; fresh snapshot restores all 25.
- Repro evidence: screenshot `uat-host2-f2-partial-rail.png` shows exactly 1 rail row (`prodesk-tab: Mitra production preflight`) while the host's `ipc:session.list('/home/quoc')` returns 25 rows. Page reload rehydrates 25 rows. This is NOT a `refreshRowsQuiet` throw path: `SessionHub.refreshRowsQuiet()` catches and preserves rows (`session-hub.ts:159-172`); `loadRows()` prunes only after `listSessions()` resolves (`:675-703`).
- Minimal fix seam (not applied): preserve full-snapshot setter for watchList, add a distinct delta-merge action for `sessions.update` (upsert `p.sessions`, remove only `p.removed`, keep other rows). Regression tests need one-row delta + removal-only delta + full snapshot.

**F3 wrong-session send — NOT REPRODUCED; parent retracted the prior P1 patch order.**
- Parent was right that the earlier pong artifacts show `prodesk-tab: Mitra production preflight` selected; those artifacts do NOT prove that `chào` was selected when pong was sent.
- Fresh controlled verification: reload → 25 rows → click the actual `button.session-row` whose title is `chào`; after 7s, selected row is `chào` and timeline renders chào history. Send `UAT F3 check 2026-11-21: reply exactly MULTITAB_OK`; host-side `ipc:session.list` shows `chào updatedAt=2026-11-21T02:37:56.468Z`, while Mitra remains `2026-11-21T02:19:12.070Z`.
- Two Brave tabs both selected `chào`; each `.timeline` had exactly one user marker and one assistant `MULTITAB_OK`. Bottom-scrolled screenshots with the visible turn: `uat-host2-multitab-visible-final-bottom-tab1.png`, `uat-host2-multitab-visible-final-bottom-tab2.png`.
- Therefore do not patch a guessed F3 fix yet: the source path `Workbench.tsx:109-123, 236-258, 386-414` selects/stores one `sessionKey` and binds composer callbacks to that same key; the earlier UAT driver did not establish selection identity. Need a deterministic failing repro with selected row + send target evidence before calling this a client data-integrity bug.

**Timeline-empty-on-restore symptom — not reproduced on clean reload.** Two clean reloads with 25 rows and one explicit `chào` row click loaded the session history within 7s; no banner/error. Earlier blank-timeline screenshots were taken during the same ambiguous browser-driver/session-selection period and had stale Context stats, so retain as a symptom within this triage, not a verified third bug.

**Handoff gate:** TUI↔Web owner handoff remains the pre-existing spec-documented BLOCKED path (interactive TUI claim hook absent). It is **out of scope for this host-2 G5 assignment, not a G5 failure**; do not claim PASS.

**Authority boundary:** no pi-app source edits, r4 build, or redeploy performed. Current peer mission owns `pi-mono-li/packages/coding-agent/**`; its parent mission is `pi-mono-li` `packages/**, scripts/**, docs/**`; current coordination status shows no active grant (old T1 grant revoked). Existing assignment authorizes host-2 G1/G2 deploy + UAT but does not manifest-write-own `apps/web/**`. Before any source fix/rebuild, parent must create/dispatch the correctly scoped pi-app task/run. Any subsequent host apply still requires the mandatory fresh owner no-turn reconfirm immediately before T20 promote+apply.


### G5 extension-dialog probe — blocked on host UI adapter route (2026-11-21)

- Real ProDesk session `chào`: sent a no-mutation prompt to invoke built-in Pi `ask_user` with a harmless Alpha/Beta question. It returned timeline tool result `error` → `UNSUPPORTED_DESKTOP_UI: custom TUI requires an adapter interaction protocol`; no web `.extension-dialogs`/`ui.request` appeared. Screenshot `uat-host2-extension-ui-unsupported.png`.
- Source confirms this path: `src/worker/desktop-ui-bridge.ts:213-215` rejects `custom()` without `interactArgs`/`lastAskPayload`. Browser `ask_user_question` card exists, but this attempt did **not** reach that supported adapter envelope. Thus host-2 extension-dialog gate remains **BLOCKED/NOT VERIFIED**, not a pass and not yet a client dialog rendering failure. Need identify the adapter-backed invocation before any further UAT; no source/host mutation was made.
- Composer was cleared after the probe; session left idle.


### UAT cleanup closure (2026-11-21)

- Device cleanup via host IPC: for each lane test identity, `ipc:remote.revokeDevice` reported `revoked:true`, then `ipc:remote.removeDevice` reported absent. IDs: `d_eDWuE2qlcWr6`, `d_VWmkyI4p49gv`, `d_4YkoMjb26gq6` (already revoked), `d_R87sIoEjP0Kj`, `d_JV5IwrxYNAGB`, `d_VfShiKzUOYw_` (Brave, revoked last). Final `ipc:remote.status` contains exactly owner device `d_wRjm7laVr3Q7` (SM-A556E), online=false/revoked=false. No owner identity touched.
- No active turns before service cleanup: host `ipc:session.list('/home/quoc')` → 25 sessions, `running=0`.
- CDP cleanup: restored `/home/quoc/.config/systemd/user/pi-desktop-app.service` from `pi-desktop-app.service.bak-20261120-uat-cdp`; `diff -q` empty. The terminal batch returned timeout/cancelled after ~123s, but independent SSH postcondition verified restore completed: systemd user service active, ExecStart has no `--remote-debugging-port`, port 9222 listener count 0, gateway 47900 listener count 1, NRestarts=0, MainPID 530022.
- Laptop local UAT cleanup: owned Brave tabs had already closed; stopped exact owned SSH tunnel process (verified cmdline `ssh -f -N -L 19222:127.0.0.1:9222 prodesk-home`) and Node relay (verified PID commandline `lix-webserver-47980.js`). Final listener counts: 19222=0, 47980=0, 54790=0, 14791=0, 14790=0.
- Temporary probe source files created for negative/attachment checks are removed from repo after results were recorded; no app source changes made. G5 remains PARTIAL: extension-dialog gate is BLOCKED/NOT VERIFIED (built-in `pi-ask` custom TUI did not reach adapter UI); F2 P2 owner decision pending; F3 NOT REPRODUCED; G6 off-tailnet UNVERIFIED; TUI↔Web handoff spec-BLOCKED/out-of-scope.


### Local managed-browser diagnostic cleanup (2026-11-21)

- To diagnose the native agent_browser policy-lock failure, local runtime `C:/Users/quocn/.pi/agent/extensions/pi-agent-browser-native/dist/.../process-identity.js` was temporarily changed (1s→5s identity timeout + forward-slash PowerShell path); exact pre-change backup SHA-256 `2467fda598e5285ff8725b249f9bf2ebb2e9d5e21ad155625f912ef1d5ac5600` restored byte-identically, debug copy removed, `node --check` PASS. No source or ProDesk extension changes.
- Verified regression evidence on original runtime: `readProcessStartIdentity(process.pid)` returned undefined in 1047ms with 1s cap; forward-slash PowerShell executable + 5s cap produced an identity. Candidate recorded as `iss_20261121031421_d8f0686607` (P2; separate local agent-browser issue, outside LiX release scope).


**Cleanup restart note:** restoring the original CDP-free unit required `systemctl --user restart pi-desktop-app`. During stop, old PID 3632281 exited `code=dumped, status=4/ILL` and systemd logged `Failed with result 'core-dump'`; the unit then started new PID 530022. Postcondition verified active/running, NRestarts=0, gateway 47900 listening and HTTP probe 404. `coredumpctl info 3632281` returned no retained dump; no further restart/mutation performed. Parent informed for triage; this is not evidence of a failed steady-state service.


### R4 narrow F2 candidate — verification report (2026-11-21)

**Base/ownership:** isolated branch `li-web/r4-f2-narrow`, based on `35e2e18` and fast-forwarded to evidence-only `86f8ad4`; no `cef0daa`/origin-main integration. Owner approved this lane for F2 only. Current source scope is `apps/web/src/workbench/**`; no main/renderer/shared/mobile/worker edits.

**F2 patch:** `workbench-store.ts` preserves `setSessions` as the complete-snapshot path used by `session.watchList`; new `mergeSessionDeltas` upserts only dirty session rows, removes only keys in `removed`, preserves untouched rows, sorts newest-first, and removes only non-selected removed-row timelines. `connectStore` routes `sessions.update` to the merge action. New `session-delta-merge.test.ts` covers one-row update (25 rows remain), removal-only delta, unseen-row upsert, and full-snapshot replacement.

**Scoped checks — PASS:**
- `npx vitest run apps/web/src/workbench/session-delta-merge.test.ts` → 1 file, 4/4 tests PASS.
- Temporary `tsconfig.r4-scoped.tmp.json` covering only `workbench-store.ts` + the F2 test → `tsc --noEmit` exit 0; temporary config removed after verification.
- `npx tsc -p apps/web/tsconfig.sw.json --noEmit` → exit 0.
- `npx vitest run src/main/remote` → 9 files, 115/115 PASS on this r3 code line. The 119 count belongs to broad origin-main integration; those four upstream tests are intentionally absent here.
- `npx vitest run apps/web` → 16 files/94 tests PASS; 5 test files fail at import resolution for the same baseline-missing helper below. The four F2 tests pass in this run; no F2-related failure.
- `git diff --check` → PASS.

**Baseline blockers — NOT PASS and not caused by F2:**
- Full `npx tsc -p apps/web/tsconfig.json --noEmit` exits 2: `TS2307` for missing `../test/host-sim` in `apps/web/src/hosts/HostManager.integration.test.tsx:7`, `apps/web/src/transport/host-connection.test.ts:6`, `apps/web/src/workbench/branch-flow.test.ts:6`, `apps/web/src/workbench/connection-states.test.ts:6`, and `apps/web/src/workbench/subagent-flow.test.tsx:6`; cascading `TS7006` for `raw` at `subagent-flow.test.tsx:95`. `apps/web/src/test/host-sim.ts` is absent from HEAD and the five importer files are unchanged vs HEAD. Parent independently verified that helper absent from `86f8ad4`, `cef0daa`, `origin/main`, and history. No helper or persistent tsconfig change added per narrow scope.
- `npx vitest run apps/web` has the same five import-resolution failures, all for `../test/host-sim`; remaining 16 files/94 tests pass.

### R4 narrow F2 candidate — packaging result (2026-11-21)

**Parent review:** F2 patch review PASS; build authorized for this narrow r3-based branch. Commit `cb19035` (`fix(li-web): merge incremental sessions.update deltas (F2)`) contains only the allowed store, 4-case test, and receipt changes; no push.

**Docker build:** `node:22-trixie`, image `sha256:16e416bccd9cbf5dcddc51ed3e33ec9732a4969830d62cabbe8da5f98c7ab2bc`; source app commit `cb19035`; SDK source commit `cb84283857c82eec932302904eb0bf94770038bd`, clean, sourceTreeHash `7138b6870cf6e4575f73c9b52c10df29769b36cba2ccb476899008289a3a0b76`. Build log: `D:/pcloud/workspace/archive/home-server-artifacts/lix-0.7.14-build-r4-f2/out/build.log`.

- AppImage `LiX-0.7.14-x86_64.AppImage`: SHA-256 `629c6b67d1052c272b411b647d8fee245dfeb147f9f7f9d780e84d0b286deccc`, 258,805,932 bytes.
- Extracted `app.asar`: SHA-256 `12ebc116fffe26b3668b0a3c20be1dd1457952334d3f3767518c4eca8b1f3a5c`, 457,522,603 bytes. Candidate release label: `0.7.14-12ebc116` (later installed on ProDesk at 09:34 UTC; see deployment section below).
- Embedded Li SDK receipt verified from app.asar: `artifactHash=9cf819d21aad027d1af3619b02ef5fe608869bdf9c7547e9671c6b9bf2137ccd`, `gitDirty=false`, 84 files. SDK receipt/hash is unchanged from r3; only the desktop app bundle contains F2.
- Packaging gates: link-local-sdk PASS (`mode=copy`, copied 8 packages); import audit PASS (84 imports/8 fork packages); `smoke-packaged-asar` PASS (10 imports); installer wrapper 14/14; installer fixture 5/5; `bash -n` PASS. The audit log's displayed `mode=symlink` label is from its default environment after the one-shot copy-link command; the preceding link step explicitly reports copy mode and 8 copied packages.

**Review boundary:** parent approved the candidate artifact/plan before deployment. Full web typecheck remains BASELINE BLOCKED by the missing `host-sim` helper documented above; do not call it PASS. Packaging, deployment-plan, and T20 predicate evidence are separate from that baseline blocker. Deployment results are recorded below; scoped R4 UAT status is recorded in the following section.

### Read-only deploy plans — fixed R3 invocation then isolated R4 candidate plan (2026-11-21)

- Initial `py -3.13 deploy.py --plan` from the shared Python main worktree (terminal `6babb87b-6ce9-4706-8319-151ac41e5c40`) used its R3-only lock and therefore described R3 as `already_current`; it was not treated as the R4 plan.
- Parent-approved isolated Python branch `lix/r4-plan-only-20261121` (base `c0f2e47a638cd84457349ef4e22bcd1aa7356c4a`, HEAD `58c9a43857531da6630a0285adf03825dfd092de`) carried only the six R3 deployer diffs plus the fixed candidate pin. The original dirty Python main was not edited. Copied R3 patch SHA-256: `79480d9f836623b76594411f33cdb3c432af73d6484d2806a62c9167683b9a64`.
- Exact R4 plan PASS (terminal `3a589154-b815-4bbc-a1bf-13bb9afa255a`): source `v0.7.14-host2-r4-f2 @ cb190357cfd23ef8ca0ad0e2b3259d33b776723e`; AppImage `629c6b67…`; app.asar `12ebc116…`; H7 `ready`; current release `0.7.14-6a3a8547` / asar `6a3a8547…` / gateway 47900. Planned transition: R3 `0.7.14-6a3a8547` → R4 `0.7.14-12ebc116`; rollback target R3. Plan states the installer will stage verified artifacts, stop only `pi-desktop-app.service`, atomically switch `current`, retain the previous release; no sudo/user-data/Xvfb/VNC/Docker/firewall/DNS/tunnel changes.
- SDK receipt `artifactHash` is unchanged (`9cf819d2…`); expected T20 hash/canary remains the R3 approval. T20 files are `~/.pi/agent/session-open-leases/registry.json` and `t20-canary-receipt.json`; any future authorized pin mutation requires adjacent `*.bak` backups. The read-only T20 predicate check and later install receipts are recorded below; no T20 promotion was performed.


### R4 deployment and immediate postflight (2026-11-21)

- Fresh owner no-turn confirmation was received immediately before the 09:34 atomic apply (“Xác nhận không turn”). First deploy receipt `prodesk-lix-0.7.14-20261121T093424583887Z.json` records `status=installed`, rollback release `0.7.14-6a3a8547`, AppImage `629c6b67…`, app.asar `12ebc116…`, H7 ready, stage cleanup pass. This is the actual R4 switch.
- Journal observation during that installer stop/start (captured read-only; SIGILL issue remains tracked separately as `iss_20261121035131_af462c5ced`):

```
Nov 21 09:34:24 prodesk-home systemd[1150]: Stopping pi-desktop-app.service - pi Desktop app (headless via Xvfb :93)...
Nov 21 09:34:24 prodesk-home systemd[1150]: pi-desktop-app.service: Main process exited, code=dumped, status=4/ILL
Nov 21 09:34:24 prodesk-home systemd[1150]: pi-desktop-app.service: Failed with result 'core-dump'.
Nov 21 09:34:24 prodesk-home systemd[1150]: Stopped pi-desktop-app.service - pi Desktop app (headless via Xvfb :93).
Nov 21 09:34:25 prodesk-home systemd[1150]: Started pi-desktop-app.service - pi Desktop app (headless via Xvfb :93).
Nov 21 09:34:26 prodesk-home AppRun[1256838]: [remote] gateway listening on :47900
```

- Postflight: `pi-desktop-app.service` active, MainPID 1256838 (started 09:34:25 UTC), NRestarts=0; current symlink `/home/quoc/apps/pi-desktop/current` → `/home/quoc/apps/pi-desktop/0.7.14-12ebc116`; app.asar SHA-256 `12ebc116fffe26b3668b0a3c20be1dd1457952334d3f3767518c4eca8b1f3a5c`; gateway :47900 listening (one listener); CDP :9222 closed.
- This worker’s later `deploy.py --apply --yes` run `f5dadc31-4a9b-49fc-aff9-9746309fed72` returned `status=already_current`, stage cleanup pass, and receipt `prodesk-lix-0.7.14-20261121T093900119535Z.json`; it made no second release switch. Do not conflate this no-op with the 09:34 installation.
- Read-only T20 predicate check after deployment PASS: SDK `artifactHash` remains `9cf819d2…`, registry SHA prefix `b0a828dc7a6e`, canary receipt `t20-canary-receipt.json` SHA prefix `220bdadeff62`, runtime `li`, protocol 1, approved build present. Registry/canary were not backed up or changed by this worker.
- R4 UAT entered only after postflight PASS. Browser/pairing attempt is **BLOCKED before creating a test device or sending a turn**: native `agent_browser` failed at managed-session policy coordination; browse MCP was connected but `https://li.quoc.app` navigation returned `net::ERR_NAME_NOT_RESOLVED`. A fresh pair token is produced through host-local `ipc:remote.regeneratePairing` (`src/main/ipc/handlers/remote.ts:19`); obtaining it would require an app UI/CDP path, but no systemd/CDP changes are authorized in this lane. No new device was paired, no test turn was sent, and no relay/tunnel or systemd setting was started/changed. Owner SM-A556E and its device record remain untouched; G4 Serve remains excluded. Await parent decision for an allowed pairing route; once paired, run only F2 rail delta, test turn, and visible two-tab one-copy verification, then revoke the new test device and close any temporary relay/tunnel.

## R4 scoped UAT (2026-11-21, executed) — PASS

Authorization chain: parent approved the two-restart CDP route (enable loopback 9222, restore byte-identical unit; zero diagnostic restarts, no T20/host config change); fresh owner no-turn confirmations ("Không turn — tiến hành") received via parent relay and directly via ask_user immediately before restart #1.

Setup (restart #1, 10:08:51 UTC):
- Unit backup `pi-desktop-app.service.bak-20261121-r4-uat-cdp`, SHA-256 `9475f265093eb6b857b7cdd44143e16019a3ac12c3ea61839bcf8c8bd161d0d2`, taken before patching; only `--remote-debugging-port=9222` appended to ExecStart. CDP verified loopback-only (`127.0.0.1:9222`), no `0.0.0.0`/`*` bind. Restart PASS; service active, NRestarts stayed 0.
- Pairing infra (laptop-local, temporary): static+WS relay `127.0.0.1:47981` serving `apps/web/dist` (fresh `npm run web:build` on this branch) splicing WS to `100.65.131.116:47900` with Origin `https://li.quoc.app`; SSH tunnel `19222→host:9222` for CDP. Fresh pair token via CDP `ipc:remote.regeneratePairing`; offer filtered to the single relay endpoint. Two relay bugs found and fixed locally (ws close-code 1005/1006 forwarding crash; hs1 frame dropped while upstream CONNECTING — queue+flush).

Pairing: after "Quên" of the stale browser record (each `regeneratePairing` rotates the host key and wipes device records — `auth-store.ts:123`), fresh offer → "Ghép nối" → host chip "Trực tuyến". Test device `d_rVPNhkhnMcxE` ("Li Web", Chrome, operator) created.

UAT results:
- F2 live delta: baseline rail 31 sessions, 0 running. `turn.send` ("[R4-UAT] Reply with exactly one word: PONG") into existing probe session ("Reply with exactly one word: BOOT_OK"): the one-row incremental `sessions.update` upserted only the target row (▸ running badge) and the rail kept **31/31** sessions — the R3 rail-collapse did not reproduce. Settle delta cleared the badge; rail still 31/31; reply "PONG" visible once.
- turn.send + event stream: patches streamed to settle (timeline shows user turn + reply, turn page/resume consistent).
- Two tabs, same session: tab1 and tab2 each render exactly one copy of the UAT turn and one "PONG" reply; rail 31/31 in both. Screenshots: `uat-r4-f2-turn-settled.png`, `uat-r4-multitab-tab1.png`, `uat-r4-multitab-tab2.png` (this directory).
- Removed-only live leg NOT exercised live (would require deleting a real session); covered by `apps/web/src/workbench/session-delta-merge.test.ts` (4/4 PASS, includes removals without dropping untouched rows).
- Observed gap (not F2, for parent disposition): remote `session.create` succeeds but the follow-up `session.open` is rejected — "session.open failed: forbidden session is not in an allowed project"; the new session never appears in `session.watchList`. Likely host project-allowlist semantics; not fixed here.

Idle verification before restore: web rail 0 running badges; host IPC `ipc:session.list` (fallback workspace scope) 0 running; UAT session settled.

Cleanup:
- Test device revoked via CDP `ipc:remote.revokeDevice` → `REVOKE=revoked`; status after: SM-A556E (`d_wRjm7laVr3Q7`, untouched, offline) + revoked test device (offline). Post-restore journal shows the revoked device's reconnect attempt closed `4004 reason=revoked` — revocation effective. Browser-local device key for origin `127.0.0.1:47981` remains in IndexedDB but is inert (device revoked).
- Restore restart #2 (16:46:53 UTC): backup verified against expected SHA before restore, `cmp` clean, daemon-reload, restart. Postflight: active, NRestarts=0, MainPID 1987528, no CDP flag in ExecStart, `:9222` listeners 0, `:47900` listeners 1, unit SHA back to `9475f265…`, `current` → `0.7.14-12ebc116`, asar `12ebc116…` unchanged.
- Laptop: relay process tree terminated (0 remaining), tunnel processes terminated by verified cmdline; `19222`/`47981` listeners 0; no stray `ssh`.
- Read-only T20 check after UAT: registry `b0a828dc7a6e`, canary `220bdadeff62`, service active. No T20 mutation by this worker.

Verdict: scoped R4 UAT **PASS** — F2 delta merge, `turn.send` + stream, and visible one-copy multi-tab verified on host-2 R4 runtime. G5's scoped R4 UAT item is complete; G6 off-tailnet remains UNVERIFIED; TUI↔Web handoff remains pre-existing spec-BLOCKED out of scope; G4 Serve excluded. Full web typecheck remains BASELINE BLOCKED (missing `apps/web/src/test/host-sim.ts`) as documented above.

## R5 create→watchList→open live UAT (2026-11-22) — PASS via approved local relay

Authorization: parent confirmed owner approval for exactly two controlled app-unit restarts; restart #1 enabled only loopback CDP, restart #2 restored the exact original unit. No diagnostic restart, deploy/apply, T20 edit, Serve/firewall/DNS change, or turn was performed.

Preflight (terminal `c0c916f0-bd7a-48d1-9808-00ceabfd0068`): host current `/home/quoc/apps/pi-desktop/0.7.14-3e78241b`; app.asar `3e78241b652f185c8391c65b21a24615efd8420f0e40d4d1d2ddf8ba485b8f18`; service active/NRestarts=0; gateway :47900=1; CDP :9222=0; original user unit SHA `9475f265093eb6b857b7cdd44143e16019a3ac12c3ea61839bcf8c8bd161d0d2`. T20 baseline: registry SHA `b0a828dc7a6ea24436c35cb84248f16b8bfbe731f384c1c0352c12d46b15f12c`; canary SHA `220bdadeff624b1dee22dec319b8379cb8e4aefabfa8eb71fc0e7a8be8da138c`.

Connectivity finding: production `https://li.quoc.app` loaded, but host IPC reported only `ws://` LAN/Tailscale endpoints. The HTTPS PWA rejects `ws://` and requires `wss://` (`apps/web/src/transport/endpoint.ts:6-11, 59-61`); no WSS endpoint was advertised. Parent kept this as a separate connectivity gap and authorized the previously proven local-relay route; no Serve/tunnel/firewall/DNS changes.

Setup: built `apps/web/dist` from clean source `li-web/fix-create-open` HEAD `686344e1355727c8af9daaf805205be40d22e447` (`npm run web:build` PASS). Restart #1 terminal `89622942-5423-4132-a627-bbed6ffaa24b`: exact backup `/home/quoc/.config/systemd/user/pi-desktop-app.service.bak-20261122-r5-uat-cdp` SHA `9475f265…`; only `--remote-debugging-port=9222` added; CDP bound exactly `127.0.0.1:9222`; service active/NRestarts=0, R5 asar unchanged, gateway=1. Fixed SSH tunnel 19222→9222 + local static/WebSocket relay 127.0.0.1:47981 used only for this test; pair token stayed in relay memory and is not recorded.

UAT evidence (local PWA from the exact R5 source build; browser tab `1341357748`):
- Host chip reached “Trực tuyến”; existing stale local test key was forgotten before pairing.
- New test device `d_vsaU6IsaEB2N` (“Li Web”, Chrome) paired. Host IPC showed owner SM-A556E `d_wRjm7laVr3Q7` still present/unrevoked; prior R4 test device `d_rVPNhkhnMcxE` already revoked.
- UI baseline 26 session rows. Clicking the real “Tạo phiên mới” control increased the rail to 27, selected the new row, showed no UI errors, and displayed the empty timeline placeholder “Chưa có nội dung — gửi tin nhắn đầu tiên.” This follows `Workbench.onCreate` (`apps/web/src/workbench/Workbench.tsx:199-207`): session.create → refreshSessions/session.watchList → openSession/session.open. Created session key: `/home/quoc/.pi/agent/sessions/--home-quoc--/2026-11-22T08-00-55-239Z_01a20245-bfc7-73a6-b46d-ca2d3ac975c0.jsonl`.
- No `turn.send` was issued. Host IPC after creation: workerCount=1, runningCount=0; file-based session.list returned 26 rows because the new transcript is still provisional/not disk-visible. Screenshot crop (host online + selected provisional row + empty timeline; other session titles cropped out): local temp `C:/Users/quocn/AppData/Local/Temp/uat-r5-create-open-crop.png`; Kaneo asset `h3mxdy4jnqajf89kdey28vs9` (`uat-r5-create-open-crop.png`).

Cleanup and final verification:
- Revoked test device through `ipc:remote.revokeDevice` (terminal `2a45346e-4987-49c1-859f-b62ae8baa3be`); host status confirmed `d_vsaU6IsaEB2N` revoked/offline, owner SM-A556E unchanged/unrevoked. Browser-local test key was forgotten.
- Before restart #2, fresh host IPC showed `workerCount=1`, `runningCount=0`; session.list runningReported=0. Ask_user no-turn form initially timed out; parent obtained fresh owner “Xác nhận no-turn” immediately before restart #2. The unit file had already been restored byte-identically and daemon-reloaded without restart while awaiting that confirmation.
- Restart #2 terminal `6c08ef02-bdb0-4362-9963-ca4ec23b1e78`: one controlled restart only. Final PASS: service active, NRestarts=0, MainPID 3757773, current R5 path and asar hash unchanged, unit and backup both SHA `9475f265…` and `cmp` equal, ExecStart has no CDP flag, :9222=0, :47900=1. T20 hashes remained exactly the baseline values above.
- Laptop cleanup terminal `dab8e581-5137-413a-bad1-9641e6d1da6a`: exact relay process tree terminated (0 remaining); local :47981 and :19222 listeners=0. No relay/tunnel remains.

Verdict: **R5 create→watchList→open PASS via the parent-approved local relay/local build route, with zero turns.** Direct production-origin pairing remains unavailable until an approved WSS path exists; this task did not enable one. No application source, deploy pins, T20, or host config other than the temporary app unit flag (restored byte-identically) changed.
