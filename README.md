# context-guard

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的本地技能：**在上下文塞满之前提醒你，并把工作无缝交接给新会话。**

长会话上下文膨胀后，模型会开始丢内容、截断、甚至停止输出；换会话又得把目标、决策、踩过的坑从头再讲一遍。
本技能把这两件事变成一条命令：读 DSH 自己的会话日志拿到**真实**上下文占用，到线提醒，然后生成一份能直接粘贴到新会话的交接文档。

纯 Node 脚本：**零第三方依赖、零构建、零网络请求**，只读文件系统。

## 特性

| 能力 | 说明 |
| --- | --- |
| 真实占用测量 | 取会话日志里 provider 上报的 `usage.totalTokens` 作为锚点，而不是凭感觉估算 |
| 两级阈值提醒 | 提醒线 / 临界线均可配置；越线输出中文提醒块，含"距临界还差多少步 / 多少回合" |
| 提醒不刷屏 | 按「会话 + 等级」落盘去重，同级只提醒一次；`--force` 可强制再提醒 |
| 交接文档 | 自动采集最近对话、工具动作、待办、交付物、改动文件、git 分支/HEAD；判断性段落留给模型补 |
| 新会话开场白 | 一段可直接粘贴的文本，首行含 `/context-guard`，新会话会自动加载同一套协议 |
| 配置四层覆盖 | 技能默认 → 工作区文件 → 环境变量 → 命令行 |
| 跨沙箱可用 | 不依赖 git、不依赖子进程、不联网；git 不可用时改从 `.git` 目录读分支/HEAD |
| 可自动化 | `--json` 输出结构化结果；`--exit-code` 让 warn→10、critical→20 |
| **交接自检** | `--verify` 机械校验交接文档：FILL 是否补完、每个决策能否在其载体文件里 grep 到、章节/开场白/链指针是否完整。退出码 0/1，可当门禁 |
| **链式接力** | 交接文档带 `chain` / `hop` / `previous` 指针，多棒接力可回溯，且明确要求"只在缺信息时回读，不通读全链"；交接目录里维护 `LATEST` 稳定指针 |
| **跨 agent 导出** | `--portable` 生成环境无关的 `HANDOFF.md`，剥掉 DSH 专属路径与命令，可直接交给 Claude Code / Codex / Cursor |
| **hook 接线（可选）** | `hooks/` 内置 SessionStart（注入当前占用 + 最新交接指针）与 UserPromptSubmit（仅新越线时提醒）两个钩子，异常一律静默退出，绝不打断会话 |

## 安装

前置条件：

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.15 / 23.8**（需要内置 zlib 的 Zstandard 解压；建议 24 LTS+，本技能在 v26.7.0 实测） |
| DSH | 需要能读到 DSH 会话日志（`$DSH_HOME/sessions/`）；非 DSH 环境可用 `--log` 指向任意 `.jsonl` / `.jsonl.zstd` |

技能是目录包，DSH 会扫描 `<根>/<名字>/SKILL.md`。把本仓库克隆到任一技能根下即可：

```powershell
# 项目级：只在这个仓库生效
git clone https://github.com/xianshengyao180-gif/dsh-context-guard .agents/skills/context-guard

# 用户级：所有项目都能用
git clone https://github.com/xianshengyao180-gif/dsh-context-guard "$env:USERPROFILE\.dsh\skills\context-guard"
```

无需 `npm install`，无需重启 DSH（技能目录被监听，新增即生效）。验证安装：

```powershell
$base = ".agents/skills/context-guard"
node "$base\scripts\context-usage.mjs" --help   # 应打印中文帮助
node "$base\scripts\context-usage.mjs"          # 应打印一行 CTX …
```

## 快速使用

```powershell
$base = ".agents/skills/context-guard"

node "$base\scripts\context-usage.mjs"           # 一行摘要；越线时附中文提醒块
node "$base\scripts\context-usage.mjs" --json     # 机器可读的完整 JSON
node "$base\scripts\handoff.mjs"                  # 生成交接文档 + 打印新会话开场白
node "$base\scripts\handoff.mjs" --verify --doc <交接文档路径>   # 机械自检（补完 FILL 后必跑）
node "$base\scripts\handoff.mjs" --portable       # 导出跨 agent 的 HANDOFF.md
```

也可以直接在对话里说「上下文快满了」「准备交接」或用 `/context-guard` 触发。

**真实运行输出**（会话持续增长，故读数略有差异；路径已替换为占位符）：

```text
CTX 20.5% | 205k/1.00M | level=ok(new) | warn@70% | critical@90% | turns=3 | steps=121 | perStep~2k
session=session-cfe3d2b4-**** model=deepseek-official/deepseek-flash window=session(request/context)
anchor=usage:205k@seq673 +delta~0 (267 surface nodes)
log=<DSH_HOME>\sessions\<项目目录键>\<会话id>\session.v3.jsonl.zstd
```

越过提醒线时多输出一段提醒块：

