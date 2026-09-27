# context-guard —— DSH 上下文守门与会话交接技能

一个给 DeepSeek Harness（DSH）用的本地技能：**在上下文塞满之前提醒你，并把工作无缝交接给新会话。**

本文件夹就是完整的技能包——纯 Node 脚本，无第三方依赖、无构建、无安装脚本；复制文件夹即完成安装。

---

## 一、这个项目解决什么问题

| 痛点 | 现状 | 本技能的做法 |
| --- | --- | --- |
| **长会话失能** | 上下文膨胀后模型开始丢内容、截断、甚至停止输出；你只能凭感觉猜"是不是快满了" | 直接从 DSH 会话日志读出**真实占用**（provider 上报的 token 数），到线就提醒 |
| **阈值因人而异** | 不同模型/路由的安全额度不同，"70%" 对某些人是太晚、对另一些人是太早 | 提醒线/临界线可配置，四种改法（技能默认 → 工作区 → 环境变量 → 命令行） |
| **换会话要重讲** | 新会话从零开始，得把目标、决策、踩过的坑再讲一遍，既费时又费上下文 | 一条命令生成交接文档（事实自动采集）＋ 一段开场白，粘贴即续接，且不再重蹈覆辙 |

**它不做什么**：不压缩历史、不删内容、不改会话、不做自动摘要、不调用模型。它只**测量、提醒、交接**。

---

## 二、主要功能

1. **真实占用测量**：取日志里最近一条 `assistant/message` 的 provider `usage.totalTokens`（该次请求的完整 prompt＋输出）作为锚点，再加上锚点之后新增内容的启发式增量；窗口取自日志的 `request/context.contextWindow`。全新会话没有用量时退回启发式估算，并明确标注 `approx`。
2. **两级阈值提醒**：`warn` / `critical` 两级，越线时输出固定的中文提醒块（含"按当前增速还差多少步/回合到临界线"）。
3. **提醒不刷屏**：按「会话 + 等级」落盘去重，同一等级只提醒一次；`--force` 强制再提醒，`--reset-state` 重新计数。
4. **交接文档生成**：自动采集最近人类消息、助手最后的文字产出、最近工具动作、会话里的待办列表、交付物、本会话写过的文件、git 分支/HEAD、模型与窗口、日志路径；判断性段落留 `<!-- FILL -->` 给模型补。
5. **新会话开场白**：一段可直接粘贴的文本，首行含 `/context-guard` 触发词，新会话会自动加载同一套协议，不需要你再解释规则。
6. **配置四层覆盖**：技能默认 → 工作区文件 → 环境变量 → 命令行参数。
7. **跨沙箱可用**：只读文件系统，不依赖 git、不依赖子进程、不联网。git 不可用时改从 `.git/HEAD` 与 refs 读分支/HEAD，并提示你自行补改动清单。
8. **可自动化**：`--json` 输出结构化结果；`--exit-code` 让 warn→10、critical→20，便于包进脚本或未来的 hook。
9. **自检式报错**：找不到会话、Node 缺 zstd 支持、参数写错，都会给出明确中文提示与退出码 2，而不是抛出难懂的堆栈。
10. **交接自检（`--verify`）**：机械校验交接文档——FILL 是否补完、章节是否齐全、**每条决策能否在其载体文件里 grep 到**、链指针是否可解析、§7/§9 是否为空。退出码 0/1，可当流水线门禁。
11. **链式接力**：文档头带 `chain` / `hop` / `previous`，交接目录里维护 `LATEST` 稳定指针；协议要求"只在缺信息时按指针回读，不通读全链"。
12. **跨 agent 导出（`--portable`）**：生成环境无关的 `HANDOFF.md`（剥掉 DSH 专属路径与命令），可直接交给 Claude Code / Codex / Cursor。
13. **确定性 hook（可选）**：`hooks/` 提供 SessionStart（注入占用 + 最新交接指针）与 UserPromptSubmit（仅新越线时提醒）；任何异常都静默退出 0，绝不打断会话。默认未挂载 hook 桥，需改组合配置。

