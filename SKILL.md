---
name: context-guard
description: >
  看住当前会话的上下文占用：接近可配置阈值时提醒用户，并生成能直接粘贴到新会话的交接文档，
  让长任务在换会话后无缝续接。触发词：上下文/context 快满、模型开始停止输出、token 超限、
  会话交接/handoff、开新会话接着做、/context-guard。
---

# context-guard —— 上下文守门 + 会话交接

## 它解决什么

长会话上下文膨胀后，模型会开始丢内容、截断、甚至停止输出。本技能只做三件事：

1. **测**：从 DSH 会话日志读出当前上下文占用的**真实**数字（不是估算感觉）。
2. **提醒**：越过可配置阈值（提醒线 / 临界线）时，用固定中文文案提醒用户。
3. **交接**：生成一份磁盘上的交接文档 + 一段开场白；用户把它粘贴到新会话即可无缝续接。

## 测量原理（为什么这个数字可信）

- 直接解析当前会话的持久化日志
  `$DSH_HOME/sessions/<项目目录键>/<会话 id>/session.v<N>.jsonl.zstd`
  （多帧 zstd 容器，脚本自己按帧结构解析，不依赖 git、不依赖任何外部命令）。
- **压力值** = 最近一条 assistant 消息里 provider 上报的 `usage.totalTokens`
  （即那次请求的完整 prompt + 生成内容）＋ 该锚点之后新增的 surface 内容的启发式增量。
- **窗口** = 日志里 `request/context.contextWindow`；日志里没有时用配置值。
- 全新会话还没有 provider 用量时，退回启发式估算，并在输出里标 `approx`。

脚本目录：本技能 `scripts/`（相对路径按 skill 加载结果给出的 base directory 解析）。

## 命令

```powershell
node "<base>/scripts/context-usage.mjs"                    # 一行摘要；越线时附提醒块
node "<base>/scripts/context-usage.mjs" --json              # 机器可读全量
node "<base>/scripts/handoff.mjs"                           # 写交接文档并打印新会话开场白
node "<base>/scripts/handoff.mjs" --verify --doc <路径>      # 机械自检（补完 FILL 后必须跑）
node "<base>/scripts/handoff.mjs" --portable                # 导出跨 agent 的 HANDOFF.md
```

路径含空格（例如 `C:\my work\...`）时必须加引号。常用参数：
`--warn 0.6 --critical 0.85 --window 128000`、`--no-state`、`--force`、`--exit-code`（warn→10，critical→20）。
`--verify` 的退出码：0 通过、1 不通过、2 用法错误——可以用在脚本里当门禁。

## 阈值自定义（逐层覆盖，后者胜）

| 层 | 位置 / 形式 | 示例 |
| --- | --- | --- |
| 1 技能默认 | `config.json` | `{"warnAt": 0.7, "criticalAt": 0.9}` |
| 2 工作区 | `<工作区>/.agents/context-guard.json`（只写要改的字段） | `{"warnAt": 0.6}` |
| 3 环境变量 | `DSH_CTX_WARN` / `DSH_CTX_CRITICAL` / `DSH_CTX_WINDOW` / `DSH_CTX_HANDOFF_DIR` / `DSH_CTX_NO_STATE` | `DSH_CTX_WARN=0.65` |
| 4 命令行 | `--warn` / `--critical` / `--window` | `--window 200000` |

阈值写法：`0.7` 或 `70%` = 占窗口比例；`700000` = 绝对 token 数。窗口留空表示跟着日志走。

## 协议 A —— 监控节奏

- 加载本技能后**立刻**测一次。
- 之后**每个回合的第 1 步**测一次；同一个回合内若已调用工具 ≥ 8 次，再测一次。
- 每个 step 最多测一次，不要为了“确认”反复测。
- 报告规则（这是省 token 的关键）：

| 脚本结果 | 你要做的 |
| --- | --- |
| `level=ok` | **不要播报**（用户主动问状态时除外） |
| `level=warn` 且 `levelIsNew=true` | 把脚本输出的 `⚠ …` 提醒块**原样**转述给用户（它已是中文），不要改写、不要复述 JSON |
| `level=critical` 且 `levelIsNew=true` | 播报 `🛑 …` 提醒块，**立刻**执行协议 B |
| 重复的 warn/critical（`levelIsNew=false`） | 不重复播报；除非用户正在展开明显更大的工作 |

## 协议 B —— 交接（warn 后就准备，critical 必做）

1. 运行 `node "<base>/scripts/handoff.mjs"`。它会：写交接文档到 `<工作区>/.agents/handoff/<时间>-<会话>.md`，
   自动填好事实段（最近人/机消息、最近工具动作、待办、交付物、写过的文件、git、环境），更新稳定指针
   `<交接目录>/LATEST`，打印本棒在交接链中的位置（chain / hop / previous），并在终端打印“开场白”。
