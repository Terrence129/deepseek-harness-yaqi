/**
 * Lifebase tool-dispatch evidence from the real Agent over the shipped headless profile.
 *
 * The zero-build plugin is not a workspace package, so this asserts the round
 * trip rather than module identity: what the model asked for, what each call
 * returned, and whether the turn closed cleanly.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** One completed tool call, flattened for assertions. */
export interface LifebaseToolCall {
  name: string
  /** Raw argument JSON exactly as the model produced it. */
  arguments: string
}

/** One tool result, flattened for assertions. */
export interface LifebaseToolResult {
  callId: string
  isError: boolean
  /** Failure identity when the tool threw. */
  errorCode?: string
  /** Rendered text the model received. */
  text: string
}

/** Observations from one isolated Agent driven by the mock Lifebase adapter. */
export interface LifebaseToolEvidence {
  errors: string[]
  calls: LifebaseToolCall[]
  results: LifebaseToolResult[]
  /** One entry per `turn/end`, in order. */
  endReasons: unknown[]
  /** Text of the last assembled assistant message. */
  finalText: string
}

/** Services needed to drive the Agent. */
export const inject = ['agents']

/** Concatenated text blocks of one message. */
function textOf(message: { content: readonly { type: string; text?: string | undefined }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * Drive one mock-model turn after application readiness and dispose it before requesting exit.
 * @param ctx - context in the source-launched headless Loader tree.
 * @param config - isolated working directory for the Agent.
 */
export function apply(ctx: Context, config: { cwd: string }): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('Lifebase tool driver requires appReady and appExit')
  const calls: LifebaseToolCall[] = []
  const results: LifebaseToolResult[] = []
  const endReasons: unknown[] = []
  const errors: string[] = []
  let finalText = ''
  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type === 'tool/call') {
      calls.push({ name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'tool/result') {
      results.push({
        callId: String(event.data.message.toolCallId),
        isError: event.data.message.isError === true,
        ...event.data.error === undefined ? {} : { errorCode: event.data.error.code },
        text: textOf(event.data.message),
      })
    } else if (event.type === 'turn/end') {
      endReasons.push(event.data.reason)
    } else if (event.type === 'assistant/message') {
      finalText = textOf(event.data.message)
    }
  }, { global: true })
  ctx.on('agent/error', ({ error }) => { errors.push(error instanceof Error ? error.message : String(error)) }, { global: true })

  const run = async (): Promise<void> => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: { cwd: config.cwd },
      agentOptions: { provider: 'lifebase-mock', model: 'lifebase-mock' },
    })
    try {
      handle.agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '用 lifebase 工具查一下：野餐有哪些讨论？并给出证据引用。' }],
      }))
      await handle.agent.whenIdle()
      const evidence: LifebaseToolEvidence = { errors, calls, results, endReasons, finalText }
      process.stdout.write(`DSH_LIFEBASE_TOOL_RESULT ${JSON.stringify(evidence)}\n`)
    } finally {
      await handle.dispose()
    }
    exit(errors.length === 0 ? 0 : 1)
  }

  ctx.effect(() => ready.onReady(() => {
    void run().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      exit(1)
    })
  }), 'lifebase tool driver')
}