---

## 三、安装方法

### 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | 需要内置 zlib 的 Zstandard 解压（`zstdDecompressSync`），该 API 自 [Node.js 22.15.0](https://nodejs.org/zh-tw/blog/release/v22.15.0) / 23.8.0 起提供；建议 24 LTS 及以上。本技能在 **v26.7.0** 上实测。版本过低时脚本会明确报错并说明原因。 |
| DSH | 需要能读到 DSH 的会话日志（`$DSH_HOME/sessions/`）。非 DSH 环境可用 `--log` 指向任意 `.jsonl` / `.jsonl.zstd`。 |
| 依赖 | **无**。不需要 `npm install`，不需要联网，不需要 git。 |

### 安装步骤

技能是「目录包」，DSH 会扫描 `<根>/<名字>/SKILL.md`。把整个 `context-guard` 文件夹放到任意一个根下即可：

| 放置位置 | 适用范围 | 说明 |
| --- | --- | --- |
| `<项目>/.agents/skills/context-guard/` | 只在某个仓库生效 | 本机当前就是这里（项目根 = 最近的 `.git` 祖先） |
| `~/.dsh/skills/context-guard/` | 该 DSH 安装的所有项目 | 用户级，DSH 主目录下 |
| `~/.agents/skills/context-guard/` | 遵循 `~/.agents` 约定的所有 agent | 用户级共享 |

```powershell
# 例：复制到项目级（Windows）
$src = "<当前技能目录>"
$dst = "<目标仓库>\.agents\skills"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item $src $dst -Recurse
```

**无需重启 DSH**：技能目录被监听，新增/改名/删除会自动进入下一轮的技能目录（本机已实测：写入后立刻出现在可用技能列表里）。

### 验证安装

```powershell
$base = "<放置位置>\context-guard"

# 1) 脚本可用（应打印中文帮助）
node "$base\scripts\context-usage.mjs" --help

# 2) 能读到当前会话（应打印一行 CTX …）
node "$base\scripts\context-usage.mjs"
```

在对话里说「上下文快满了」「/context-guard」也能触发（技能已进入模型可见目录）。

### 卸载

删掉那个 `context-guard` 文件夹即可。若还想清掉状态文件：

```powershell
Remove-Item "$env:DSH_HOME\storages\context-guard" -Recurse -Force
```

---

## 四、使用方法

### 方式 A：对话触发（推荐）

对模型说这些话之一即可，它会加载本技能并按其协议工作：

- `/context-guard`
- 「看看上下文用了多少 / 快到阈值了吗」
- 「上下文快满了，准备交接」
- 「开个新会话接着做」

### 方式 B：直接跑命令

```powershell
$base = "<放置位置>\context-guard"

node "$base\scripts\context-usage.mjs"          # 一行摘要；越线时附中文提醒块
node "$base\scripts\context-usage.mjs" --json    # 完整 JSON（自动化用）
node "$base\scripts\handoff.mjs"                 # 生成交接文档 + 打印新会话开场白
```

两个脚本的 `--help` 是**权威参数表**（README 与它一致）。常用参数：

| 参数 | 适用于 | 作用 |
| --- | --- | --- |
| `--session <id>` / `--log <path>` | 两者 | 指定会话 id 或直接指定日志文件 |
| `--cwd <dir>` / `--dsh-home <dir>` | 两者 | 工作区与 DSH 主目录（默认 `$DSH_HOME` 或 `~/.dsh`） |
| `--warn <n>` / `--critical <n>` / `--window <n>` / `--window-fallback <n>` | 两者 | 阈值与窗口覆盖 |
| `--no-state` / `--reset-state` / `--force` | context-usage | 不读状态 / 重置状态 / 强制再次提醒 |
| `--quiet` / `--json` / `--exit-code` | context-usage | 只输出一行 / 输出 JSON / warn→10、critical→20 |
| `--out <path>` / `--title <t>` / `--handoff-dir <dir>` | handoff | 文档路径、标题、目录 |
| `--stdout` / `--json` | handoff | 只打印文档不写文件 / 只输出采集到的事实 |

