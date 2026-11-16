---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-16-android-completion-notifications"
status: "archived"
title: "LiX Android completion notifications — outcome proof and catch-up"
archived_at: "2026-11-16T15:32:47+07:00"
source_file: "SPEC-2026-11-16-android-completion-notifications.md"
source_sha256: "c2ae934b3d1aad6312930d0b05d331c2d850b5f1cf48f7c5be00edf70a72b2a3"
implementation_ref: "3ec2efd1bb2b200fb6e27de5222ccac6ecfdd09a"
working_tree: "dirty"
related_paths: ["src/main/remote/session-hub.ts", "packages/shared/remote/timeline.ts", "apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/RemoteRepository.kt", "apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/SessionNotifyGate.kt", "apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/BackstopKeepAliveGate.kt", "apps/mobile/androidApp/src/main/kotlin/dev/pi/remote/app/data/RunNotifier.kt"]
---

# Spec: LiX Android completion notifications — outcome proof and catch-up

> `spec_id`: SPEC-2026-11-16-android-completion-notifications
> `status`: working
> `supersedes`: notification semantics only in SPEC-2026-11-14-external-session-live-sync; all other live-sync decisions remain unchanged
> `owner_decision`: 2026-11-16 — keep additive, backward-compatible outcome metadata and update the spec/receipt

## Context Snapshot

- Project: LiX (`D:/pcloud/workspace/code/android/pi-app/pi-app`), Electron/TypeScript desktop host + Kotlin/Compose Android client.
- Baseline: public release v0.7.12. Current work includes a local optional `settledOutcome` summary field to tell a real turn completion from the host's 90s file-silence backstop.
- Observed bug: laptop desktop notification fires when an external/TUI turn finishes, but Android can miss it; the backstop can also mark a long terminal command idle before it finishes.
- Existing behavior: Android inbox listens to `sessions.update`; completion preference defaults on, while `needsInput` questions should notify regardless of that toggle. Background connectivity uses a foreground KeepAliveService.
- Relevant files: `src/main/remote/session-hub.ts`, `packages/shared/remote/timeline.ts`, Android `Timeline.kt`, `SessionNotifyGate.kt`, `RemoteRepository.kt`, `BackstopKeepAliveGate.kt`, `RunNotifier.kt`.
- Constraint amendment: owner explicitly approved optional additive completion metadata. No new patch op, RPC, endpoint, or reverse refresh into Li TUI. Older phones ignore unknown fields; new phones treat missing fields as null.

## Objective

Android must not announce “done” just because the host's 90s inactivity heuristic flips a session idle. It must notify on a real terminal outcome, including a long command that finishes after that flip, and not lose a recent completion merely because the phone reconnects after a long-running turn.

## Scope

- Add optional `settledOutcome` (`success | failed | cancelled`) and `settledAt` (host timestamp identity) to `SessionSummary`; expose them only while fresh, for at most 120s. `settledAt` lets Android dedupe a repeated row/title refresh without confusing two successful turns.
- Clear the previous outcome when a new slot or external turn starts; external metadata refreshes must not refresh an old completion's freshness.
- Android completion gate uses the outcome timestamp as stable identity, excludes `needsInput`, and keeps the completion toggle independent from question notifications.
- Reconnect catch-up trusts fresh `settledOutcome + settledAt` proof, not `updatedAt` delta (which includes the entire run duration and drops long tasks).
- Surface external failures/cancellations accurately in inbox notifications and keep the session inbox status consistent with failed outcomes.
- If a background session becomes idle without outcome (backstop), retain KeepAlive for a bounded 120s grace; real outcome/question/new run ends the grace early. If the process stays closed or the grace expires, no server push is promised.

## Out of scope

- New RPC, patch operation, or change to epoch/cursor semantics.
- Push delivery after Android's process is killed or after the 120s host outcome/catch-up window.
- Changing the 90s external-running heuristic itself.
- Public version bump, commit, push, or release as part of this local repair.

## Technical approach

- Host is authoritative for terminal evidence: only an assistant terminal tail or slot `turn.settle` produces outcome metadata; status-only backstop flips never do.
- `settledAt` distinguishes a new completion from replayed summaries or title/row refreshes. Android compares cached vs fresh host timestamps, avoiding phone/host clock skew.
- A `needsInput` summary never carries completion outcome; the gate also excludes that status defensively. Completion-toggle OFF never suppresses a question.
- Outcome freshness is exactly 120s, matching Android reconnect catch-up. Completion duration itself is not the catch-up age.
- KeepAlive grace is keyed per session and begins only on `running → idle` with no outcome. It expires after 120s and is removed early by a real outcome, question, or new run.

## Acceptance and verification

1. A long terminal command crosses the 90s host backstop: Android receives no mid-turn completion notification.
2. If that command finishes during the 120s grace, Android receives a completion notification while backgrounded; a phone reconnect within 120s after completion catches it up.
3. A run longer than 120s is not dropped solely because `updatedAt - cached.updatedAt` reflects run duration.
4. A new turn starting within the previous outcome freshness window cannot reuse the old outcome after a crash/backstop.
5. A pending `needsInput` question notifies even when completion notifications are toggled off; `settledOutcome` never classifies a question as completion.
6. External `failed` and `cancelled` outcomes display their actual outcome, not “Finished”.
7. Old Android clients tolerate the optional fields; new Android clients tolerate old hosts by defaulting both fields to null.
8. Unit/integration gates pass: targeted SessionHub + gateway tests, full Vitest, typecheck, Android unit/shared tests, release assemble. CRLF-aware `git diff --check` passes.
9. Owner UAT on A55: no alert during long command; alert on actual completion; question still alerts with completion toggle off; failure alert is labeled correctly.

## Ordered tasks

- T1: Host outcome identity/freshness, stale-outcome clearing, failed status/preview, integration tests.
- T2: Android gate/catch-up semantics, question-toggle precedence, failure/cancelled notification copy, gate tests.
- T3: Bounded backstop KeepAlive grace and deterministic tests.
- T4: Run verification, build/install local desktop + Android, owner UAT; archive this amendment and update generated specs index/receipt only after PASS.

## Review brief

Review the interaction among `SessionHub` outcome generation, strict `SessionSummary` schema, Android reconnect catch-up, dedupe identity, `needsInput`, failed/cancelled labels, and the 120s background grace. Focus on stale outcomes across turns and on ensuring a backstop flip never becomes a completion. Do not broaden into unrelated UI or repo cleanup.
