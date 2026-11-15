import type { AppEvent } from '@shared/app-events'

export type CompletionNotificationEventSink = {
  observeAppEvent: (event: AppEvent) => void
  observeWorkerExit: (slot: { cwd: string; sessionFile?: string | null }) => void
  visibleSessionChanged: (sessionFile: string | null) => void
  foregroundChanged: () => void
}

let sink: CompletionNotificationEventSink | null = null
let visibleSessionFile: string | null = null
/** Whether synthesized external completions should be produced at all (config `alertOnExternalSessions`). */
let externalAlertsEnabled: () => boolean = () => true

export function bindCompletionNotificationEvents(next: CompletionNotificationEventSink): () => void {
  sink = next
  next.visibleSessionChanged(visibleSessionFile)
  return () => {
    if (sink === next) sink = null
  }
}

export function currentVisibleSessionFile(): string | null {
  return visibleSessionFile
}

export function setVisibleSessionFile(sessionFile: string | null): void {
  visibleSessionFile = sessionFile
  sink?.visibleSessionChanged(sessionFile)
}

export function notifyForegroundChanged(): void {
  sink?.foregroundChanged()
}

export function observeAppEventForCompletion(event: AppEvent): void {
  sink?.observeAppEvent(event)
}

/** Main binds this to the config store; the remote module stays electron-free. */
export function setExternalCompletionAlertProvider(provider: () => boolean): void {
  externalAlertsEnabled = provider
}

export function externalCompletionAlertsEnabled(): boolean {
  return !!externalAlertsEnabled()
}

export function observeWorkerExitForCompletion(slot: {
  cwd: string
  sessionFile?: string | null
}): void {
  sink?.observeWorkerExit(slot)
}