### 阈值怎么改（四层，后者覆盖前者）

| 层 | 位置 | 例子 |
| --- | --- | --- |
| 1 技能默认 | 本目录 `config.json` | `{"warnAt": 0.7, "criticalAt": 0.9}` |
| 2 工作区 | `<工作区>/.agents/context-guard.json`（只写要改的字段） | `{"warnAt": 0.6}` |
| 3 环境变量 | `DSH_CTX_WARN` / `DSH_CTX_CRITICAL` / `DSH_CTX_WINDOW` / `DSH_CTX_HANDOFF_DIR` / `DSH_CTX_NO_STATE` | `$env:DSH_CTX_WARN="65%"` |
| 4 命令行 | `--warn` / `--critical` / `--window` | `--window 200000` |

阈值写法：`0.7` 或 `70%` = 占窗口比例；`700000` = 绝对 token 数。`contextWindow: null` 表示跟随日志里 provider 声明的窗口。

### 交接 → 续接的完整流程

1. **触发**：到临界线时模型提示你，或你直接说「准备交接」。
2. **生成**：`node "$base\scripts\handoff.mjs"` → 写出 `<工作区>/.agents/handoff/<时间>-<会话>.md`，并在终端打印开场白。
3. **补全**：模型用 `read` + `edit` 补齐文档里的 `<!-- FILL -->` 段（目标与验收、已完成与验证方式、关键决策、踩过的坑、下一步、验证命令）。
4. **接力**：把开场白粘贴到**新会话**发送。新会话会自动加载本技能协议，读交接文档，从 §7「下一步」第 1 条开始，不重做已完成项、不重复失败尝试。

### 输出转述纪律（省 token）

`level=ok` 不播报；`warn`/`critical` 且首次出现时，原样转述脚本的中文提醒块；不要把 `--json` 结果贴进对话；不要把整篇交接文档贴进对话——只给路径和开场白。

---

## 五、输入输出示例

以下输出均为**本机真实运行结果**（会话 `session-cfe3d2b4-…`，模型 `deepseek-official/deepseek-flash`，窗口 1,000,000）。示例 1–4 是同一次会话的连续运行；会话在持续增长，所以占用值逐次略有上升。

> 为保护隐私，示例中的本机路径已替换为占位符：`<DSH_HOME>`（DSH 主目录）、`<工作区>`（项目目录）、`<技能目录>`（本技能所在目录）、`%TEMP%`（临时目录）。数字、等级、字段与结构均与真实输出一致。

### 示例 1：正常（默认阈值）

**输入**

```powershell
node "$base\scripts\context-usage.mjs"
```

**输出**

```text
CTX 20.5% | 205k/1.00M | level=ok(new) | warn@70% | critical@90% | turns=3 | steps=121 | perStep~2k
session=session-cfe3d2b4-036e-4a6a-a030-4f1db5b4981e model=deepseek-official/deepseek-flash window=session(request/context)
anchor=usage:205k@seq673 +delta~0 (267 surface nodes)
log=<DSH_HOME>\sessions\<项目目录键>\<会话id>\session.v3.jsonl.zstd
```

读法：占用 20.5%；窗口来自日志；压力由 provider 用量锚点（205k，位于 seq 673）＋锚点后增量（约 0）构成。

### 示例 2：越过提醒线

**输入**（用 `--window` 把窗口压到 256k 以演示；默认走日志声明的窗口）

```powershell
node "$base\scripts\context-usage.mjs" --window 256000
```

**输出**