2. 用 `read` 读该文档，再用 `edit`/`write` 补齐所有 `<!-- FILL ... -->` 段：
   - §1 目标与验收标准：一句话目标 + “怎样算完成”。
   - §3 已完成/已验证：补上验证方式（命令 + 观察到的结果）。没验证过的不要写进去。
   - §4 关键决策与约束：决定了什么 + 为什么；**并且必须把每条决策填进 §4 的表格**（决策 / 载体文件 / 可 grep 的证据），
     证据要写一段**确实存在于该文件里**的原文——自检会逐条 grep，grep 不到就是 FAIL。表里不填就报「没有可解析的表格行」。
   - §6 踩过的坑：试过什么 + 失败现象 + 原因（不写这条，新会话会重复烧上下文）。
   - §7 下一步：拆成小步，**第 1 条必须新会话能立刻动手**；完成的待办删掉。
   - §9 验证命令：一键自检命令 + 期望输出。
3. **必须自检，通过后才能把开场白交出去**：

   ```powershell
   node "<base>/scripts/handoff.mjs" --verify --doc "<交接文档路径>"
   ```

   退出码 0 = 通过。若 FAIL：按它逐条指出的问题回去补（哪条决策 grep 不到、哪节是空的），补完再跑一次。
   **不要跳过这一步**——会话给自己的交接打分一定会及格，grep 不会。
4. 回复用户，只给三样东西：
   - 交接文档路径（以及它在交接链中的第几棒）；
   - 一段 ```text 代码块，内容是脚本打印的“开场白”（含 `/context-guard` 触发词，新会话会自动加载本协议）；
   - 一句话操作说明：打开新会话 → 粘贴 → 发送。
   **不要把整篇交接文档贴进对话**（那是双倍上下文开销）。
5. 到临界线后不要开新战线：把手头这一步收尾，然后完成交接。

## 协议 B2 —— 跨 agent 交接（要把工作交给 Claude Code / Codex / Cursor 时）

同一个工作区里换 agent 时，跑 `node "<base>/scripts/handoff.mjs" --portable`：它会写出**环境无关**的
`<工作区>/HANDOFF.md`（剥掉 DSH 专属路径与自查命令），并打印一段任何 agent 都能用的开场白。
把该文件留在仓库根，然后对目标 agent 说「读 HANDOFF.md，从 §7 开始」即可。补完 FILL 后同样用 `--verify --doc HANDOFF.md` 自检。

## 协议 C —— 在新会话续接（用户粘贴开场白后）

1. 读交接文档；先跑一次 `context-usage.mjs` 确认余量。
2. 只读文档点名要补读的文件，**不要重新全仓勘察**。
3. 从 §7 第 1 条开始按序推进；§3 §5 已完成项不要重做；§6 失败过的做法不要重复。
4. 若文档与实际不符：先修正文档，再继续（文档是新会话的唯一真相源）。
5. 需要更早的来龙去脉时，按文档头部 `previous` 指针沿**交接链**回读——只在真的缺信息时回读，不要通读全链。
6. 续接后的会话同样受协议 A 管辖——接力是循环的。

## token 纪律

- 摘要行是给人看的，**原样转述**；不要把 `--json` 结果贴进对话。
- 交接文档写在磁盘上，对话里只出现路径和开场白。
- 不要用本技能做“上下文压缩”或删历史：它只测量、提醒、交接。

## 故障与边界

- `no DSH session log found`：当前不是 DSH 会话或会话 id 未知。加 `--session <id>` / `--log <path>`，
  或设置 `DSH_SESSION_ID`。
- 日志实时追加：测量最多落后一个 step（脚本容忍不完整的尾帧，不会因此报错）。
- 压缩会替换 surface：脚本以用量锚点为准；锚点被替换覆盖时退回启发式并标 `approx`。
- 子代理有独立会话与日志；本技能只测**当前**会话。
- 面板上的窗口（例如 1M）不等于你实际可用的安全额度：不同模型/路由的可用量不同，用 `--window`
  或配置改成你信任的值。
- 若 `approx` 长期为真且数字明显偏低，说明日志里没有 provider 用量（例如刚开会话），按趋势用它没问题，
  不要因此宣称精确。

## 可选：全自动提醒（hook，需改组合配置）

`hooks/dsh-context-guard-hook.mjs` 已经写好并自测通过：`SessionStart` 会把「当前占用 + 最新交接文档指针 +
续接须知」注入新会话，`UserPromptSubmit` 只在**新越线**时注入提醒块，其余情况完全静默，且任何异常都安静退出 0
（绝不打断会话）。

但它**默认不会生效**：DSH Web 组合没有挂载 Claude-Code 兼容的 hook 桥。启用方式见 `hooks/cordis-snippet.yml`
（挂 `@deepseek-ai/dsh-hooks-claude-code` 指向 `hooks/hooks.example.json`，然后重启 DSH）。
没挂载时，技能仍按协议 A 的“自觉检查”工作——两者不冲突。
