# Open-CR-Agent

[English](README.md) · 简体中文

**ocra** 是一个开源的代码审查引擎。审哪些文件、怎么分组、哪些规则适用、评论落在哪一行，由确定性的代码决定；隔离运行的大模型 agent 只负责需要判断的事，而它们说的每一句话都会先经过核查、去重和行号定位，然后才交到人手里。

它能审查本地改动、GitHub Pull Request 和 GitLab Merge Request，用你自己的模型 key 在你的 CI 里运行，而且从设计上就是为审查你不信任的 PR 而做的。

[![npm](https://img.shields.io/npm/v/@open-cr-agent/cli?label=npm)](https://www.npmjs.com/package/@open-cr-agent/cli)
[![CI](https://github.com/jma49/Open-CR-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/jma49/Open-CR-Agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> **状态：**早期 0.x 版本。CLI 参数、配置项、退出码和报告格式是[约定](docs/manual/zh/stability.mdx)，只会在预先告知后改变；提示词和审查质量仍在变动。[质量实测](docs/manual/zh/quality.mdx)说明了在一个小样本上，审查今天能发现什么、会漏掉什么。手册：[ocracloud.com](https://ocracloud.com)（[English](docs/manual/en/index.mdx) · [中文](docs/manual/zh/index.mdx)）。

## 为什么选择 ocra

大多数审查机器人都是 `diff → 模型 → 评论`。ocra 在每一个出错代价高昂的环节，都用代码把模型围起来：

- **模型看到什么，由代码决定。** 文件选择、风险分档、分组、规则匹配和审查矩阵都是带测试的纯函数。看起来像密钥的路径和 `.git/` 在同一处被拒绝，对每个 agent、每个工具都生效。
- **每条问题都由它引用的代码锚定，从不依赖模型编造的行号。** 引用先在 diff 里匹配，再在整个文件里匹配，再到其他文件的改动段里匹配；有歧义的引用降为文件级评论，并计入报告。
- **问题在发布之前先经过核查和裁决。** 核查员丢掉被 diff 证明是错的问题，其余的标为已确认或不确定；Judge 合并不同审查员的重复报告并校准严重程度。结论由代码根据裁决后的问题列表算出。
- **复审是增量的，并且以证据为准。** 只有当一条问题所指的代码已经不在了，它才算已修复；维护者的驳回会让它不再出现，PR 自己的作者做不到。
- **成本有上限，并且会报告。** 每次运行的花费上限一到就不再启动新任务，报告会列出没审到的文件，下一次审查接着审它们。每次模型调用都会报告 token 和费用。
- **不信任的 PR 是设计的出发点。** agent 只有只读工具，没有 shell，没有网络；配置、规则和 memory 都从 base 提交读取；评论里的模型文本无法形成链接、@ 提及或命令。见[威胁模型](docs/manual/zh/threat-model.mdx)。
- **结构化输出。** 带版本号的 JSON 报告，附有公开的 [JSON Schema](docs/schema/report.v1.json)，每条问题都注明来自哪个任务、哪个模型；[SARIF 2.1.0](docs/manual/zh/github.mdx) 可输出给代码扫描，也可从 Semgrep、CodeQL 等分析器导入；还有一份记录每次运行成本、token 和延迟的会话日志。

## 工作原理

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/system-zh-dark.svg">
  <img alt="ocra 系统全景：开发者终端、GitHub Actions、GitLab CI 或 ocra-eval 启动 cli，cli 运行 core（流水线、ReviewContext、问题与报告、花费上限）；core 通过 VcsAdapter 各包（vcs-platform、vcs-github、vcs-gitlab、vcs-local）读取改动并把评论发布到 GitHub 或 GitLab API，通过 AgentRuntime（runtime-direct 或 runtime-opencode，共用 ChainRunner 降级）调用模型服务商；登录 ocra Cloud 是可选的" src="docs/images/system-zh-light.svg">
</picture>

```
 Ingest → Select → Triage → Bundle → Matrix → Execute → Anchor → Filter → Verify → Judge → Publish
 └─────────── deterministic ─────────────┘   └─ LLM ─┘  └ code ┘  └ code ┘  └ LLM ┘  └ LLM ┘  └ code ┘
```

目前内置五个审查员，每个都是一个插件，有自己的适用范围和模型层级：`correctness`、`security`、`performance`、`docs` 和 `agents-md`。审查员作为隔离的 agent 任务运行，每个（分组，审查员）组合一个任务，问题通过带类型的工具提交，从不以自由文本提交。模型沿降级链切换，每个模型都有熔断器；失败的任务在报告里记为覆盖缺口，而不是让整次运行失败。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-zh-dark.svg">
  <img alt="ocra 的 agent：light 模型的分组器把改动分组，审查矩阵为每个分组和每个审查员启动一个隔离的只读 agent 任务（correctness、security 和 performance 在 standard 层级，docs 和 agents-md 在 light 层级），它们的问题由代码锚定、由 light 模型辅助重新定位，standard 层级的核查员逐文件核查，top 层级的 Judge 去重并校准，最后由代码算出结论" src="docs/images/agents-zh-light.svg">
</picture>

完整设计见[架构](docs/architecture.md)和[决策记录](docs/adr/)。

## 快速上手

要求 Node.js 22.19 或更高版本，以及 Git。

**五分钟配置。** shell 里有模型 key 时，`ocra init` 会替你写好配置：

```bash
npm install -g @open-cr-agent/cli
export GEMINI_API_KEY="你的 key"     # 或 ANTHROPIC_API_KEY、OPENAI_API_KEY、OPENROUTER_API_KEY
cd your-repository
ocra init                            # 写入 .ocra/config.json，模型按这个 key 来选
ocra review                          # 审查未提交的改动
ocra init --github                   # 还会写入 .github/workflows/ocra.yml，可安全审查来自 fork 的 PR
```

`ocra init` 从不替换已有文件（`--force` 会），并打印后续步骤，比如 workflow 要用的 `gh secret set` 和 `gh label create ocra-review` 命令（[ocra init](docs/manual/zh/cli.mdx#ocra-init)）。也可以手动配置：

```bash
npm install -g @open-cr-agent/cli
export GEMINI_API_KEY="你的 key"       # OpenCode 支持的任何供应商都可以；见"模型供应商"
ocra review --from main                # 当前分支从 main 分叉以来的改动
```

在被审查仓库的 `.ocra/config.json` 里选择模型（或用 `OCRA_MODEL_TOP`、`OCRA_MODEL_STANDARD` 和 `OCRA_MODEL_LIGHT`；写成列表就是降级链）：

```json
{
  "models": {
    "top": "google/gemini-3.1-pro-preview",
    "standard": ["google/gemini-3.5-flash", "google/gemini-flash-lite-latest"],
    "light": "google/gemini-flash-lite-latest"
  }
}
```

`standard` 模型负责审查代码，`light` 模型负责分组文件这类辅助工作，`top` 模型负责裁决。更多审查目标：

```bash
ocra review                                  # 未提交的改动，包括未跟踪的文件
ocra review --commit abc123                  # 单个 commit
ocra review --plan                           # 文件、分组、任务、提示词大小、输入成本；不调用模型
ocra review --max-cost-usd 2                 # 花费上限；报告会说明哪些没审到
ocra review --format sarif --output out.sarif
ocra review --import-sarif semgrep.sarif        # 把分析器在这次改动上的结果并入审查
ocra review --pr 42 --publish                # GitHub Pull Request，以评审的形式发布
ocra review --mr 7 --publish                 # GitLab Merge Request
```

不安装也能用：`npx @open-cr-agent/cli review`。默认运行时 OpenCode 是可选依赖；使用 `direct` 运行时可以不装它，安装体积从 175 MB 降到 11 MB（[安装](docs/manual/zh/installation.mdx#不装-opencode)）。[快速上手](docs/manual/zh/quickstart.mdx)会带你完成第一次运行；[模型供应商](docs/manual/zh/providers.mdx)介绍每个供应商，包括你自己的 OpenAI 兼容端点和按模型定价。

## 在 CI 里

**GitHub Pull Request**，用 [`action.yml`](action.yml) 里的 Action：行内评论、一条在原处更新的摘要评论，以及只审查上次 push 以来改动部分的复审。

```yaml
# .github/workflows/ocra.yml
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: ocra-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: jma49/Open-CR-Agent@82a3f1183a3177e9efa401d87eb95dea495ef619 # v0.6.0
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

像这里一样把 Action 固定到提交：tag 可以被移动。它的输出（`verdict`、`exit-code`、`run-id`、`findings`、`report`，以及 `sarif: true` 时的 `sarif`）可以交给后续步骤，比如把 SARIF 上传到代码扫描。只有当每个包都带有本仓库发布 workflow 的 provenance 时，Action 才安装已发布的 CLI；否则改为从源码构建，并说明这一点。配置里设了 `"runtime": "direct"` 时，`opencode: false` 会跳过 OpenCode 的安装。来自 fork 的 PR 需要 [GitHub 指南](docs/manual/zh/github.mdx)里带门禁的 `pull_request_target` 配置。

**GitLab Merge Request**，GitLab.com 或自建实例，在 CI job 里运行：见 [GitLab 指南](docs/manual/zh/gitlab.mdx)。

**其他任何 runner**，用容器镜像 `ghcr.io/jma49/ocra:<version>`（amd64 和 arm64，带 provenance 声明和 SBOM）：见[安装](docs/manual/zh/installation.mdx)。

## 输出与退出码

每次运行都会在 `.ocra/sessions/` 下写入 `events.jsonl` 和 `report.json`。`--format json` 打印报告；`--format sarif` 打印 SARIF 2.1.0，供代码扫描面板使用。

| 退出码 | 含义 |
|---|---|
| `0` | 审查完成 |
| `1` | 有经核查确认的 critical 问题（结论 `significant_concerns`） |
| `2` | 用法错误，或没有任何审查任务完成 |
| `3` | 审查不完整：有文件没有被审查，或只审了一部分（任务失败、触及花费上限、审查员用完了步数） |
| `130` | 被中断 |

CI 绝不能把不完整的审查当成通过；`3` 就是为此而设。结论是读过改动的模型给出的参考意见，可能被改动里的文字左右：不要把它当作安全门禁。

## 配置

被审查仓库里的 `.ocra/config.json`，审查 PR 时从 base 提交读取：

```json
{
  "models": { "top": "...", "standard": ["..."], "light": "..." },
  "concurrency": 4,
  "taskTimeoutMinutes": 10,
  "runTimeoutMinutes": 25,
  "include": [],
  "exclude": ["legacy/**"],
  "runtime": "opencode",
  "plugins": ["@acme/ocra-plugin-rules", "./tools/ocra-plugin.mjs"],
  "pluginSettings": { "acme-rules": { "team": "payments" } }
}
```

仓库规范来自 `AGENTS.md`；按路径生效的审查规则来自 `.ocra/rules.json`：

```json
{ "rules": [{ "path": "api/**", "rule": "Handlers must check tenant ownership." }] }
```

团队还可以通过 https 共享配置（`extends`）；`ocra review --config <file>` 改为读取你自己的文件而不是仓库里的（与 `--no-repo-config` 一起用也生效）；`ocra memory` 记录团队已接受的问题，之后不再报告；`ocra metrics` 汇总各次会话报告里的运行次数、成本、问题及其去向。`ocra login`、`ocra logout` 和 `ocra whoami` 用于登录 ocra Cloud（https://app.ocracloud.com，开发中）（[CLI](docs/manual/zh/cli.mdx#ocra-loginocra-logoutocra-whoami)）。登录后，你账户里的模型、上限、文件模式和规则会放在仓库配置之下生效，从不取代它，也永远不涉及供应商和插件（[账户设置](docs/manual/zh/configuration.mdx#账户设置)）。网页上记住的问题会与 `.ocra/memory.json` 里的一起生效，报告会写明每条问题是被哪个 memory 隐藏的；只有账户开启后，问题才会发送到 ocra Cloud，发送前会先脱敏看起来像密钥的内容（[CLI](docs/manual/zh/cli.mdx#ocra-cloud-账户里的-memory)）。全部配置项：[配置](docs/manual/zh/configuration.mdx)、[审查规则](docs/manual/zh/rules.mdx)。

## 扩展 ocra

ocra 是一个引擎，会变化的部分都定义了约定。内置的部分就是基于这些约定的插件，任何人都可以实现同样的约定：

| 约定 | 做什么 | 内置实现 |
|---|---|---|
| `VcsAdapter` | 改动从哪里来，审查结果发到哪里 | 本地 git、GitHub、GitLab |
| `AgentRuntime` | 一个隔离的审查任务怎么运行 | OpenCode；`direct`，一个针对你声明的端点的工具循环 |
| 审查员 | 谁审什么、用哪个模型层级 | `correctness`、`security`、`performance`、`docs`、`agents-md` |
| 规则与工具 | 按路径生效的指令；agent 可调用的只读工具 | `.ocra/rules.json`；`read_file`、`read_diff`、`code_search`、`report_finding` |
| 分析器 | 来自非模型工具的问题，以 CI job 交来的 SARIF 2.1.0 日志形式导入（`--import-sarif`）；ocra 自己不运行任何工具 | 用 Semgrep 的输出测试过 |

插件是一个带名字和生命周期钩子的模块：

```js
export default {
  name: "acme-rules",
  configure(ctx) {
    ctx.registerRules([{ path: "services/**", rule: `Owned by ${ctx.settings.team}: check idempotency keys.` }]);
  },
};
```

插件会执行代码，所以只在被审查的代码树受信任时加载：本地审查会加载，审查 PR 或带 `--no-repo-config` 时从不加载。你的 ocra Cloud 账户指定的插件，只有在 `ocra plugins allow <name>@<version>` 在这台机器上安装了那个确切版本（不运行脚本）之后才会加载，而且只从那里加载。审查对话中与平台无关的规则（谁可以驳回、什么算已修复、摘要怎么写）只在 `vcs-platform` 里写一次，每个平台适配器都要通过同一套一致性测试。[插件指南](docs/manual/zh/plugins.mdx)、[插件约定](docs/adr/0006-plugin-contract.md)。

ocra 首先是一个库：`@open-cr-agent/core` 的 `review()` 在你自己的程序、机器人或服务里运行与命令行相同的流水线，插件由你选择。它的错误带有稳定的错误码（`OcraError`）。每个包都导出一份精选的公开 API，记录在 [`etc/`](etc/) 里并由 CI 检查；[嵌入 ocra](docs/manual/zh/embedding.mdx) 是这份约定的说明页。

## 安全模型

假定被审查的代码是恶意的；ocra 就是这样假定的。

- agent 只有只读工具，没有 shell，没有网络，环境变量按白名单传入。看起来像密钥的路径和 `.git/` 在 core 里统一拒绝，对每个适配器都生效。
- 审查 PR 时，被审查代码树里的任何东西都不会运行：没有插件、没有 OpenCode 配置、没有安装脚本、没有 diff 驱动。配置、规则和 memory 都来自 base 提交。
- 提示词里的每一段不可信字符串都有围栏；评论里的模型文本无法形成链接、@ 提及、快捷操作或命令。命令只接受有写权限的人未经编辑的评论。
- 发布使用 trusted publishing 和 SLSA provenance；Action 要求必须有。审查时不从任何 registry 拉取代码，用 `direct` 运行时则只会访问你的模型端点。容器镜像带有来源声明。
- 一组对抗性黄金用例会在被审查的改动里埋入指令、链接和命令，衡量有多少能穿透。

[安全与隐私](docs/manual/zh/security.mdx)、[威胁模型](docs/manual/zh/threat-model.mdx)，私下报告漏洞见 [SECURITY.md](SECURITY.md)。

## 质量与评测

数字连同它们的局限一起公开，而且只公开实际测过的数字。目前：16 个黄金用例在 Gemini 上跑了一次，10 个用例的 smoke 档在一个 OpenRouter 免费模型上跑了两次，召回率在每一次里都是短板；标注由另一个模型抽查过。在十个基准 PR 上做两次完全相同的运行，精确率相差 20 个百分点，所以这个样本还不足以判定提示词改动的好坏，在它能做到之前提示词保持冻结。[质量实测](docs/manual/zh/quality.mdx)。

`ocra-eval` 回放 [AACR-Bench](https://github.com/alibaba/aacr-bench)（200 个真实 PR，1,505 条经专家核实的评论）和 ocra 自己的黄金用例，报告精确率、召回率、F1、成本和延迟。审查以固定的 temperature 和 seed 运行，每份报告都记录 ocra 版本、提示词和配置的哈希以及实际应用的采样设置；`--repeat k` 为每项指标给出 95% 置信区间，所以 `compare` 只在区间分开时才判定一次改动更好，`trend` 则在各个配置共有的用例上追踪多次运行。免费的 `ceiling` 命令显示确定性阶段最多能达到什么水平。[评测指南](docs/manual/zh/evaluation.mdx)。

## 未来方向

ocra 的长期定位是其他审查 agent 赖以构建的引擎，而不是又一个机器人：一个共享的 `Finding` 模型、为会变化的部分定义的稳定约定，以及每个可插拔部分的一致性测试。参考审查员仍然是产品本身，也是引擎的第一个用户；约定只在第二个真实实现需要时才提取，从不提前。

| 里程碑 | 范围 | 状态 |
|---|---|---|
| M1–M4 | 流水线、审查员、GitHub、增量复审、降级、memory | 已完成 |
| M7–M9 | 带 provenance 发布到 npm；不信任 PR 的加固；GitLab、SARIF、容器镜像、声明式供应商（0.2.0） | 已完成 |
| M5–M6 | 一个能判定改动好坏的质量数字；在不损失精确率的前提下提高召回率 | 暂停，等待模型额度 |
| M10 | 约定：Finding 规范、公开的 `review()` 入口、带一致性测试的第二个运行时、SARIF 导入 | 大部分已完成；其余暂停 |
| M14 | ocra Cloud（[ADR-0024](docs/adr/0024-ocra-cloud.md)）：登录、你自己的 key 经模型网关使用、审查的网页视图、账户配置和可选开启的问题上传 | 第一阶段已完成（0.5.0）；冻结，先做用户和召回率 |
| M11–M13 | 证据（每晚的真实测试、按审查员的数字）、可运维性（组织策略、运行 id、指标）、外部使用 | 进行中：外部使用和召回率（M11、M13），`ocra init` 提供一条命令的配置；可运维性暂停 |

计划、理由，以及有意不做的事：[路线图](docs/roadmap.md)。

## 包

使用 ocra 只需安装一个包 `@open-cr-agent/cli`，它会带上需要的其他包。其余的包列在这里，供嵌入引擎或基于其约定开发的人参考。

| 包 | 职责 |
|---|---|
| `@open-cr-agent/core` | 领域类型、流水线阶段、`VcsAdapter` / `AgentRuntime` / 插件约定；不依赖仓库内的任何包 |
| `@open-cr-agent/runtime-opencode` | 基于 OpenCode SDK 的 `AgentRuntime` |
| `@open-cr-agent/runtime-direct` | 自己调用声明的 OpenAI 兼容端点的 `AgentRuntime`；不访问网络上的其他任何地址 |
| `@open-cr-agent/vcs-platform` | 各平台共享的审查对话：信任规则、状态、摘要和评论文本 |
| `@open-cr-agent/vcs-github` | GitHub Pull Request 的 `VcsAdapter` |
| `@open-cr-agent/vcs-gitlab` | GitLab Merge Request 的 `VcsAdapter` |
| `@open-cr-agent/vcs-local` | 本地 git 仓库的 `VcsAdapter` |
| `@open-cr-agent/cloud-contract` | 与 ocra Cloud 的通信约定（Zod schema、上限、取值集合、错误码、脱敏流程）；随 CLI 安装，不直接使用 |
| `@open-cr-agent/cli` | `ocra` 命令 |
| `@open-cr-agent/eval` | 基准回放与质量指标 |

## 开发

```bash
git clone https://github.com/jma49/Open-CR-Agent.git
cd Open-CR-Agent && npm install && npm run build
npm link --workspace @open-cr-agent/cli   # 让 ocra 指向这个检出目录
npm run verify                            # Biome、类型检查和测试（不调用模型，不访问网络）
```

给人和 agent 的规则，与 CI 强制执行的是同一套：[AGENTS.md](AGENTS.md)。发布：[CHANGELOG.md](CHANGELOG.md)；用户可见的改动要添加一个 changeset（[.changeset/README.md](.changeset/README.md)）。

## 贡献与安全

- [CONTRIBUTING.md](CONTRIBUTING.md)：什么贡献最有帮助、如何搭建环境，以及哪些部分在有额度衡量之前保持冻结。
- [SECURITY.md](SECURITY.md)：请私下报告漏洞，不要发公开 issue。
- [稳定性与支持](docs/manual/zh/stability.mdx)：什么算约定、约定会怎样变化，以及如何校验一个发布版本。
- [行为准则](CODE_OF_CONDUCT.md)。

灵感来自 [Cloudflare 的 AI 代码审查](https://blog.cloudflare.com/ai-code-review/)和 [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review)。

## 许可证

[Apache-2.0](LICENSE)