```text
CTX 81.3% | 208k/256k | level=warn(new) | warn@70% | critical@90% | turns=3 | steps=123 | perStep~2k | ~14stepsToCritical
session=session-cfe3d2b4-036e-4a6a-a030-4f1db5b4981e model=deepseek-official/deepseek-flash window=config
anchor=usage:208k@seq683 +delta~0 (271 surface nodes)
log=<DSH_HOME>\sessions\<项目目录键>\<会话id>\session.v3.jsonl.zstd

⚠ 上下文已用 81.3%（208k/256k），超过提醒线 70%。
   按当前增速（约 2k/步）距临界线（90%）约还有 14 步（≈1 个回合）。
   建议：只收尾当前这一步，不再开新战线；准备交接时运行 handoff 脚本（见 SKILL.md “交接”一节）。
```

### 示例 3：越过临界线，并用退出码接入自动化

**输入**

```powershell
node "$base\scripts\context-usage.mjs" --window 218000 --exit-code
```

**输出**（进程退出码 = 20）

```text
CTX 95.4% | 208k/218k | level=critical(new) | warn@70% | critical@90% | turns=3 | steps=123 | perStep~2k | ~0stepsToCritical
session=session-cfe3d2b4-036e-4a6a-a030-4f1db5b4981e model=deepseek-official/deepseek-flash window=config
anchor=usage:208k@seq683 +delta~0 (271 surface nodes)
log=<DSH_HOME>\sessions\<项目目录键>\<会话id>\session.v3.jsonl.zstd

🛑 上下文已用 95.4%（208k/218k），超过临界线 90%。
   继续在本会话推进有丢失输出的风险。现在应该：
   1) 先写交接文档（scripts/handoff.mjs），2) 把交接开场白交给用户，3) 在新会话继续。
```

退出码约定：默认恒为 0；加 `--exit-code` 后 warn→10、critical→20、用法/读取错误→2。

### 示例 4：`--json`（真实全量输出）

```json
{
  "ok": true,
  "sessionId": "session-cfe3d2b4-036e-4a6a-a030-4f1db5b4981e",
  "title": "上下文阈值提醒与会话交接技能",
  "cwd": "<工作区>",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "logPath": "<DSH_HOME>\\sessions\\<项目目录键>\\<会话id>\\session.v3.jsonl.zstd",
  "logVia": "direct",
  "level": "ok",
  "levelIsNew": false,
  "announce": false,
  "percent": 20.9,
  "ratio": 0.2094,
  "pressureTokens": 209424,
  "window": 1000000,
  "windowSource": "session(request/context)",
  "remainingTokens": 790576,
  "warnAt": 0.7,
  "criticalAt": 0.9,
  "warnTokens": 700000,
  "criticalTokens": 900000,
  "turns": 3,
  "steps": 124,
  "tokensPerStep": 1689,
  "stepsToCritical": 409,
  "turnsToCritical": 10,
  "method": "usage-anchor",
  "approximate": false,
  "anchorStale": false,
  "surfaceNodes": 273,
  "stateFile": "<DSH_HOME>\\storages\\context-guard\\<工作区键>-<会话id>.json"
}
```

字段说明：`levelIsNew=false` / `announce=false` 表示该等级此前已提醒过（状态去重生效）；`logVia` 是日志定位方式（`direct` 直接命中，`id-scan` / `deep-scan` / `newest` 为回退查找）；`method` 与 `approximate` 说明数字来自 provider 用量锚点还是启发式估算。

### 示例 5：生成交接文档

**输入**

```powershell
node "$base\scripts\handoff.mjs"
```

**输出**

```text
交接文档已写入: <工作区>\.agents\handoff\2026-09-27-09-23-46-cfe3d2b4.md
（自动采集部分已填好；请用 edit/write 补齐 §1 §3 §4 §6 §7 §9 的 FILL 段落）

把下面这段复制到新会话:
----------8<----------
/context-guard 接续上一个会话的工作：上下文阈值提醒与会话交接技能
交接文档：.agents/handoff/2026-09-27-09-23-46-cfe3d2b4.md
先完整读它，再按 §7「下一步」第 1 条开始动手；§3/§5 里已完成的工作不要重做，§6 里失败过的做法不要重复。
动手前先跑一次 node "<技能目录>\scripts\context-usage.mjs" 确认余量；之后每个回合开头各跑一次。
----------8<----------
```

