/**
 * The zero-build Lifebase plugin over the shipped headless profile.
 *
 * This is a pipeline check, not a model check: a keyless adapter asks for the
 * calls, and the assertions cover the argv each call reaches the archive with,
 * the exit-code mapping, and whether the envelope arrives at the model intact.
 * The plugin needs a real archive and a local executable, so the suites
 * self-skip without them; the paths stay in the environment rather than in the
 * repository.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { REPLY_MARKER } from '../../../fixtures/lifebase-mock-llm.ts'
import type { LifebaseToolEvidence, LifebaseToolResult } from '../../../fixtures/lifebase-tool-driver.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const lifebaseToolTimeoutMs = 120_000

/**
 * The Harness prunes a tool result past this many characters (head 4096, tail
 * 1024). An envelope at or above it would reach the model cut in half, so the
 * round trip asserts its size as well as its contents.
 */
const PRUNER_THRESHOLD_CHARS = 8192

/** A local executable and a built archive; absent on CI and on hosts without Lifebase. */
const lifebaseExe = process.env['LIFEBASE_EXE'] ?? ''
const lifebaseDataDir = process.env['LIFEBASE_DEMO_DIR'] ?? ''

/** One evidence locator as the archive publishes it. */
interface EvidenceLocator {
  evidence_id: string
}

/** One matched message as the archive publishes it. */
interface MessageMatch {
  record_id: string
  revision_id: string
  conversation_id: string
  source: string
  role: string
  excerpt: string
  evidence: EvidenceLocator[]
}

/** The published v1 envelope, narrowed to the fields these assertions read. */
interface Envelope {
  api_version: number
  tool: string
  status: string
  snapshot_id: string
  data: {
    query?: string
    question?: string
    destination?: string
    generated_answer?: string | null
    content_chars?: number
    matches?: MessageMatch[]
    evidence?: EvidenceLocator
  }
  warnings: unknown[]
  error?: { code: string; message: string }
}

/** One isolated profile run and the evidence it printed. */
interface BootOptions {
  dataDir: string
  destination: string
  scenario: 'chain' | 'single'
}

/** Parse one tool result as an envelope, failing loudly if a layer rewrote it. */
function envelopeOf(result: LifebaseToolResult): Envelope {
  return JSON.parse(result.text) as Envelope
}

/**
 * Boot the headless profile with the plugin patched in, drive one mock turn in
 * a disposable home, and return what the session observed.
 *
 * The process-level assertions are the same for every case, so they live here:
 * a timeout, a signal, or a non-zero exit would otherwise show up as a
 * confusing assertion about an empty evidence array.
 */