```text
CTX 81.3% | 208k/256k | level=warn(new) | warn@70% | critical@90% | turns=3 | steps=123 | perStep~2k | ~14stepsToCritical

⚠ 上下文已用 81.3%（208k/256k），超过提醒线 70%。
   按当前增速（约 2k/步）距临界线（90%）约还有 14 步（≈1 个回合）。
   建议：只收尾当前这一步，不再开新战线；准备交接时运行 handoff 脚本（见 SKILL.md "交接"一节）。
```

## 阈值配置（四层，后者覆盖前者）

| 层 | 位置 | 例子 |
| --- | --- | --- |
| 1 技能默认 | 本目录 `config.json` | `{"warnAt": 0.7, "criticalAt": 0.9}` |
| 2 工作区 | `<工作区>/.agents/context-guard.json`（只写要改的字段） | `{"warnAt": 0.6}` |
| 3 环境变量 | `DSH_CTX_WARN` / `DSH_CTX_CRITICAL` / `DSH_CTX_WINDOW` / `DSH_CTX_HANDOFF_DIR` / `DSH_CTX_NO_STATE` | `$env:DSH_CTX_WARN="65%"` |
| 4 命令行 | `--warn` / `--critical` / `--window` | `--window 200000` |

阈值写法：`0.7` 或 `70%` = 占窗口比例；`700000` = 绝对 token 数。`contextWindow: null` 表示跟随日志里 provider 声明的窗口。

## 交接工作流

1. 越线时运行 `node scripts/handoff.mjs`，它会写出 `<工作区>/.agents/handoff/<时间>-<会话>.md`，并在终端打印"开场白"。
2. 模型补齐文档里的 `<!-- FILL -->` 段：目标与验收、已完成与验证方式、关键决策与约束、踩过的坑、下一步、验证命令。
3. 把开场白粘贴到**新会话**发送：

```text
/context-guard 接续上一个会话的工作：<会话标题>
交接文档：.agents/handoff/2026-09-27-09-23-46-cfe3d2b4.md
先完整读它，再按 §7「下一步」第 1 条开始动手；§3/§5 里已完成的工作不要重做，§6 里失败过的做法不要重复。
动手前先跑一次 node "<技能目录>\scripts\context-usage.mjs" 确认余量；之后每个回合开头各跑一次。
```

文档留在磁盘、对话里只出现路径——这正是省上下文的关键。开场白首行的 `/context-guard` 会让新会话自动加载同一套协议。

## 交接自检（为什么必须跑）

会话给自己的交接打分一定会及格，**grep 不会**。所以补完 `<!-- FILL -->` 之后必须自检：

```powershell
node "$base\scripts\handoff.mjs" --verify --doc "<交接文档路径>"
```

它只做笨而硬的检查，因此说服不了：

| 检查 | 失败时的样子 |
| --- | --- |
| 没有遗留 `<!-- FILL -->` | `仍有 6 处 <!-- FILL … --> 未补` |
| 11 个章节齐全 | `缺: ## 9. 验证命令` |
| §10 有可复制的开场白代码块 | `未找到符合格式的代码块` |
| **每条决策都能在载体文件里 grep 到** | `grep 不到「export const X」（src/a.js）` |
| 交接链 `previous` 可解析 | `指向的文件不存在: …` |
| §7 有编号步骤、§9 有验证命令 | `没有编号步骤` / `内容为空` |

退出码 `0` 通过、`1` 不通过、`2` 用法错误——可以直接当流水线门禁（`--json` 给机器读）。

真实输出：

```text
交接文档自检: .agents/handoff/2026-09-27-10-24-58-cfe3d2b4.md

  PASS  没有遗留 FILL 占位                ok
  PASS  11 个章节齐全                    ok
  PASS  §10 有可复制的开场白代码块          ok
  PASS  决策落盘表已填写                    2 条
  PASS  决策 #1「表面类型集合是测量的唯一入口」  已在 scripts/lib/measure.mjs 中 grep 到
  PASS  交接链上一棒可解析                   → .agents/handoff/…-hop1.md
  PASS  §7 有可执行步骤                   3 条
  PASS  §9 有验证命令                    ok

结论: 通过（可以把这个开场白交给新会话）
```

## 链式接力

每份交接文档头部写着自己的位置：

```yaml
---
kind: context-guard-handoff
chain: session-cfe3d2b4-…     # 同一条链的稳定 id
hop: 2                        # 第几棒
previous: .agents/handoff/2026-…-cfe3d2b4.md
created: 2026-09-27 10:24:58
---
```

配合交接目录里的 `LATEST`（无扩展名的稳定指针，指向最新一棒）：
新会话**不必猜**文档在哪；需要更早的来龙去脉时按 `previous` 往回走，但协议明确要求
**只在缺信息时回读、不要通读全链**（通读全链等于把省下的上下文又烧回去）。

## 跨 agent 交接

换 agent（Claude Code / Codex / Cursor）时：

```powershell
node "$base\scripts\handoff.mjs" --portable     # 默认写 <工作区>/HANDOFF.md
```

它把同一份交接转成**环境无关**的版本：剥掉 DSH 专属的 `DSH home` / 会话日志路径 / 自查命令，
换成中性说明，并给出任何 agent 都能照做的开场白：