**生成的文档骨架**（11 节，与真实模板一致）

```text
# 交接：<会话标题>
| 生成时间 | 上一会话 | 工作目录 | 模型 | 交接时上下文 | 会话规模 |
## 0. 新会话怎么用这份文档            （自动）
## 1. 目标与验收标准                  （FILL）
## 2. 当前状态（自动采集）
## 3. 已完成 / 已验证                 （FILL + 自动待办列表）
## 4. 关键决策与约束                  （FILL）
## 5. 产物与文件（自动采集）
## 6. 踩过的坑 / 不要重复尝试         （FILL）
## 7. 下一步（按顺序）                 （FILL + 自动未完成待办）
## 8. 环境事实（自动采集）
## 9. 验证命令                        （FILL）
## 10. 给新会话的开场白（复制下面整段）（自动）
```

**§2 的真实片段**（注意：只含真实人类消息与助手可见文字，不含 reasoning、不含技能目录注入）：

```text
## 2. 当前状态（自动采集）
最近的人类消息（由旧到新；已排除插件/技能目录注入）：
- (seq 9) 我最近苦于使用agent时上下文过多导致的模型停止输出，帮我写一个skill，要做到能够提醒用户上下文达到阈值，最好阈值也能够自定义，同时给出新会话的交接方案，做到复制交接方案到新会话后能够无缝衔接工作
- (seq 475) 请完善项目根目录的README.md，确保包含: 1.项目解决什么问题 2.主要功能 3.安装方法 4.使用方法 5.输入输出示例 README必须与项目真实功能一致
- (seq 526) 不对不对，将现在你做的skill先打包进一个文件夹，再完善文件夹目录的README.zh.md，确保包含: 1.项目解决什么问题 2.主要功能 3.安装方法 4.使用方法 5.输入输出示例 README必须与项目真实功能一致

助手最后的文字产出（不含推理与工具调用）：
- (seq 668) 所有参数与行为都已核实。现在写这个文件夹的 README.zh.md。
- (seq 673) README 里的示例必须与真实输出逐字一致。…
```

### 示例 6：在新会话续接

把 `----------8<----------` 之间的四行粘进新会话后，新会话的行为是：

```text
1. /context-guard 触发词 → DSH 自动把本技能协议注入该步（无需模型再调 skill 工具）
2. read .agents/handoff/2026-09-27-09-23-46-cfe3d2b4.md
3. 跑一次 context-usage.mjs 确认余量
4. 只读文档点名要补读的文件，从 §7 第 1 条开始施工
```

### 示例 7：测任意日志（非 DSH 会话 / 历史会话）

`--log` 同时支持压缩日志与**纯 JSONL**（导出的、手写的都行）；没有 provider 用量时会自动退回启发式并标 `approx`：

```powershell
node "$base\scripts\context-usage.mjs" --log "$env:TEMP\fx2.jsonl" --window-fallback 50000
```

```text
CTX 0% | 23/50k | level=ok(new) | warn@70% | critical@90% | turns=0 | steps=0 | approx(heuristic-surface)
session=session-fx2 model=?/? window=windowFallback
heuristic surface~23 + tools~0
log=%TEMP%\fx2.jsonl
```

### 示例 8：出错时

```powershell
node "$base\scripts\context-usage.mjs" --verbose      # 未知参数
# context-guard: 未知参数 --verbose   （随后打印完整 --help）
# 退出码 2

node "$base\scripts\context-usage.mjs" --session no-such-session
# context-guard: no DSH session log found for session id "no-such-session". Pass --log <path> or --session <id>, or set DSH_SESSION_ID.
# 退出码 2
```

---

### 示例 9：交接自检（`--verify`）

**输入**

