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

## 安装

前置条件：

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.15 / 23.8**（需要内置 zlib 的 Zstandard 解压；建议 24 LTS+，本技能在 v26.7.0 实测） |
| DSH | 需要能读到 DSH 会话日志（`$DSH_HOME/sessions/`）；非 DSH 环境可用 `--log` 指向任意 `.jsonl` / `.jsonl.zstd` |

技能是目录包，DSH 会扫描 `<根>/<名字>/SKILL.md`。把本仓库克隆到任一技能根下即可：

```powershell
# 项目级：只在这个仓库生效
git clone https://github.com/xianshengyao180-gif/context-guard .agents/skills/context-guard

# 用户级：所有项目都能用
git clone https://github.com/xianshengyao180-gif/context-guard "$env:USERPROFILE\.dsh\skills\context-guard"
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

## 目录结构

```text
context-guard/
├── SKILL.md                 技能协议（模型加载的指令：监控节奏、阈值、交接与续接、token 纪律）
├── config.json              默认配置（warnAt 0.7 / criticalAt 0.9 / windowFallback 128000 …）
├── README.md                本文件（项目入口）
├── README.zh.md             完整文档：安装、配置、8 组输入输出示例、FAQ、实现细节
└── scripts/
    ├── context-usage.mjs    测量 + 阈值判断 + 状态去重（CLI）
    ├── handoff.mjs          交接文档生成 + 开场白（CLI）
    └── lib/
        ├── cli.mjs          参数解析（唯一参数声明源，未知参数直接报错）
        ├── session-log.mjs  多帧 zstd 会话日志解析、会话定位、路径编码
        └── measure.mjs      配置四层合并、日志折叠、占用测量、阈值换算
```

运行时会在技能目录之外生成两类文件：提醒状态（`$DSH_HOME/storages/context-guard/…`）与交接文档（`<工作区>/.agents/handoff/…`）。

## 已知限制

- 测量最多**落后一个 step**：DSH 会话日志按批落盘，正在进行的这一步尚未计入。
- 窗口来自 provider 声明，**不等于实际安全额度**；不同模型/路由可用量不同，用 `--window` 校准成你信任的值。
- 没有 provider 用量锚点时（例如全新会话）退回启发式估算，输出会标 `approx`。
- "提醒"由模型按技能协议在每回合开头执行；若要做到完全不依赖模型自觉，需要 DSH 的 `dsh-hooks-claude-code` hook 桥（默认 Web 组合未挂载，需改组合配置）。
- 交接文档的质量取决于模型补写的 `<!-- FILL -->` 段；事实段（最近对话、产物、环境）是自动采集的。

## 详细文档

安装细节、四层配置说明、**8 组真实输入输出示例**、常见问题与实现原理见 **[README.zh.md](README.zh.md)**。

## 许可证

MIT，见 [LICENSE](LICENSE)。
