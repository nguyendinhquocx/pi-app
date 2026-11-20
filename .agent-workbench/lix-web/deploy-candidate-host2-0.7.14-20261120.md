# LiX host-2 candidate plan — 0.7.14 T1 — 2026-11-20

- Assignment: `peer_20261120043110_cc464ea2`; dependency satisfied by parent reply `msg_20261120053029_a8e50fb6c63e`.
- Phase: **DEPLOYED r3 `0.7.14-6a3a8547`** (AppImage `24087eb4…`, asar `6a3a8547…`) — option B packaging fix: +28 fork-pinned deps, copy-mode materialization incl pi-schema, audit gate + asar smoke in pipeline. Apply PASS, service active NRestarts=0, gateway up, T20 pinned `9cf819d2…`, rollback 0.7.13 retained. G5 UAT next.
- Target remains `prodesk-home`; G4 Serve 47900 is outside assignment.

## Candidate artifact

| Field | Evidence |
| --- | --- |
| Version | `0.7.14` (local host-2 build; no public GitHub release/tag) |
| pi-app source | HEAD `472e817d0d82bd5cf226b7dbe4dd782717541739` + local `package.json` version bump only; diff SHA-256 `08a29876accc9493974a659ee16342300145daed7c476b6b7cd9faaad7568795` |
| Build target | `node:22-trixie`, Docker image digest `sha256:c103d7b5aa3bf627c8b98db941d52556f04e0b5d9352b3d7b6391245d26620f8` |
| LiX AppImage | `D:/pcloud/workspace/archive/home-server-artifacts/lix-0.7.14/LiX-0.7.14-x86_64.AppImage`, SHA-256 `d09942da96e2cee4d95aa6000e75d476ae23509f5d3635a985a2789776354e3f` (r2 rebuild) |
| Embedded app.asar | SHA-256 `58eb28f5e1171c8f79fd8f49f19ab0125743b6527e1e1ff01513bac0c58479c8` → release suffix `0.7.14-58eb28f5` |
| SDK registry bootstrap | pi-app `package.json` stays `1.0.2` for `npm ci` lock compatibility; postinstall `link-local-sdk.mjs` replaces it with local fork before Electron packaging (parent confirms this is intended) |
| SDK actually packaged | `@earendil-works/pi-coding-agent` 1.5.2, `li/stable` source `cb84283857c82eec932302904eb0bf94770038bd`, build artifact hash `9cf819d21aad027d1af3619b02ef5fe608869bdf9c7547e9671c6b9bf2137ccd` (embedded receipt: gitDirty false) |
| T1 + hardening proof in app.asar | `PI_SESSION_OWNER_CLAIM` ×28, `SessionOpenWriterConflictError` ×6 (cb84283857), custom_message ingress markers ×2 (1adea51d8e); embedded SDK receipt pins `9cf819d2…` |
| Rebuild note (r2) | R1 artifact (AppImage `60a46019…`, asar `7d6d635f…`, SDK `0fe3c21764`/`948ab9e3…`) superseded per parent decision `msg_20261120123426_848bf36e58e6`: vulnerable `content: msg.content ?? []` normalization in `0fe3c21764` corrupted real laptop sessions; r2 = same Docker trixie pipeline + pi-app HEAD, SDK `cb84283857`. R1 files archived `superseded-r1/` |
| Local release lock | `D:/pcloud/workspace/code/python/app_presets/home_server/pi-desktop-remote/release-lock.json`, pins exact asset, asar, target and source; local deployment preset tests pass |

## Build + deployment-prep verification

- `docker build`/electron packaging script exit 0; r2 build log: `D:/pcloud/workspace/archive/home-server-artifacts/lix-0.7.14-build-r2/out/build.log` (terminal run `96f27b5c-8d4a-4811-820c-d39475c5183c`).
- Fixed deployment wrapper tests: `test_deploy_wrapper.py` **14/14 PASS**.
- Installer fixture tests: `test_install_fixture.py` **5/5 PASS** (tests direct versioned dirs under app root, rollback 0.7.12 retained).
- `bash -n install-prodesk-lix.sh` PASS.
- `py -3.13 deploy.py --plan` PASS, read-only remote preflight:
  - current host: `0.7.13-9c8f2650`, live app.asar `9c8f2650fe4f9bab5cf824d3db2dc1a47eca1b903a2113c53435ddd6814b5ec9`, gateway `47900`.
  - planned new release: `0.7.14-58eb28f5`; mutation = stage verified artifact, stop only user unit `pi-desktop-app.service`, add versioned dir directly under `/home/quoc/apps/pi-desktop`, atomically switch `current`, retain old release. Fixed installer uses `systemctl --user`; no sudo/firewall/DNS/Serve changes.
  - rollback ID printed by prior preflight = `0.7.12` (confirmed dir + `resources/app.asar` + AppImage in G3 prep).

## G3 human gates — owner answered; source is this worker's ask_user result

1. **ufw 47900:** parent provided direct owner-pasted output (`msg_20261120072026_bacc835c062d`): `Status: active`; `[8] 47900/tcp on tailscale0 ALLOW IN Anywhere`; `[13] 47900/tcp (v6) on tailscale0 ALLOW IN Anywhere (v6)`. No firewall change.
2. **Active turns:** owner answered `Xác nhận không turn` via parent ask_user; parent confirmed this is direct owner evidence in `msg_20261120072026_bacc835c062d`. No service stop has occurred.
3. **Rollback:** 0.7.12 dir + app.asar + AppImage are present.

## Approved path B: host-local snapshot/T20 immediately before atomic apply

Parent decision `msg_20261120071156_81c2001b5e32`: keep tested atomic installer; create/verify ProDesk `.pi` snapshot locally, backup host-local `registry.json` + T20 canary, update T20 using candidate's packaged SDK receipt/artifact hash and ProDesk launcher path, then run fixed atomic `--apply` immediately, with no turns admitted in between. Do not copy laptop registry/canary.

**ProDesk-local profile snapshot completed, T20/deploy still pending.** Snapshot ID `prodesk-lix-host2-pre-0.7.14-20261120T072256Z`; 9,686 regular files, 10 symlinks, 1 socket skipped, archive 45,590,306 bytes. Independent count+SHA+tar-readability verification PASS; archive hash/content stay on ProDesk and were not copied. Host registry/canary backups and T20 mutation have not happened; no service stop/`--apply` yet. If `--apply` fails or auto-rolls back to 0.7.13, immediately restore BOTH host T20 files from their backups before old app is allowed to accept work. If candidate receipt/path differs or `checkPromotionGate` fails, stop and report BLOCKED. G4 Serve 47900 remains separate.

Next path B: inspect/backup host-local registry+canary → reapprove candidate artifact/hash + ProDesk launcher path, verify `checkPromotionGate` → atomic `deploy.py --apply --yes` immediately with no turns admitted → service/gateway/asar verify → UAT G5 matrix spec :302-314. Parent direct G3 evidence `msg_20261120072026_bacc835c062d` satisfies the owner gates; no further owner confirmation requested.

## Evidence references

- G3 pre-deploy checklist: `.agent-workbench/lix-web/prep-deploy-g3-20261120.md`
- Host-2 receipt: `.agent-workbench/lix-web/receipt-host2-20261120.md`
- Build receipt: `D:/pcloud/workspace/archive/home-server-artifacts/lix-0.7.14/build-receipt.json`
- LiX deployment plan: `py -3.13 deploy.py --plan` output (run 2026-11-20, read-only).