```text
读 HANDOFF.md，接着上一个会话的工作：<标题>
先看 §1 目标、§7 下一步、§8 环境事实，然后从 §7 第 1 条开始动手。
§3/§5 里已完成的工作不要重做；§6 里失败过的做法不要重复；完成后按 §9 的验证命令自检。
需要更早的来龙去脉时，按文件头部 `previous` 指针沿交接链回读，不要通读全链。
```

## 全自动提醒（hook，可选）

`hooks/dsh-context-guard-hook.mjs` 把"提醒"从**靠模型自觉**变成**确定性注入**：

| 事件 | 行为 |
| --- | --- |
| `SessionStart` | 注入「当前占用 + 最新交接文档指针 + 续接须知」，新会话开口前就知道自己在哪 |
| `UserPromptSubmit` | **只在等级新越线时**注入提醒块；平时完全静默 |
| 其它事件 / 坏 JSON / 测不到会话 | 一律安静退出 0——绝不影响会话 |

⚠️ **默认不会生效**：DSH 的 Web 组合没有挂载 Claude-Code 兼容的 hook 桥。启用需要两步（见
`hooks/cordis-snippet.yml` 与 `hooks/hooks.example.json`）：

```yaml
# 组合配置里加一行，然后重启 DSH
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ./.claude/hooks.json
```

没挂载时技能照协议 A 工作，两者不冲突。

## 目录结构

```text
context-guard/
├── SKILL.md                 技能协议（模型加载的指令：监控节奏、阈值、交接与续接、自检、token 纪律）
├── config.json              默认配置（warnAt 0.7 / criticalAt 0.9 / windowFallback 128000 …）
├── README.md                本文件（项目入口）
├── README.zh.md             完整文档：安装、配置、10 组输入输出示例、FAQ、实现细节
├── hooks/                   可选：确定性注入（默认未挂载 hook 桥，见上文）
│   ├── dsh-context-guard-hook.mjs  SessionStart / UserPromptSubmit 两个事件共用一个脚本
│   ├── hooks.example.json          hooks 桥的配置示例
│   └── cordis-snippet.yml          把它挂进 DSH 组合的片段
└── scripts/
    ├── context-usage.mjs    测量 + 阈值判断 + 状态去重（CLI）
    ├── handoff.mjs          交接文档 / 自检 / 跨 agent 导出（CLI）
    └── lib/
        ├── cli.mjs          参数解析（唯一参数声明源，未知参数直接报错）
        ├── session-log.mjs  多帧 zstd 会话日志解析、会话定位、路径编码
        ├── measure.mjs      配置四层合并、日志折叠、占用测量、阈值换算
        └── verify.mjs       交接文档的机械自检（FILL / 章节 / 决策 grep / 链指针）
```

运行时会在技能目录之外生成两类文件：提醒状态（`$DSH_HOME/storages/context-guard/…`）与交接文档（`<工作区>/.agents/handoff/…`）。

## 已知限制

- 测量最多**落后一个 step**：DSH 会话日志按批落盘，正在进行的这一步尚未计入。
- 窗口来自 provider 声明，**不等于实际安全额度**；不同模型/路由可用量不同，用 `--window` 校准成你信任的值。
- 没有 provider 用量锚点时（例如全新会话）退回启发式估算，输出会标 `approx`。
- "提醒"由模型按技能协议在每回合开头执行；想要**确定性**注入则用 `hooks/`（脚本已自测，但需要你把 hook 桥挂进组合配置，默认未挂载）。
- 交接自检查的是**机械可验证的部分**（FILL、章节、决策能否 grep 到、链指针）；它不能判断"这个下一步是否明智"——那仍是你和模型的事。
- 交接文档的质量取决于模型补写的 `<!-- FILL -->` 段；事实段（最近对话、产物、环境）是自动采集的。

## 详细文档

安装细节、四层配置说明、**8 组真实输入输出示例**、常见问题与实现原理见 **[README.zh.md](README.zh.md)**。

## 命名与同类项目

GitHub 上已有同名项目（如 [`Michel-Johnson/Context-Guard-Skill`](https://github.com/Michel-Johnson/Context-Guard-Skill) —— 那是"把项目当工作台"的多会话协作层），另有 `context-guardian-skill` 等近似命名。为了可发现性，**仓库名用 `dsh-context-guard`**，而**技能名仍是 `context-guard`**：你手敲的触发词 `/context-guard` 与安装目录名都不变。

与同类工具（多为 Claude Code 生态的"交接文档生成器"，如 `REMvisual/claude-handoff`、`Jordanwei1/jiaojie-skill`、`wilbeibi/catchup`、`Socialpranker/handoff-skill`）最大的差别：**本工具自己测量真实占用**——直接解析 DSH 会话日志里 provider 上报的 `usage.totalTokens`。Claude Code 有原生 `/context` + statusline + auto-compact，所以那边的技能通常只写文档、不测量；DSH 没有这层，于是测量也必须自己做。

本工具明确**不做**：上下文瘦身/剪枝（那是 `cozempic` 一类的路线）、跨 agent 的会话 fork（那是 `catchup` 的路线）、模型调用与自动压缩。

## 许可证

MIT，见 [LICENSE](LICENSE)。
