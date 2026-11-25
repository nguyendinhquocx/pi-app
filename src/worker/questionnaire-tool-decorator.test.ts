import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCatalog } from '../extension-compat/adapter-schema'
import { installAdapterCatalog, invalidateAdapterCatalog } from '../extension-compat/adapter-loader'
import type { EventBus, Extension, LoadExtensionsResult, RegisteredTool } from '@earendil-works/pi-coding-agent'
import { createDesktopUIBridge, type ExtensionUIRequest } from './desktop-ui-bridge'
import { decorateQuestionnaireTools } from './questionnaire-tool-decorator'

const projectDir = 'C:/test/pi-ask'
const extensionPath = 'C:\\Users\\test\\.pi\\agent\\extensions\\pi-ask\\index.ts'
const questions = [
  { question: 'Database?', header: 'Data', multiSelect: false, options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
  { question: 'Features?', header: 'Build', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }] },
  { question: 'Anything else?', header: 'Notes', multiSelect: false, options: [{ label: 'No' }, { label: 'Yes' }] },
]

function installPiAskAdapter(): void {
  const catalog: AdapterCatalog = {
    adapters: [{
      id: 'pi-ask-ask-user',
      displayName: 'Ask User',
      match: { names: ['pi-ask', 'c:/users/test/.pi/agent/extensions/pi-ask/index.ts'], tools: ['ask_user'] },
      tier: 'native',
      interact: {
        trigger: { tool: 'ask_user' },
        schema: 'questions',
        fields: { questions: '$.questions' },
      },
    }],
    errors: [],
    sources: { 'pi-ask-ask-user': 'override' },
    scope: projectDir,
  }
  installAdapterCatalog(projectDir, catalog)
}

function createExtension(execute: RegisteredTool['definition']['execute']): Extension {
  const tool = {
    definition: { name: 'ask_user', execute },
  } as unknown as RegisteredTool
  return {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: { source: extensionPath },
    tools: new Map([['ask_user', tool]]),
  } as unknown as Extension
}

function createDecoratedTool(execute: RegisteredTool['definition']['execute']) {
  installPiAskAdapter()
  const result = decorateQuestionnaireTools(
    { extensions: [createExtension(execute)] } as unknown as LoadExtensionsResult,
    projectDir,
  )
  const tool = result.extensions[0]?.tools.get('ask_user')
  if (!tool) throw new Error('ask_user was not decorated')
  return tool
}

function createBridge(requests: ExtensionUIRequest[]) {
  const eventBus = { on: () => () => undefined } as unknown as EventBus
  return createDesktopUIBridge(eventBus, (request) => requests.push(request))
}

afterEach(() => {
  invalidateAdapterCatalog()
})

describe('pi-ask remote questionnaire adapter', () => {
  it('maps web answers back to pi-ask result shape without invoking the desktop TUI factory', async () => {
    const requests: ExtensionUIRequest[] = []
    const bridge = createBridge(requests)
    const execute = vi.fn(async (...args: unknown[]) => {
      const context = args[4] as { ui: { custom: (factory: unknown) => Promise<unknown> } }
      const result = await context.ui.custom(() => {
        throw new Error('desktop TUI factory must not run in the Web adapter')
      })
      return { content: [], details: result }
    })
    const tool = createDecoratedTool(execute as RegisteredTool['definition']['execute'])

    const pending = tool.definition.execute(
      'tool-call-1',
      { questions },
      new AbortController().signal,
      undefined,
      { ui: bridge.uiContext } as never,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'custom', kind: 'ask_user_question', questions, toolCallId: 'tool-call-1' })
    bridge.handleExtensionUIResponse({
      id: requests[0]!.id,
      result: {
        cancelled: false,
        answers: [
          { questionIndex: 0, question: 'Database?', kind: 'option', answer: 'Postgres' },
          { questionIndex: 1, question: 'Features?', kind: 'multi', answer: null, selected: ['Auth', 'Search'] },
          { questionIndex: 2, question: 'Anything else?', kind: 'custom', answer: 'Later' },
        ],
      },
    })

    await expect(pending).resolves.toMatchObject({
      details: {
        questions,
        answers: { 'Database?': 'Postgres', 'Features?': 'Auth, Search', 'Anything else?': 'Later' },
        notes: {},
        cancelled: false,
      },
    })
    expect(execute).toHaveBeenCalledOnce()
    bridge.dispose()
  })

  it('returns a cancelled pi-ask result when the remote questionnaire is dismissed', async () => {
    const requests: ExtensionUIRequest[] = []
    const bridge = createBridge(requests)
    const execute = vi.fn(async (...args: unknown[]) => {
      const context = args[4] as { ui: { custom: (factory: unknown) => Promise<unknown> } }
      return { content: [], details: await context.ui.custom(() => ({})) }
    })
    const tool = createDecoratedTool(execute as RegisteredTool['definition']['execute'])

    const pending = tool.definition.execute(
      'tool-call-cancel',
      { questions },
      new AbortController().signal,
      undefined,
      { ui: bridge.uiContext } as never,
    )

    bridge.handleExtensionUIResponse({ id: requests[0]!.id, cancelled: true })

    await expect(pending).resolves.toMatchObject({
      details: { questions, answers: {}, notes: {}, cancelled: true },
    })
    bridge.dispose()
  })

  it('fails closed when the remote response envelope is malformed', async () => {
    const requests: ExtensionUIRequest[] = []
    const bridge = createBridge(requests)
    const execute = vi.fn(async (...args: unknown[]) => {
      const context = args[4] as { ui: { custom: (factory: unknown) => Promise<unknown> } }
      return { content: [], details: await context.ui.custom(() => ({})) }
    })
    const tool = createDecoratedTool(execute as RegisteredTool['definition']['execute'])

    const pending = tool.definition.execute(
      'tool-call-invalid',
      { questions },
      new AbortController().signal,
      undefined,
      { ui: bridge.uiContext } as never,
    )

    bridge.handleExtensionUIResponse({ id: requests[0]!.id, result: { cancelled: false, answers: null } })

    await expect(pending).resolves.toMatchObject({
      details: { questions, answers: {}, notes: {}, cancelled: true },
    })
    bridge.dispose()
  })
})
