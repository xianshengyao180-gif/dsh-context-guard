#!/usr/bin/env node
/**
 * context-guard — build a session handoff document.
 *
 * Writes a handoff file whose factual sections are auto-collected from the
 * durable session log (last user/assistant messages, recent actions, todo list,
 * presented deliverables, files written, git state) and whose judgement
 * sections are `<!-- FILL ... -->` placeholders for the model to complete.
 * Prints the paste-into-a-new-session opener on stdout.
 *
 * `node handoff.mjs --help` is the authoritative flag list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageError, parseFlags } from './lib/cli.mjs';
import { measureContext, messageText } from './lib/measure.mjs';
import { readSessionLog } from './lib/session-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const CHECK_SCRIPT = path.join(SKILL_DIR, 'scripts', 'context-usage.mjs');

const USAGE = `context-guard — 生成会话交接文档与新会话开场白

用法:
  node handoff.mjs [选项]

选项:
  --out <path>             交接文档输出路径（默认为 <工作区>/.agents/handoff/<时间>-<会话>.md）
  --title <text>           文档标题（默认取会话标题）
  --cwd <dir>              工作区目录（默认当前目录）
  --session <id>           会话 id（默认取 $DSH_SESSION_ID）
  --log <path>             直接指定会话日志
  --dsh-home <dir>         DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --handoff-dir <dir>      交接文档目录（覆盖配置里的 handoffDir）
  --warn <n>               测量用的提醒阈值（影响文档里的上下文读数）
  --critical <n>           测量用的临界阈值
  --window <n>             上下文窗口 token 数
  --stdout                 把文档打到标准输出，不写文件
  --json                   以 JSON 输出采集到的事实（不写文件）
  --help                   显示本帮助

退出码: 0 成功；用法或读取错误 2。
`;

function truncate(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function gitDirOf(cwd) {
  const dotGit = path.join(cwd, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const text = fs.readFileSync(dotGit, 'utf8');
      const match = /^gitdir:\s*(.+)$/m.exec(text);
      if (match) return path.resolve(cwd, match[1].trim());
    }
  } catch {
    return null;
  }
  return null;
}

/** Branch/HEAD straight from the git directory — works with no git binary. */
function readGitHead(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    if (!refMatch) return { branch: '(detached)', head: head.slice(0, 10) };
    const ref = refMatch[1].trim();
    const branch = ref.replace(/^refs\/heads\//, '');
    let sha = null;
    try {
      sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 10);
    } catch {
      try {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`));
        if (line) sha = line.split(' ')[0].slice(0, 10);
      } catch {
        sha = null;
      }
    }
    return { branch, head: sha };
  } catch {
    return null;
  }
}

function gitFacts(cwd) {
  const gitDir = gitDirOf(cwd);
  if (!gitDir) return { available: false, reason: 'workspace 不是 git 仓库' };
  const fromFiles = readGitHead(gitDir) ?? {};
  const run = (argv) => {
    try {
      return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
    } catch {
      return null;
    }
  };
  const status = run(['status', '--short']);
  if (status !== null) {
    return {
      available: true,
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) ?? fromFiles.branch,
      head: run(['rev-parse', '--short', 'HEAD']) ?? fromFiles.head,
      status,
      diffStat: run(['diff', '--stat']) ?? '',
    };
  }
  return {
    available: 'partial',
    branch: fromFiles.branch,
    head: fromFiles.head,
    reason: 'git 不在 PATH（或沙箱禁止子进程），只读到了 HEAD；改动清单请在新会话自行运行 `git status --short` / `git diff --stat`',
  };
}

function collectFacts(events) {
  const userMessages = [];
  const assistantMessages = [];
  const toolCalls = [];
  const todos = [];
  const presented = [];
  const subagents = [];
  const touched = new Map();
  let lastTodoSeq = -1;

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        // Only claimed human messages count as "the human said": the log also
        // carries plugin and skill-catalog injections with a different source kind.
        if (event.data?.source?.kind !== 'user') break;
        const text = messageText({ content: event.data?.content });
        if (text) userMessages.push({ seq: event.seq, text });
        break;
      }
      case 'assistant/message': {
        // Visible reply only — a tool-calling step whose blocks are
        // reasoning + tool-call contributes no text and is listed as an action instead.
        const text = messageText(event.data?.message);
        if (text) assistantMessages.push({ seq: event.seq, text });
        break;
      }
      case 'tool/call': {
        let args = {};
        try {
          args = JSON.parse(event.data?.arguments ?? '{}');
        } catch {
          args = {};
        }
        toolCalls.push({ seq: event.seq, name: event.data?.name, args });
        const targets = [];
        if (typeof args.file_path === 'string') targets.push(args.file_path);
        if (typeof args.path === 'string') targets.push(args.path);
        if (Array.isArray(args.files)) for (const file of args.files) if (file?.path) targets.push(file.path);
        if (event.data?.name === 'write' || event.data?.name === 'edit' || event.data?.name === 'present') {
          for (const target of targets) {
            const entry = touched.get(target) ?? { path: target, tools: new Set(), count: 0 };
            entry.tools.add(event.data.name);
            entry.count += 1;
            touched.set(target, entry);
          }
        }
        break;
      }
      case 'todo/write': {
        if (Array.isArray(event.data?.todos) && event.seq >= lastTodoSeq) {
          lastTodoSeq = event.seq;
          todos.length = 0;
          for (const todo of event.data.todos) todos.push({ content: todo?.content ?? '', status: todo?.status ?? 'pending' });
        }
        break;
      }
      case 'deliverables/presented': {
        for (const file of event.data?.files ?? []) presented.push({ path: file?.path, description: file?.description });
        break;
      }
      case 'subagent/catalog': {
        if (event.data?.label) subagents.push(event.data.label);
        break;
      }
      default:
        break;
    }
  }

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    todos,
    presented,
    subagents: [...new Set(subagents)],
    touched: [...touched.values()].map((entry) => ({ path: entry.path, tools: [...entry.tools], count: entry.count })),
  };
}

function renderDoc({ measurement, facts, git, title, opener, generatedAt }) {
  const lines = [];
  const pct = measurement.percent;
  lines.push('<!-- context-guard handoff — 新会话先读这份文档，再动手 -->');
  lines.push(`# 交接：${title}`);
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 生成时间 | ${generatedAt} |`);
  lines.push(`| 上一会话 | \`${measurement.sessionId}\` |`);
  lines.push(`| 工作目录 | \`${measurement.cwd}\` |`);
  lines.push(`| 模型 | ${measurement.provider ?? '?'} / ${measurement.model ?? '?'} |`);
  lines.push(`| 交接时上下文 | ${pct}%（${measurement.pressureTokens} / ${measurement.window} tokens，窗口来源 ${measurement.windowSource}） |`);
  lines.push(`| 会话规模 | ${measurement.turns} 回合 / ${measurement.steps} 步 |`);
  lines.push('');

  lines.push('## 0. 新会话怎么用这份文档');
  lines.push('1. 通读全文；§2 §3 §5 §8 是自动采集的事实，可直接采信，若有偏差先修正。');
  lines.push('2. 需要补读的文件按 §5 的清单读，不要重新全仓勘察。');
  lines.push('3. 从 §7「下一步」第 1 条开始，按顺序推进；§3/§5 已完成的工作不要重做。');
  lines.push('4. §6 列出的失败尝试不要重复；完成后用 §9 的命令自检。');
  lines.push('');

  lines.push('## 1. 目标与验收标准');
  lines.push('<!-- FILL: 一句话目标 + “怎样算完成”（谁看到什么/跑通什么就算成功）。目标若已变化，写新目标并注明为何变化。 -->');
  lines.push('');

  lines.push('## 2. 当前状态（自动采集）');
  const lastUsers = facts.userMessages.slice(-3);
  if (lastUsers.length) {
    lines.push('最近的人类消息（由旧到新；已排除插件/技能目录注入）：');
    for (const message of lastUsers) lines.push(`- (seq ${message.seq}) ${truncate(message.text, 300)}`);
  } else {
    lines.push('- （本会话没有记录到人类消息）');
  }
  const lastAssistant = facts.assistantMessages.slice(-2);
  if (lastAssistant.length) {
    lines.push('');
    lines.push('助手最后的文字产出（不含推理与工具调用）：');
    for (const message of lastAssistant) lines.push(`- (seq ${message.seq}) ${truncate(message.text, 500)}`);
  } else {
    lines.push('');
    lines.push('助手最后的文字产出：本会话助手只做了工具调用，没有文字回复（见下面的工具动作）。');
  }
  const recentCalls = facts.toolCalls.slice(-6);
  if (recentCalls.length) {
    lines.push('');
    lines.push('最近的工具动作：');
    for (const call of recentCalls) {
      const arg = truncate(JSON.stringify(call.args), 140);
      lines.push(`- \`${call.name}\` ${arg}`);
    }
  }
  lines.push('');

  lines.push('## 3. 已完成 / 已验证');
  lines.push('<!-- FILL: 补上“怎么验证的”（命令 + 观察到的结果）。不要把没验证的东西写进这里。 -->');
  if (facts.todos.length) {
    lines.push('');
    lines.push('上一会话的待办列表（自动采集，最后一次 todo 写入）：');
    for (const todo of facts.todos) {
      const box = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
      lines.push(`- ${box} ${todo.content}`);
    }
  }
  lines.push('');

  lines.push('## 4. 关键决策与约束');
  lines.push('<!-- FILL: 已定下的技术选型、命名、目录约定、不可违反的边界；每条写“决定了什么 + 为什么”。新会话不应再重新讨论这些。 -->');
  lines.push('');

  lines.push('## 5. 产物与文件（自动采集）');
  if (facts.presented.length) {
    lines.push('已交付：');
    for (const file of facts.presented) lines.push(`- \`${file.path}\`${file.description ? ` — ${file.description}` : ''}`);
    lines.push('');
  }
  if (facts.touched.length) {
    lines.push('本会话写过的文件：');
    for (const entry of facts.touched) lines.push(`- \`${entry.path}\` (${entry.tools.join(', ')}, ${entry.count} 次)`);
    lines.push('');
  } else {
    lines.push('- （本会话没有 write/edit/present 记录）');
    lines.push('');
  }
  if (git.available === true) {
    lines.push(`Git：分支 \`${git.branch}\` @ \`${git.head}\``);
    if (git.status) lines.push('改动（git status --short）：\n```\n' + git.status + '\n```');
    else lines.push('工作区干净（git status --short 无输出）');
    if (git.diffStat) lines.push('未暂存改动（git diff --stat）：\n```\n' + git.diffStat + '\n```');
  } else if (git.available === 'partial') {
    lines.push(`Git：分支 \`${git.branch ?? '?'}\` @ \`${git.head ?? '?'}\`（从 .git 目录读取）`);
    lines.push(`> ${git.reason}`);
  } else {
    lines.push(`Git：未采集（${git.reason}）`);
  }
  if (facts.subagents.length) {
    lines.push('');
    lines.push(`本会话启动过的子代理：${facts.subagents.map((label) => `\`${label}\``).join('、')}`);
  }
  lines.push('');

  lines.push('## 6. 踩过的坑 / 不要重复尝试');
  lines.push('<!-- FILL: 试过但失败或走不通的路 + 失败现象 + 原因。新会话重复这些会白烧上下文。 -->');
  lines.push('');

  lines.push('## 7. 下一步（按顺序）');
  const open = facts.todos.filter((todo) => todo.status !== 'completed');
  if (open.length) {
    lines.push('来自上一会话的待办（自动采集）：');
    open.forEach((todo, index) => {
      lines.push(`${index + 1}. ${todo.content}${todo.status === 'in_progress' ? '（上次正在进行）' : ''}`);
    });
    lines.push('');
  }
  lines.push('<!-- FILL: 把下一步拆成可执行的小步，每步写清“做什么 + 完成判据”。第 1 条必须是新会话能立刻动手的。 -->');
  lines.push('');

  lines.push('## 8. 环境事实（自动采集）');
  lines.push(`- 工作目录: \`${measurement.cwd}\``);
  lines.push(`- DSH home: \`${measurement.dshHome}\``);
  lines.push(`- 会话日志: \`${measurement.logPath}\``);
  lines.push(`- 模型: ${measurement.provider ?? '?'} / ${measurement.model ?? '?'}，上下文窗口 ${measurement.window} tokens（${measurement.windowSource}）`);
  lines.push(`- 阈值: warn ${measurement.warnAt}（${measurement.warnTokens}）/ critical ${measurement.criticalAt}（${measurement.criticalTokens}）`);
  lines.push(`- 上下文自检: \`node "${CHECK_SCRIPT}"\``);
  lines.push('');

  lines.push('## 9. 验证命令');
  lines.push('<!-- FILL: 能一键证明“还没坏的”命令，以及期望输出。 -->');
  lines.push('');

  lines.push('## 10. 给新会话的开场白（复制下面整段）');
  lines.push('```text');
  lines.push(opener);
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildOpener({ measurement, docPath, title }) {
  const relative = path.relative(measurement.cwd ?? process.cwd(), docPath).replace(/\\/g, '/');
  return [
    `/context-guard 接续上一个会话的工作：${title}`,
    `交接文档：${relative}`,
    '先完整读它，再按 §7「下一步」第 1 条开始动手；§3/§5 里已完成的工作不要重做，§6 里失败过的做法不要重复。',
    `动手前先跑一次 node "${CHECK_SCRIPT}" 确认余量；之后每个回合开头各跑一次。`,
  ].join('\n');
}

function main() {
  let args;
  try {
    ({ args } = parseFlags(process.argv.slice(2), {
      usage: USAGE,
      values: ['out', 'title', 'cwd', 'session', 'log', 'dshHome', 'handoffDir', 'warn', 'critical', 'window', 'windowFallback', 'skillDir'],
      bools: ['stdout', 'json'],
    }));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`context-guard: ${error.message}\n\n${error.usage}`);
      process.exit(2);
    }
    throw error;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  let measurement;
  try {
    measurement = measureContext({
      cwd,
      session: args.session,
      logPath: args.log ? path.resolve(args.log) : undefined,
      dshHome: args.dshHome,
      skillDir: args.skillDir ?? SKILL_DIR,
      cli: { warn: args.warn, critical: args.critical, window: args.window, windowFallback: args.windowFallback, handoffDir: args.handoffDir },
    });
  } catch (error) {
    console.error(`context-guard: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const { events } = readSessionLog(measurement.logPath);
  const facts = collectFacts(events);
  const git = gitFacts(measurement.cwd ?? cwd);
  const title = args.title ?? measurement.title ?? '（未命名会话）';
  const generatedAt = new Date().toLocaleString('sv-SE');
  const shortId = String(measurement.sessionId ?? 'session').replace(/^session-/, '').slice(0, 8);
  const stamp = generatedAt.replace(/[: ]/g, '-');

  const handoffDir = path.isAbsolute(measurement.config.handoffDir)
    ? measurement.config.handoffDir
    : path.join(measurement.cwd ?? cwd, measurement.config.handoffDir);
  const docPath = args.out ? path.resolve(args.out) : path.join(handoffDir, `${stamp}-${shortId}.md`);

  const opener = buildOpener({ measurement, docPath, title });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          docPath: args.stdout ? null : docPath,
          opener,
          measurement: {
            sessionId: measurement.sessionId,
            cwd: measurement.cwd,
            title,
            model: `${measurement.provider ?? '?'}/${measurement.model ?? '?'}`,
            percent: measurement.percent,
            pressureTokens: measurement.pressureTokens,
            window: measurement.window,
            turns: measurement.turns,
            steps: measurement.steps,
          },
          git,
          facts: {
            lastUserMessages: facts.userMessages.slice(-3).map((m) => truncate(m.text, 400)),
            lastAssistantMessages: facts.assistantMessages.slice(-2).map((m) => truncate(m.text, 600)),
            recentToolCalls: facts.toolCalls.slice(-6).map((c) => ({ name: c.name, args: truncate(JSON.stringify(c.args), 200) })),
            todos: facts.todos,
            presented: facts.presented,
            touchedFiles: facts.touched,
            subagents: facts.subagents,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  const doc = renderDoc({ measurement, facts, git, title, opener, generatedAt });
  if (args.stdout) {
    process.stdout.write(doc);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, doc, 'utf8');
  } catch (error) {
    console.error(`context-guard: 无法写入交接文档 ${docPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  console.log(`交接文档已写入: ${docPath}`);
  console.log('（自动采集部分已填好；请用 edit/write 补齐 §1 §3 §4 §6 §7 §9 的 FILL 段落）');
  console.log('');
  console.log('把下面这段复制到新会话:');
  console.log('----------8<----------');
  console.log(opener);
  console.log('----------8<----------');
}

main();
