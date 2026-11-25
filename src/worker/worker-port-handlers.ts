import type { WorkerIncomingMessage } from './worker-port-types.js'
import type { WorkerReply } from './worker-handler-types.js'
import * as Turn from './handlers/worker-handlers-turn.js'
import * as Session from './handlers/worker-handlers-session.js'
import * as Catalog from './handlers/worker-handlers-catalog.js'
import * as PiSettings from './handlers/worker-handlers-pi-settings.js'
import { handleSetCapabilities } from './worker-capabilities.js'
import { handleReloadModelRouters } from './worker-model-routers.js'
import { handleBrowserToolResponse } from './worker-browser-tools.js'
import { st } from './worker-runtime.js'

const SESSION_MUTATIONS_BLOCKED_DURING_DELETE = new Set([
  'prompt', 'abort', 'steer', 'followUp', 'clearQueue',
  'setModel', 'setThinkingLevel', 'setCapabilities',
  'newSession', 'loadSession', 'sessionRenameFile', 'sessionDeleteFile',
  'navigateTree', 'fork', 'clone', 'compact', 'runExtensionCommand',
  'extension-ui-response', 'extension-ui-cancel',
])

const dispatch: Record<string, (msg: WorkerIncomingMessage, reply: WorkerReply) => Promise<void>> = {
  'init': Turn.handleInit,
  'prompt': Turn.handlePrompt,
  'abort': Turn.handleAbort,
  'steer': Turn.handleSteer,
  'followUp': Turn.handleFollowup,
  'clearQueue': Turn.handleClearqueue,
  'ownerStatus': Turn.handleOwnerStatus,
  'extension-ui-response': Turn.handleExtensionUiResponse,
  'extension-ui-cancel': Turn.handleExtensionUiCancel,
  'dispose': Turn.handleDispose,
  'ping': Turn.handlePing,
  'setModel': Session.handleSetmodel,
  'setThinkingLevel': Session.handleSetthinkinglevel,
  'setCapabilities': handleSetCapabilities,
  'reloadModelRouters': handleReloadModelRouters,
  'browser-tool-response': handleBrowserToolResponse,
  'newSession': Session.handleNewsession,
  'listSessions': Session.handleListsessions,
  'loadSession': Session.handleLoadsession,
  'sessionRenameFile': Session.handleSessionrenamefile,
  'sessionDeleteFile': Session.handleSessiondeletefile,
  'getSessionTree': Session.handleGetsessiontree,
  'navigateTree': Session.handleNavigatetree,
  'fork': Session.handleFork,
  'clone': Session.handleClone,
  'getForkMessages': Session.handleGetforkmessages,
  'compact': Session.handleCompact,
  'runExtensionCommand': Session.handleRunextensioncommand,
  'getMessages': Session.handleGetmessages,
  'reloadModels': Catalog.handleReloadmodels,
  'getModels': Catalog.handleGetmodels,
  'getClassifierModels': Catalog.handleGetclassifiermodels,
  'getModelSettingsSnapshot': Catalog.handleGetmodelsettingssnapshot,
  'getCommands': Catalog.handleGetcommands,
  'getSessionContextPreview': Catalog.handleGetsessioncontextpreview,
  'getSkillsList': Catalog.handleGetskillslist,
  'applySkillOverrides': Catalog.handleApplyskilloverrides,
  'writeSkillDescription': Catalog.handleWriteskilldescription,
  'transferSkill': Catalog.handleTransferskill,
  'getPromptTemplatesList': Catalog.handleGetprompttemplateslist,
  'getContextPrompts': Catalog.handleGetcontextprompts,
  'reloadResources': Catalog.handleReloadresources,
  'refreshAdapters': Catalog.handleRefreshadapters,
  'getExtensionCapabilities': Catalog.handleGetextensioncapabilities,
  'getCommandCompletions': Catalog.handleGetcommandcompletions,
  'getState': Catalog.handleGetstate,
  'getPiSettings': PiSettings.handleGetpisettings,
  'setPiSettings': PiSettings.handleSetpisettings,
  'applyHttpConnectTimeout': PiSettings.handleApplyhttpconnecttimeout,
}

export async function handleWorkerPortMessage(
  msg: WorkerIncomingMessage,
  reply: WorkerReply,
): Promise<void> {
  try {
    const type = msg.type
    if (st.sessionDeleteInProgress && type && SESSION_MUTATIONS_BLOCKED_DURING_DELETE.has(type)) {
      reply({ type: 'error', error: 'SESSION_DELETE_IN_PROGRESS' })
      return
    }
    const handler = type ? dispatch[type] : undefined
    if (!handler) {
      reply({ type: 'error', error: `Unknown message type: ${String(type)}` })
      return
    }
    await handler(msg, reply)
  } catch (error) {
    reply({ type: 'error', error: String(error), stack: (error as Error)?.stack })
  }
}
