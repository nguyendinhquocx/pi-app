# Receipt: Li Web host-2 (ProDesk) — 2026-11-20

## Current verdict: DEPLOYED 0.7.14-6a3a8547 (r3) — service active, gateway up, T20 pinned; G5 UAT next

G1+G2 owner assignment `peer_20261120043110_cc464ea2` is active; parent upstream dependency is satisfied (`msg_20261120053029_a8e50fb6c63e`). LiX 0.7.14 r2 candidate (SDK `cb84283857`) was staged and switched but the app crashed at boot (missing `chalk` in asar); auto-rollback completed and the host was manually recovered to `0.7.13-9c8f2650` with T20 restored from backups. **Host is stable on 0.7.13; no 0.7.14 deployment exists; UAT not started.** Serve 47900 (G4) is explicitly outside scope.


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
