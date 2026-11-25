import type {
  Extension,
  ExtensionContext,
  ExtensionUIContext,
  LoadExtensionsResult,
  RegisteredTool,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { resolveV2ByPluginName } from '../extension-compat/adapter-loader.js'
import {
  getDesktopUIBridge,
  type ExtensionUIQuestion,
  type ExtensionUIQuestionnaireResult,
} from './desktop-ui-bridge.js'
import { createQuestionnaireRpcUI } from './questionnaire-rpc-ui.js'

type MatchedQuestionTool = { toolName: string; adapterId: string }

function matchedQuestionTool(extension: Extension, cwd: string): MatchedQuestionTool | null {
  const candidates = [extension.sourceInfo?.source, extension.path, extension.resolvedPath].filter(
    (candidate): candidate is string => !!candidate,
  )
  for (const candidate of candidates) {
    const adapter = resolveV2ByPluginName(candidate, candidate, cwd)
    const interact = adapter?.interact
    const toolName = interact?.trigger?.tool
    if (interact?.schema === 'questions' && toolName && extension.tools.has(toolName) && adapter) {
      return { toolName, adapterId: adapter.id }
    }
  }
  return null
}

function toPiAskResult(
  questions: ExtensionUIQuestion[],
  questionnaire: ExtensionUIQuestionnaireResult | null,
): { questions: ExtensionUIQuestion[]; answers: Record<string, string>; notes: Record<string, string>; cancelled: boolean } {
  const answers: Record<string, string> = {}
  if (
    !questionnaire ||
    typeof questionnaire !== 'object' ||
    typeof questionnaire.cancelled !== 'boolean' ||
    !Array.isArray(questionnaire.answers)
  ) {
    return { questions, answers, notes: {}, cancelled: true }
  }
  if (questionnaire.cancelled) return { questions, answers, notes: {}, cancelled: true }

  for (const [questionIndex, question] of questions.entries()) {
    const answer = questionnaire.answers.find((item) => item && item.questionIndex === questionIndex)
    if (!answer) continue
    if (answer.kind === 'multi') {
      const selected = new Set(Array.isArray(answer.selected) ? answer.selected.filter((label): label is string => typeof label === 'string') : [])
      const labels = question.options.map((option) => option.label).filter((label) => selected.has(label))
      if (labels.length > 0) answers[question.question] = labels.join(', ')
      continue
    }
    if (answer.kind === 'option') {
      if (typeof answer.answer === 'string' && question.options.some((option) => option.label === answer.answer)) {
        answers[question.question] = answer.answer
      }
      continue
    }
    if (answer.kind === 'custom' && typeof answer.answer === 'string' && answer.answer.length > 0) {
      answers[question.question] = answer.answer
    }
  }

  // The Web questionnaire has no note/image controls yet; keep the pi-ask result schema valid.
  return { questions, answers, notes: {}, cancelled: false }
}

function createPiAskRemoteUI(
  base: ExtensionUIContext,
  toolCallId: string,
  questions: ExtensionUIQuestion[],
  signal: AbortSignal | undefined,
  request: (id: string, rows: ExtensionUIQuestion[], abortSignal?: AbortSignal) => Promise<ExtensionUIQuestionnaireResult>,
): ExtensionUIContext {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'custom') {
        return async <T>(_factory: unknown, _options?: unknown): Promise<T> => {
          const result = await request(toolCallId, questions, signal)
          return toPiAskResult(questions, result) as T
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

const PI_ASK_ADAPTER_ID = 'pi-ask-ask-user'

function decorateTool(registered: RegisteredTool, adapterId: string): RegisteredTool {
  const definition = registered.definition as ToolDefinition
  const execute = definition.execute.bind(definition)
  return {
    ...registered,
    definition: {
      ...definition,
      executionMode: 'sequential',
      async execute(toolCallId, params, signal, onUpdate, context) {
        const bridge = getDesktopUIBridge(context.ui)
        if (!bridge) return execute(toolCallId, params, signal, onUpdate, context)
        const questions = (params as { questions?: ExtensionUIQuestion[] }).questions || []
        const request = (id: string, rows: ExtensionUIQuestion[], abortSignal?: AbortSignal) =>
          bridge.requestQuestionnaire(id, rows, abortSignal)
        const ui = adapterId === PI_ASK_ADAPTER_ID
          ? createPiAskRemoteUI(context.ui, toolCallId, questions, signal, request)
          : createQuestionnaireRpcUI(context.ui, toolCallId, questions, signal, request)
        return execute(toolCallId, params, signal, onUpdate, {
          ...context,
          ui,
        } as typeof context)
      },
    },
  }
}

export function decorateQuestionnaireTools(
  result: LoadExtensionsResult,
  cwd: string,
): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.map((extension) => {
      const matchedTool = matchedQuestionTool(extension, cwd)
      if (!matchedTool) return extension
      const registered = extension.tools.get(matchedTool.toolName)
      if (!registered) return extension
      const tools = new Map(extension.tools)
      tools.set(matchedTool.toolName, decorateTool(registered, matchedTool.adapterId))
      return { ...extension, tools }
    }),
  }
}