async function boot(options: BootOptions): Promise<LifebaseToolEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifebase-tool-'))
  try {
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const patch = join(root, 'lifebase-tool.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'headless-startup', disabled: true },
      { id: 'headless-runner', disabled: true },
      { id: 'llm-deepseek', disabled: true },
      { id: 'agent-default-model', config: { provider: 'lifebase-mock', model: 'lifebase-mock' } },
      { insert: [
        {
          id: 'lifebase-mock-llm',
          name: join(repoRoot, 'apps/cli/tests/fixtures/lifebase-mock-llm.ts'),
        },
        {
          id: 'lifebase-tool-driver',
          name: join(repoRoot, 'apps/cli/tests/fixtures/lifebase-tool-driver.ts'),
          config: { cwd },
        },
        {
          id: 'lifebase',
          name: join(repoRoot, 'plugins/lifebase/index.js'),
          config: {
            command: lifebaseExe,
            dataDir: options.dataDir,
            destination: options.destination,
            timeoutMs: 60_000,
          },
        },
      ] },
    ]))
    const result = await execa(process.execPath, [
      '--import', 'tsx/esm', dshSourceBin, '--profile', 'headless', '--patch', patch,
    ], {
      cwd: repoRoot,
      env: {
        ...clearedProxyEnv(),
        DSH_HOME: join(root, 'home'),
        DSH_AGENTS_HOME: join(root, 'agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_CLI_MOCK_FAILURE: '0',
        LIFEBASE_MOCK_SCENARIO: options.scenario,
      },
      input: '',
      timeout: lifebaseToolTimeoutMs - 30_000,
      killSignal: 'SIGKILL',
      reject: false,
    })

    const diagnostic = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    expect(result.timedOut, diagnostic).toBe(false)
    expect(result.signal, diagnostic).toBeUndefined()
    expect(result.exitCode, diagnostic).toBe(0)
    const records = result.stdout.split('\n').filter(line => line.startsWith('DSH_LIFEBASE_TOOL_RESULT '))
    expect(records, diagnostic).toHaveLength(1)
    const evidence = JSON.parse(records[0]!.slice('DSH_LIFEBASE_TOOL_RESULT '.length)) as LifebaseToolEvidence
    expect(evidence.errors, diagnostic).toEqual([])
    expect(evidence.endReasons, diagnostic).toEqual([{ kind: 'completed' }])
    return evidence
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe.skipIf(lifebaseExe === '')('lifebase read-only tools', () => {
  describe.skipIf(lifebaseDataDir === '')('over the synthetic demo archive', () => {
    it('queries the archive, follows an evidence id out of its own result, and answers', async () => {
      const evidence = await boot({ dataDir: lifebaseDataDir, destination: 'cloud', scenario: 'chain' })

      // The model asked for all three, in order, and none of them threw: an
      // exit-code misread or a launch failure would surface as a tool error.
      expect(evidence.calls.map(call => call.name)).toEqual(['lifebase_search', 'lifebase_context', 'lifebase_evidence'])
      expect(evidence.results).toHaveLength(3)
      expect(evidence.results.filter(call => call.isError)).toEqual([])
      for (const call of evidence.results) {
        expect(call.text.length, `envelope characters: ${evidence.results.map(entry => entry.text.length).join(', ')}`)
          .toBeLessThan(PRUNER_THRESHOLD_CHARS)
      }

      const search = envelopeOf(evidence.results[0]!)
      const context = envelopeOf(evidence.results[1]!)
      const lookup = envelopeOf(evidence.results[2]!)

      // One snapshot answers all three; the archive is read, never rebuilt.
      expect(search.api_version).toBe(1)
      for (const envelope of [search, context, lookup]) {
        expect(envelope.status).toBe('ok')
        expect(envelope.snapshot_id).toMatch(/^[0-9a-f]{64}$/)
      }
      expect([context.snapshot_id, lookup.snapshot_id]).toEqual([search.snapshot_id, search.snapshot_id])

      expect(search.tool).toBe('search')
      expect(search.data.query).toBe('野餐')
      const matches = search.data.matches ?? []
      expect(matches.length).toBeGreaterThan(0)
      for (const match of matches) {
        expect(match.record_id).toMatch(/^sha256:/)
        expect(match.revision_id).toMatch(/^sha256:/)
        expect(match.conversation_id).toMatch(/^sha256:/)
        expect(match.excerpt).toContain('野餐')
        expect(match.evidence.length).toBeGreaterThan(0)
      }

      // The archive composes no answer of its own and holds the excerpt budget.
      expect(context.tool).toBe('context')
      expect(context.data.generated_answer).toBeNull()
      expect(context.data.content_chars).toBeLessThanOrEqual(3000)
      expect(context.data.matches?.length).toBeGreaterThan(0)

      // The evidence id the model asked about is the one that came back: the
      // value survived the result-to-argument round trip in both directions.
      expect(lookup.tool).toBe('evidence')
      const asked = JSON.parse(evidence.calls[2]!.arguments) as { evidence_id: string }
      expect(asked.evidence_id).toMatch(/^sha256:/)
      expect(lookup.data.evidence?.evidence_id).toBe(asked.evidence_id)

      expect(evidence.finalText.startsWith(REPLY_MARKER)).toBe(true)
    }, lifebaseToolTimeoutMs)

    it('sends the configured destination to the archive unchanged', async () => {
      // `local` is the value a local model route needs, and the envelope echoes
      // back what the archive received: this asserts the plugin passes its own
      // setting through rather than deciding anything about the route itself.
      const evidence = await boot({ dataDir: lifebaseDataDir, destination: 'local', scenario: 'single' })

      expect(evidence.calls.map(call => call.name)).toEqual(['lifebase_context'])
      expect(evidence.results.filter(call => call.isError)).toEqual([])
      const context = envelopeOf(evidence.results[0]!)
      expect(context.status).toBe('ok')
      expect(context.data.destination).toBe('local')
      expect(evidence.finalText.startsWith(REPLY_MARKER)).toBe(true)
    }, lifebaseToolTimeoutMs)
  })

  it('reports a missing graph as a tool error carrying the archive code', async () => {
    // An empty data directory is a failing archive, not a failing plugin: the
    // call must come back as an error the model can act on, the turn must
    // survive it, and the code must survive as a structured field (the registry
    // only exposes one for a HarnessError) rather than only as prose.
    const empty = await mkdtemp(join(tmpdir(), 'dsh-lifebase-empty-'))
    try {
      const evidence = await boot({ dataDir: empty, destination: 'cloud', scenario: 'single' })

      expect(evidence.calls.map(call => call.name)).toEqual(['lifebase_context'])
      expect(evidence.results).toHaveLength(1)
      const failed = evidence.results[0]!
      expect(failed.isError).toBe(true)
      expect(failed.errorCode).toBe('GRAPH_MISSING')
      // The model reads prose, so the code has to be in the text as well: the
      // structured field is for the layers above, not for the model.
      expect(failed.text).toContain('GRAPH_MISSING')
      expect(failed.text).toContain('graph build')
      expect(evidence.finalText.startsWith(REPLY_MARKER)).toBe(true)
    } finally {
      await rm(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, lifebaseToolTimeoutMs)
})
