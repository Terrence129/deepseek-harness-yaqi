# dsh-lifebase

English | [中文](README.zh.md)

Read-only access to a local [Lifebase](https://github.com/Terrence129/Lifebase) archive,
exposed as five Harness tools.

Lifebase keeps a personal archive of imported chat exports in layers: RAW as imported,
a normalized record layer, and a built graph of topics. This plugin forwards five
read-only queries to the `lifebase` command line and returns its published JSON envelope
unchanged, so the model can cite `record_id`, `revision_id`, and `evidence_id` back to
the archive.

## Tools

| Tool | Lifebase subcommand | Answers |
| --- | --- | --- |
| `lifebase_topics` | `topics` | Which topics does the archive hold, and how many messages each one has. |
| `lifebase_search` | `search` | Which messages mention a topic, with an excerpt and evidence locators. |
| `lifebase_timeline` | `timeline` | One conversation in occurrence order, including entries with no known time. |
| `lifebase_evidence` | `evidence` | The normalized record one evidence id points at. |
| `lifebase_context` | `context` | Evidence gathered for a question, balanced across sources. |

Every tool takes the same optional filters: `source`, `limit`, `role`, `since`, `until`
(`lifebase_evidence` takes only the evidence id). `since` is inclusive, `until` is
exclusive, and both accept a UTC date or a timestamp with an explicit offset. Messages
whose occurrence time is unknown stay out of a filtered query and are counted in
`warnings`.

## Read-only guarantee

The plugin can only run `graph status`, `topics`, `search`, `timeline`, `evidence`, and
`context`. It never runs `graph build`, `ingest`, `rebuild`, or `query`, and it never
reads RAW bytes: `lifebase_evidence` returns the normalized record and the hash and JSON
pointer that locate the archived source, not the archived source itself. Every query
path in Lifebase is covered by an acceptance test asserting that a query changes no file
hash in the data directory.

## Settings

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | `lifebase` | The executable. A bare name resolves on PATH; an absolute path is safer, because the child environment is scrubbed. |
| `dataDir` | required | Data directory to query. Passed to every call as `--data-dir`. |
| `destination` | `cloud` | Where results are allowed to go. `cloud` releases matched excerpts to the model provider; `local` makes the archive refuse a cloud model at its own gate. |
| `timeoutMs` | `20000` | Per-call deadline. Every call starts a fresh CLI process, so a cold first call costs a few seconds while the interpreter imports its libraries. |

The plugin also forces `PYTHONIOENCODING=utf-8` on the child: a piped Python writes the
ANSI code page by default on Windows, which would reach the Harness as undecodable bytes.
The rest of the child environment is the Harness's scrubbed parent environment, so
credential-shaped variables never reach the archive process.

### `destination` is a declaration, not a network control

`destination` states where the caller intends results to go, and Lifebase enforces it
against the sources a query touches: a source that is not cleared for cloud makes the
whole query fail with `EGRESS_BLOCKED`. That gate is real and lives in Lifebase.

What the gate cannot see is this plugin's own setting. This plugin never inspects the
model route; it passes `destination` through verbatim, so nothing stops a `cloud` value
from being sent to a cloud model. **If you switch to a local model route, set
`destination: local` and re-run one query to confirm the change took effect.** Any route
change invalidates the previous check.

Clearing a source for cloud is a decision made in Lifebase (`egress_policy` on each
collector), not here. Chat logs also carry the other party's messages, and content sent
to a provider is out of local control afterwards.

## Errors

Failures arrive as tool errors carrying Lifebase's own code, so the model can tell an
archive problem from a plugin problem.

| Code | Meaning |
| --- | --- |
| `EGRESS_BLOCKED` | The archive refused this destination for at least one source in the snapshot. |
| `GRAPH_MISSING` | No graph has been built in this data directory. |
| `GRAPH_STALE` | Sources were imported after the graph was built; run `lifebase graph build`. |
| `GRAPH_INVALID` | The graph failed its hash or reference checks. |
| `INVALID_REQUEST` | The query itself was rejected, e.g. a `limit` outside 1-100. |
| `INPUT_INVALID` | The data directory or an input could not be read. |
| `LIFEBASE_SPAWN_FAILED` | The executable could not be started — check `command`. |
| `LIFEBASE_ARGV_BUG` | The CLI rejected the argument list this plugin built. A plugin bug, not a data problem. |
| `LIFEBASE_CONTRACT_VIOLATION` | The CLI exited cleanly without printing its v1 JSON envelope. |
| `LIFEBASE_OUTPUT_OVERFLOW` | Output exceeded the 1 MiB capture limit; a truncated envelope is refused rather than parsed. |
| other `LIFEBASE_*` | The call did not complete: it was aborted, killed by a signal, hit the per-call deadline, exited with an unexpected status, or printed an envelope without a code. Retry, or raise `timeoutMs`. |

## Install

For development, no installation is needed — the relative `name` in the dev layer is
anchored to the patch file, so the checkout loads in place:

```sh
pnpm dsh --profile web --patch plugins/lifebase/cordis.dev.patch.yml
```

The dev layer reads `LIFEBASE_EXE` and `LIFEBASE_DEMO_DIR` for `command` and `dataDir` —
the same two variables the end-to-end test reads. Set them in the repository-root `.env`,
which is git-ignored. With neither set the placeholders apply, and the plugin refuses to
activate with a message naming `command`.

To make the tools part of a profile, install the bundle directory and select it:

```sh
pnpm dsh plugin --profile web add plugins/lifebase
pnpm dsh plugin --profile web list
```

Removing it (`pnpm dsh plugin --profile web remove dsh-lifebase`) restores the profile.

Now give it a working `command` and `dataDir`. Both patch files in this directory ship
placeholders, because this repository is public; the real values belong in the profile's
own patch layer, `<harness home>/profiles/web/cordis.patch.yml`, which no checkout
contains. A row with the same id there is applied after every bundle layer and replaces
the whole config:

```yaml
- id: lifebase
  name: dsh-lifebase
  config:
    command: '/path/to/lifebase'
    dataDir: '/path/to/lifebase-data/libraries/demo'
    destination: cloud
```

## Requirements

- The `lifebase` CLI, installed and separately configured with its own data directory.
- Harness `0.2.1-alpha.1` or a compatible version providing `ctx.tools` and
  `ctx.subprocess`.