```powershell
node "<base>\scripts\handoff.mjs" --verify --doc "<交接文档路径>"
```

**通过时（退出码 0）**

```text
交接文档自检: <交接文档路径>

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

**不通过时（退出码 1，逐条指出问题）**

```text
  FAIL  没有遗留 FILL 占位                     仍有 6 处 <!-- FILL … --> 未补
  FAIL  决策落盘表已填写                       §4 里没有可解析的表格行（需要 | 决策 | 载体文件 | 可 grep 的证据 |）
  FAIL  §7 有可执行步骤                        没有编号步骤
  FAIL  §9 有验证命令                         内容为空
结论: 不通过（4 项失败；补完再跑一次）
```

### 示例 10：跨 agent 交接包（`--portable`）

**输入**

```powershell
node "<base>\scripts\handoff.mjs" --portable
```

**输出**

```text
跨 agent 交接包已写入: <工作区>\HANDOFF.md
交接链: chain session-cfe3d2b4-… 第 1 棒（链首）
（事实段已自动填好；判断段仍带 <!-- FILL -->，补完后用 --verify --doc 该文件 自检）

把下面这段交给目标 agent（Claude Code / Codex / Cursor 均可）:
----------8<----------
读 HANDOFF.md，接着上一个会话的工作：上下文阈值提醒与会话交接技能
先看 §1 目标、§7 下一步、§8 环境事实，然后从 §7 第 1 条开始动手。
§3/§5 里已完成的工作不要重做；§6 里失败过的做法不要重复；完成后按 §9 的验证命令自检。
需要更早的来龙去脉时，按文件头部 `previous` 指针沿交接链回读，不要通读全链。
----------8<----------
```

生成的文件与 DSH 版结构一致，但已换成中性措辞——实测这三处在交接包里**消失**，便于别的 agent 阅读：

```text
「- DSH home:」   0 次
「- 会话日志:」    0 次
DSH 专属自查命令行  已被替换为「若目标环境装了 context-guard 技能…否则忽略本行」
```

## 六、进阶能力

### 6.1 交接自检 `--verify`

会话给自己的交接打分一定会及格，**grep 不会**。补完 `<!-- FILL -->` 后必须自检：

```powershell
node "<base>\scripts\handoff.mjs" --verify --doc "<交接文档路径>"
```

检查项（全机械，说服不了）：FILL 是否补完 / 11 节是否齐全 / §10 开场白是否以 `/context-guard` 开头 /
**§4 决策表每条能否在「载体文件」里 grep 到「证据」** / 链指针 `previous` 是否可解析 / §7 是否有编号步骤 / §9 是否有内容。
退出码 0 通过、1 不通过、2 用法错误；`--json` 给机器读。

§4 的表格格式（模板只给表头与分隔行；一行都不填就报「没有可解析的表格行」）：

```markdown
| 决策 | 载体文件 | 可 grep 的证据 |
| --- | --- | --- |
| 表面类型集合是测量的唯一入口 | scripts/lib/measure.mjs | `export const SURFACE_TYPES` |
```

### 6.2 链式接力

文档头写入位置信息：

```yaml
chain: session-cfe3d2b4-…     # 同一条链的稳定 id
hop: 2                        # 第几棒
previous: .agents/handoff/2026-…-cfe3d2b4.md
```

在同一目录再跑一次 `handoff.mjs` 会自动继承 chain、hop+1、填好 previous，并刷新 `LATEST` 指针。
协议要求：**只在真的缺信息时按 `previous` 回读**，不要通读全链——通读全链等于把省下的上下文又烧回去。

### 6.3 跨 agent 交接 `--portable`

```powershell
node "<base>\scripts\handoff.mjs" --portable     # 默认写 <工作区>/HANDOFF.md
```

剥掉 DSH 专属内容（`DSH home`、会话日志路径、自查命令），换成中性说明与任何 agent 都能照做的开场白；
`--portable` 是对当前状态的**导出**，不占交接链的新一棒。

### 6.4 确定性 hook（需改组合配置）

`hooks/dsh-context-guard-hook.mjs` 一个脚本服务两个事件，实测行为：

| 场景 | 行为 |
| --- | --- |
| `SessionStart` | 注入「当前占用 + 最新交接文档指针 + 续接须知」 |
| `UserPromptSubmit` 未越线 | 完全静默（实测输出 0 字符） |
| `UserPromptSubmit` 新越线 | 注入 `⚠` / `🛑` 提醒块 |
| 空 payload / 未知事件 / 坏 JSON | 安静退出 0，不影响会话 |

启用：把 `@deepseek-ai/dsh-hooks-claude-code` 挂进组合并指向 `hooks/hooks.example.json`（片段见 `hooks/cordis-snippet.yml`），然后重启 DSH。
**默认未挂载**，此时技能仍按协议 A 的自觉检查工作。

### 6.5 命名说明

GitHub 上已有同名项目（[`Michel-Johnson/Context-Guard-Skill`](https://github.com/Michel-Johnson/Context-Guard-Skill) 是"把项目当工作台"的多会话协作层），另有 `context-guardian-skill` 等近似命名。
因此**仓库名用 `dsh-context-guard`**，而**技能名仍是 `context-guard`**：触发词 `/context-guard` 与安装目录名都不变。

## 附录 A：文件清单

```text
dsh-context-guard/                 ← 本文件夹即完整技能包（技能名仍是 context-guard）
├── SKILL.md                       技能协议（模型加载的指令：节奏、阈值、交接与续接、自检、token 纪律）
├── config.json                    默认配置（warnAt 0.7 / criticalAt 0.9 / windowFallback 128000 …）
├── README.md                      项目入口（GitHub 首页）
├── README.zh.md                   本文件（完整文档）
├── hooks/                         可选：确定性注入（默认未挂载 hook 桥）
│   ├── dsh-context-guard-hook.mjs SessionStart / UserPromptSubmit 共用一个脚本
│   ├── hooks.example.json         hooks 桥配置示例
│   └── cordis-snippet.yml         挂进 DSH 组合的片段
└── scripts/
    ├── context-usage.mjs          测量 + 阈值判断 + 状态去重（CLI）
    ├── handoff.mjs                交接文档 / 自检 / 跨 agent 导出（CLI）
    └── lib/
        ├── cli.mjs                参数解析（唯一参数声明源，未知参数直接报错）
        ├── session-log.mjs        多帧 zstd 会话日志解析、会话定位、路径编码
        ├── measure.mjs            配置四层合并、日志折叠、占用测量、阈值换算
        └── verify.mjs             交接文档的机械自检（FILL / 章节 / 决策 grep / 链指针）
