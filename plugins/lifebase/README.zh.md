# dsh-lifebase

[English](README.md) | 中文

以五个 Harness 工具的形式，只读访问本地 [Lifebase](https://github.com/Terrence129/Lifebase) 归档。

Lifebase 把导入的聊天导出按分层保存：导入时即定格的 RAW、规范化后的记录层，以及构建出的主题图谱。本插件把五条只读查询转发给 `lifebase` 命令行，并原样返回它发布的 JSON 信封，因此模型可以把 `record_id`、`revision_id` 与 `evidence_id` 引用回归档。

## 工具

| 工具 | Lifebase 子命令 | 回答什么 |
| --- | --- | --- |
| `lifebase_topics` | `topics` | 归档里有哪些主题，各自包含多少条消息。 |
| `lifebase_search` | `search` | 哪些消息提到某个主题，附片段摘要与证据定位符。 |
| `lifebase_timeline` | `timeline` | 单个会话按发生顺序展开，包含发生时间未知的条目。 |
| `lifebase_evidence` | `evidence` | 某个证据 id 指向的规范化记录。 |
| `lifebase_context` | `context` | 针对一个问题收集的证据，并在各来源之间保持均衡。 |

每个工具都接受同一组可选过滤条件：`source`、`limit`、`role`、`since`、`until`（`lifebase_evidence` 只接受证据 id）。`since` 为闭区间、`until` 为开区间，两者都接受 UTC 日期或带显式时区偏移的时间戳。发生时间未知的消息不会进入带时间过滤的查询，而是计入 `warnings`。

## 只读保证

插件只能运行 `graph status`、`topics`、`search`、`timeline`、`evidence` 与 `context`。它从不运行 `graph build`、`ingest`、`rebuild` 或 `query`，也从不读取 RAW 字节：`lifebase_evidence` 返回规范化记录，以及定位归档来源的哈希与 JSON 指针，而不是归档来源本身。Lifebase 中每一条查询路径都有验收测试，断言一次查询不会改变数据目录中任何文件的哈希。

## 设置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `command` | `lifebase` | 可执行文件。裸名字会在 PATH 上解析；绝对路径更稳妥，因为子进程环境是被清洗过的。 |
| `dataDir` | 必填 | 要查询的数据目录。每次调用都作为 `--data-dir` 传入。 |
| `destination` | `cloud` | 结果允许去往哪里。`cloud` 会把命中的片段交给模型提供商；`local` 会让归档在自己的关卡上拒绝云端模型。 |
| `timeoutMs` | `20000` | 单次调用的时限。每次调用都会启动一个新的 CLI 进程，因此冷启动的第一次调用会因解释器导入库而多花几秒。 |

插件还会对子进程强制设置 `PYTHONIOENCODING=utf-8`：在 Windows 上，输出被管道接管的 Python 默认写 ANSI 代码页，那会以无法解码的字节到达 Harness。子进程环境的其余部分是 Harness 清洗过的父环境，因此形似凭据的变量永远不会到达归档进程。

### `destination` 是声明，不是网络管控

`destination` 声明调用方打算把结果送往何处，Lifebase 会针对查询触及的来源强制执行它：某个来源未获云端许可时，整条查询会以 `EGRESS_BLOCKED` 失败。这道关卡是真实存在的，位于 Lifebase 内部。

关卡看不到的，是本插件自己的设置。插件从不检查模型路由，它原样传递 `destination`，因此没有任何东西阻止 `cloud` 这个值被送给云端模型。**如果你改用本地模型路由，请把 `destination` 设为 `local`，并重新跑一次查询确认改动生效。** 任何路由变更都会让上一次核对失效。

把某个来源标记为允许云端，是在 Lifebase 内做出的决定（每个采集器上的 `egress_policy`），不在这里。聊天记录也带着对方的发言，而内容一旦发给提供商，之后便不在本地掌控之内。

## 错误

失败会以工具错误的形式到达，并携带 Lifebase 自己的错误码，因此模型能区分归档问题与插件问题。

| 错误码 | 含义 |
| --- | --- |
| `EGRESS_BLOCKED` | 快照中至少有一个来源，被归档拒绝了本次目的地。 |
| `GRAPH_MISSING` | 该数据目录中尚未构图。 |
| `GRAPH_STALE` | 构图之后又导入了来源；请运行 `lifebase graph build`。 |
| `GRAPH_INVALID` | 图谱未通过哈希或引用校验。 |
| `INVALID_REQUEST` | 查询本身被拒绝，例如 `limit` 超出 1-100。 |
| `INPUT_INVALID` | 数据目录或某项输入无法读取。 |
| `LIFEBASE_SPAWN_FAILED` | 可执行文件无法启动——请检查 `command`。 |
| `LIFEBASE_ARGV_BUG` | CLI 拒绝了本插件构造的参数列表。这是插件缺陷，不是数据问题。 |
| `LIFEBASE_CONTRACT_VIOLATION` | CLI 正常退出，却没有打印它的 v1 JSON 信封。 |
| `LIFEBASE_OUTPUT_OVERFLOW` | 输出超过 1 MiB 的捕获上限；截断的信封会被拒绝，而不会被解析。 |
| 其他 `LIFEBASE_*` | 调用未完成：被中止、被信号杀死、触及单次调用时限、以意外状态退出，或打印了没有错误码的信封。请重试，或调大 `timeoutMs`。 |

## 安装

开发时无需安装——开发层里的相对 `name` 会锚定到 patch 文件旁，因此检出目录可以直接就地加载：

```sh
pnpm dsh --profile web --patch plugins/lifebase/cordis.dev.patch.yml
```

开发层从 `LIFEBASE_EXE` 与 `LIFEBASE_DEMO_DIR` 取 `command` 与 `dataDir`，与端到端测试读的是同一对变量。请把它们写在仓库根目录的 `.env` 中，该文件已被 git 忽略。两者都没有时按占位值走，插件会拒绝激活并在消息里点名 `command`。

要让这些工具成为某个 profile 的一部分，安装这个 bundle 目录并选中它：

```sh
pnpm dsh plugin --profile web add plugins/lifebase
pnpm dsh plugin --profile web list
```

移除它（`pnpm dsh plugin --profile web remove dsh-lifebase`）即可让 profile 复原。

接下来给它可用的 `command` 与 `dataDir`。本目录中的两个 patch 都带占位值，因为本仓库是公开的；真值应放在 profile 自己的 patch 层，即 `<harness home>/profiles/web/cordis.patch.yml`，它不属于任何检出目录。同 id 的行会应用在所有 bundle 层之后，并整块替换该条目的配置：

```yaml
- id: lifebase
  name: dsh-lifebase
  config:
    command: '/path/to/lifebase'
    dataDir: '/path/to/lifebase-data/libraries/demo'
    destination: cloud
```

## 要求

- 已安装并单独配置好自己数据目录的 `lifebase` CLI。
- Harness `0.2.1-alpha.1`，或提供 `ctx.tools` 与 `ctx.subprocess` 的兼容版本。
