#!/usr/bin/env node
/**
 * context-guard hook — the deterministic half of the skill.
 *
 * A skill is instructions; a hook is the only part that runs whether or not the
 * model remembers. This one script serves both DSH hook events:
 *
 *   SessionStart      → inject a compact state block (latest handoff pointer +
 *                       current context usage) so a fresh session knows where it
 *                       stands before it reads anything.
 *   UserPromptSubmit  → inject the threshold warning when the context level has
 *                       newly crossed a line. Silence otherwise.
 *
 * Wire it through the Claude-Code-compatible hook bridge, which passes the event
 * payload as JSON on stdin and reads a JSON decision on stdout:
 *
 *   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}
 *
 * Contract kept deliberately boring: never throw, never block, always exit 0.
 * A hook that breaks the user's session is worse than no hook.
 *
 * NOTE: the DSH Web composition does not mount the hook bridge by default —
 * see hooks/hooks.example.json and the README section "全自动提醒（hook）".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, measureContext } from '../scripts/lib/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const CHECK_SCRIPT = path.join(SKILL_DIR, 'scripts', 'context-usage.mjs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function fmtTokens(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

/** Latest handoff document for a workspace, via the stable LATEST pointer. */
function latestHandoff(cwd) {
  const { config } = loadConfig({ skillDir: SKILL_DIR, cwd });
  const dir = path.isAbsolute(config.handoffDir) ? config.handoffDir : path.join(cwd, config.handoffDir);
  const pointer = path.join(dir, 'LATEST');
  let name = null;
  try {
    name = fs.readFileSync(pointer, 'utf8').split(/\r?\n/)[0].trim() || null;
  } catch {
    name = null;
  }
  if (name && fs.existsSync(path.join(dir, name))) {
    return path.join(dir, name).replace(/\\/g, '/');
  }
  // No pointer: fall back to the newest *.md sitting in the handoff directory.
  try {
    const docs = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    if (docs.length) return path.join(dir, docs[docs.length - 1].f).replace(/\\/g, '/');
  } catch {
    /* no handoff at all */
  }
  return null;
}

function emit(event, context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}

function sessionStart(payload) {
  const cwd = payload.cwd || process.cwd();
  const lines = ['== context-guard 状态（hook 自动注入，优先于文档里的旧数字）=='];
  let measurement = null;
  try {
    measurement = measureContext({ cwd });
    lines.push(
      `上下文: ${measurement.percent}%（${fmtTokens(measurement.pressureTokens)}/${fmtTokens(measurement.window)}）` +
        ` warn@${Math.round(measurement.warnAt * 100)}% critical@${Math.round(measurement.criticalAt * 100)}%` +
        ` | ${measurement.turns} 回合 / ${measurement.steps} 步`,
    );
  } catch (error) {
    lines.push(`上下文: 未测到（${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}）`);
  }
  const doc = latestHandoff(cwd);
  if (doc) {
    lines.push(`上一会话的交接文档: ${doc}`);
    lines.push('→ 先读它（§1 目标 / §7 下一步 / §8 环境事实），从 §7 第 1 条开始；§3 §5 已完成不要重做，§6 失败过的不要重复。');
    lines.push('→ 需要更早的来龙去脉时，按文档头部 previous 指针沿交接链回读，不要通读全链。');
  } else {
    lines.push('没有找到交接文档：这是一个全新开始。');
  }
  emit('SessionStart', lines.join('\n'));
}

function userPromptSubmit(payload) {
  const cwd = payload.cwd || process.cwd();
  let measurement;
  try {
    measurement = measureContext({ cwd });
  } catch {
    return; // 测不到就当没这回事，绝不打断用户
  }
  if (measurement.level === 'ok') return;
  const percent = Math.round(measurement.warnAt * 100);
  const critical = Math.round(measurement.criticalAt * 100);
  const lines = [
    measurement.level === 'critical'
      ? `🛑 上下文已用 ${measurement.percent}%，超过临界线 ${critical}%：继续推进有丢失输出的风险。`
      : `⚠ 上下文已用 ${measurement.percent}%，超过提醒线 ${percent}%。`,
    `（hook 自动注入；自查：node "${CHECK_SCRIPT}"）`,
  ];
  if (measurement.level === 'critical') {
    lines.push('建议顺序：先把当前这一步收尾 → 运行 handoff 脚本写交接文档 → 用 --verify 自检 → 在新会话继续。');
  } else {
    lines.push('建议：只收尾当前这一步，不再开新战线；准备交接时运行 handoff 脚本。');
  }
  emit('UserPromptSubmit', lines.join('\n'));
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return; // 没有 payload：不是作为 hook 被调用，安静退出
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const event = payload.hook_event_name || payload.hookEventName || '';
  try {
    if (event === 'SessionStart') sessionStart(payload);
    else if (event === 'UserPromptSubmit') userPromptSubmit(payload);
    // 其它事件一律安静通过：本脚本只负责"提醒"，不参与拦截
  } catch {
    /* 任何意外都不该影响会话 */
  }
}

main();