```

运行时会额外产生三类文件（都不在技能目录内）：

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| 提醒状态 | `$DSH_HOME/storages/context-guard/<工作区键>-<会话id>.json` | 记录上次等级，避免同一等级重复提醒 |
| 交接文档 | `<工作区>/.agents/handoff/<时间>-<会话id前8位>.md` | 可改到别处（配置 `handoffDir` 或 `--handoff-dir`） |
| 稳定指针 | 交接目录里的 `LATEST`（无扩展名） | 指向最新一棒，供 hook 与新会话直接定位 |

## 附录 B：配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `contextWindow` | `null` | `null` = 跟随日志里 provider 声明的窗口；写数字则强制覆盖 |
| `warnAt` | `0.7` | 提醒线：比例（≤1）或绝对 token 数（>1） |
| `criticalAt` | `0.9` | 临界线：同上 |
| `windowFallback` | `128000` | 日志里没有窗口信息时使用的窗口 |
| `handoffDir` | `.agents/handoff` | 交接文档目录（相对工作区；绝对路径也可） |
| `announceOnce` | `true` | 同一等级只提醒一次；`false` 则每次越线都提醒 |
| `writeState` | `true` | 是否写提醒状态文件 |

## 附录 C：常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `no DSH session log found` | 不在 DSH 会话里或 id 未知：用 `--session <id>` / `--log <path>`，或设置 `DSH_SESSION_ID` |
| `当前 Node … 不提供 Zstandard 解压` | Node 太旧：升级到 22.15+/23.8+（建议 24 LTS+），或 `--log` 用未压缩 `.jsonl` |
| 输出带 `approx(heuristic-surface)` | 该日志还没有 provider 用量（如全新会话），当前值由启发式估算 |
| 窗口显示 `windowFallback` | 该日志没有 `request/context` 记录，用了配置里的兜底窗口 |
| 数字比上次小 | 正常：压缩/替换会让模型可见面变小，用量锚点随之下降 |
| 提醒只出现一次 | 设计如此（`announceOnce`）；`--force` 强制再提醒，`--reset-state` 重新计数 |
| 交接文档里 §1/§4/§6/§9 是空的 | 这些是判断性内容，需要模型用 `edit` 补（协议已要求）；`--stdout` 可先看全文 |
| git 一栏只有分支/HEAD | 该环境没有 git 可执行文件或沙箱禁止子进程；脚本改从 `.git` 目录读取，并提示你自行运行 `git status --short` |
| 子代理的占用没算进去 | 子代理是独立会话与独立日志，本技能只测当前会话 |

## 附录 D：实现要点与可信度

- **日志怎么读**：DSH 会话日志是多帧 Zstandard 容器（`session.v<N>.jsonl.zstd`，首帧是会话头，后续帧是批量追加的事件）。Node 的 `zstdDecompressSync` 只解第一帧，因此脚本先按帧结构扫描（与 DSH 自身的 persistence 实现同一算法），再逐帧解压；追加写入导致的**不完整尾帧会被安全跳过**，不会报错。
- **占用怎么算**：`usage.totalTokens`（= 该次请求的 prompt＋输出）就是当时的上下文占用；这是 provider 上报值，不是估算。锚点之后新增的模型可见内容用启发式补（非 CJK 4 字符/token、CJK 0.8 token/字，另加每块结构开销）。
- **增速怎么算**：以「压力 ÷ 已完成步数」为平均每步增量，再换算到临界线还差多少步/多少回合——所以 `perStep~2k` 是这台机器上历史会话的实测均值。
- **成本**：纯本地文件读取，不联网、不调用模型。实测：本会话日志（约 0.5 MB、300+ 帧）单次检查约 **94 ms**；2.4 MB、1558 帧的历史日志约 **171 ms**（Node v26.7.0，Windows）。
- **隐私**：交接文档只采集可见文字（人类消息、助手文字回复、工具名与参数摘要、待办、交付物、写过的文件路径），**不含模型的 reasoning（思维链）**，也不含被注入的插件/技能目录上下文。

## 附录 E：已知限制

- 测量最多**落后一个 step**：日志按批落盘，正在进行的这一步尚未计入。
- 窗口来自 provider 声明，**不等于你实际的安全额度**：不同模型/路由可用量不同，用 `--window` 校准成你信任的值。
- 启发式对 CJK 与 JSON 结构仍是近似；只有带用量锚点时才是精确值。
- 「提醒」由模型按协议在每回合开头执行；若要做到完全不依赖模型自觉，需要 DSH 的 `dsh-hooks-claude-code` hook 桥（当前 Web 组合未挂载，需改组合配置才能启用）。
- 交接文档的质量取决于模型补写的 `<!-- FILL -->` 段；事实段（§2 §5 §8）是自动采集的，可直接采信。
- `--verify` 只校验**机械可验证**的部分（FILL、章节、决策能否 grep 到、链指针）；它判断不了"这个下一步是否明智"——那仍是你和模型的事。
- hook 脚本已随附并自测通过，但**默认不生效**（DSH 组合未挂载 hook 桥）；未挂载时提醒仍依赖模型按协议自觉执行。
