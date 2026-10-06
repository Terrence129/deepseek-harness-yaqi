/**
 * Keyless adapter for the Lifebase tool round trip.
 *
 * Turn 1 asks for two independent queries; turn 2 takes an evidence id out of
 * turn 1's own result text and looks it up; turn 3 closes with a marker the
 * test asserts on. Feeding a real result field back as the next call's argument
 * is the point: it fails if the envelope ever stops reaching the model intact.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

const SEARCH_CALL = ToolCallId('lifebase-search-call')
const CONTEXT_CALL = ToolCallId('lifebase-context-call')
const EVIDENCE_CALL = ToolCallId('lifebase-evidence-call')

/** Topic spelled in the synthetic demo library; the archive is queried for it. */
const TOPIC = '野餐'
/** Marker the test asserts on to prove the final answer carried the tool result through. */
export const REPLY_MARKER = 'LIFEBASE_TOOL_REPLY'

/**
 * `chain` (default) runs the three-call sequence above. `single` asks one
 * `lifebase_context` and answers, which is all a failure or destination case
 * needs: a chain would abort on the missing record_id a failed first call
 * leaves behind and hide the failure this is meant to show.
 */
const SCENARIO = process.env['LIFEBASE_MOCK_SCENARIO'] ?? 'chain'

/** Read one captured group out of the previous tool-result text. */
function capture(text: string, pattern: RegExp, label: string): string {
  const found = pattern.exec(text)
  if (found === null || found[1] === undefined) {
    throw new Error(`lifebase mock: no ${label} in the previous tool result`)
  }
  return found[1]
}

/** Concatenated text of one tool message. */
function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Keyless headless-agent adapter: query, follow the evidence, then answer. */
class LifebaseMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }

    const toolTexts = options.messages.filter(message => message.role === 'tool').map(textOf)

    if (toolTexts.length === 0) {
      if (SCENARIO === 'single') {
        const context = JSON.stringify({ question: `我在两个平台讨论过${TOPIC}的哪些安排？`, limit: 3 })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: CONTEXT_CALL, name: 'lifebase_context', argumentsDelta: context }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CONTEXT_CALL, name: 'lifebase_context', arguments: context } }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const search = JSON.stringify({ text: TOPIC, limit: 3 })
      const context = JSON.stringify({ question: `我在两个平台讨论过${TOPIC}的哪些安排？`, limit: 3 })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: SEARCH_CALL, name: 'lifebase_search', argumentsDelta: search }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: SEARCH_CALL, name: 'lifebase_search', arguments: search } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: CONTEXT_CALL, name: 'lifebase_context', argumentsDelta: context }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: CONTEXT_CALL, name: 'lifebase_context', arguments: context } }
      yield { type: 'usage', usage: { inputTokens: 21, outputTokens: 9, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    if (SCENARIO === 'single') {
      // One call already happened, successful or not; answer either way, so a
      // failed tool result stays observable instead of ending the turn.
      const reply = `${REPLY_MARKER} single`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (toolTexts.length === 2) {
      const evidenceId = capture(toolTexts.join('\n'), /"evidence_id":\s*"([^"]+)"/, 'evidence id')
      const args = JSON.stringify({ evidence_id: evidenceId })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: EVIDENCE_CALL, name: 'lifebase_evidence', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: EVIDENCE_CALL, name: 'lifebase_evidence', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 31, outputTokens: 6, cacheReadTokens: 9 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const recordId = capture(toolTexts.join('\n'), /"record_id":\s*"([^"]+)"/, 'record id')
    const reply = `${REPLY_MARKER} ${recordId}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 7, reasoningTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'lifebase-mock-llm'
export const inject = ['llm']

/** Register the keyless `lifebase-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['lifebase-mock'], new LifebaseMockAdapter())
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
