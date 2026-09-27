#!/usr/bin/env node
/**
 * context-guard — measure the current DSH session's context pressure.
 *
 * Prints one compact line by default (token-cheap, meant to be run every turn)
 * plus an advisory block only when a threshold is newly crossed. `--json` emits
 * the full measurement for programmatic use.
 *
 * `node context-usage.mjs --help` is the authoritative flag list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, fmtTokens, parseFlags } from './lib/cli.mjs';
import { measureContext } from './lib/measure.mjs';
import { encodeSegment, projectKey, resolveDshHome } from './lib/session-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');

const USAGE = `context-guard — 测量当前 DSH 会话的上下文占用

用法:
  node context-usage.mjs [选项]

选项:
  --session <id>           会话 id（默认取 $DSH_SESSION_ID）
  --log <path>             直接指定会话日志（.jsonl.zstd 或 .jsonl）
  --cwd <dir>              工作区目录（默认当前目录），用于定位会话日志与读配置
  --dsh-home <dir>         DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --warn <n>               提醒阈值：0.7 / 70% 为比例，700000 为绝对 token
  --critical <n>           临界阈值：同上
  --window <n>             上下文窗口 token 数（覆盖日志与配置）
  --window-fallback <n>    日志无窗口信息时使用的窗口（默认 128000）
  --state <path>           状态文件路径（默认 $DSH_HOME/storages/context-guard/…）
  --no-state               不读写状态（每次都视为新状态）
  --reset-state            先清空本会话状态再测量（重新提醒一次）
  --force                  即使等级未变化也输出提醒块
  --json                   输出完整 JSON
  --quiet                  只输出一行摘要
  --exit-code              warn 退出码 10、critical 退出码 20
  --help                   显示本帮助

退出码: 0 正常；--exit-code 时 10=warn、20=critical；用法或读取错误 2。
`;

function fmtThreshold(value, window) {
  return value <= 1 ? `${Math.round(value * 100)}%` : fmtTokens(value);
}

function statePathFor(measurement, cwd, override) {
  if (override) return override;
  const root = path.join(resolveDshHome(), 'storages', 'context-guard');
  const key = `${projectKey(cwd)}-${encodeSegment(measurement.sessionId ?? 'unknown')}`;
  return path.join(root, `${key}.json`);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    /* state is an optimization; never fail the check because of it */
  }
}

const ADVISORY = {
  warn: (m) =>
    [
      `⚠ 上下文已用 ${m.percent}%（${fmtTokens(m.pressureTokens)}/${fmtTokens(m.window)}），超过提醒线 ${fmtThreshold(m.warnAt, m.window)}。`,
      m.stepsToCritical
        ? `   按当前增速（约 ${fmtTokens(m.tokensPerStep)}/步）距临界线（${fmtThreshold(m.criticalAt, m.window)}）约还有 ${m.stepsToCritical} 步${m.turnsToCritical ? `（≈${m.turnsToCritical} 个回合）` : ''}。`
        : null,
      '   建议：只收尾当前这一步，不再开新战线；准备交接时运行 handoff 脚本（见 SKILL.md “交接”一节）。',
    ]
      .filter(Boolean)
      .join('\n'),
  critical: (m) =>
    [
      `🛑 上下文已用 ${m.percent}%（${fmtTokens(m.pressureTokens)}/${fmtTokens(m.window)}），超过临界线 ${fmtThreshold(m.criticalAt, m.window)}。`,
      '   继续在本会话推进有丢失输出的风险。现在应该：',
      '   1) 先写交接文档（scripts/handoff.mjs），2) 把交接开场白交给用户，3) 在新会话继续。',
    ].join('\n'),
};

function main() {
  let args;
  try {
    ({ args } = parseFlags(process.argv.slice(2), {
      usage: USAGE,
      values: ['log', 'session', 'cwd', 'dshHome', 'warn', 'critical', 'window', 'windowFallback', 'state', 'skillDir', 'handoffDir'],
      bools: ['json', 'quiet', 'force', 'noState', 'resetState', 'exitCode'],
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
      cli: {
        warn: args.warn,
        critical: args.critical,
        window: args.window,
        windowFallback: args.windowFallback,
        handoffDir: args.handoffDir,
        noState: Boolean(args.noState),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) console.log(JSON.stringify({ ok: false, error: message, code: error?.code ?? 'ERROR' }, null, 2));
    else console.error(`context-guard: ${message}`);
    process.exit(2);
  }

  const useState = measurement.config.writeState && !args.noState;
  const stateFile = useState ? statePathFor(measurement, cwd, args.state) : null;
  if (stateFile && args.resetState) {
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {
      /* a missing state file is the desired end state */
    }
  }
  const previous = stateFile ? readState(stateFile) : {};
  const isNew = previous.level !== measurement.level || previous.sessionId !== measurement.sessionId;
  const announce = !measurement.config.announceOnce || isNew || Boolean(args.force);
  if (stateFile) {
    writeState(stateFile, {
      sessionId: measurement.sessionId,
      level: measurement.level,
      percent: measurement.percent,
      pressureTokens: measurement.pressureTokens,
      window: measurement.window,
      updatedAt: new Date().toISOString(),
    });
  }

  const result = {
    ok: true,
    sessionId: measurement.sessionId,
    title: measurement.title,
    cwd: measurement.cwd ?? cwd,
    provider: measurement.provider,
    model: measurement.model,
    logPath: measurement.logPath,
    logVia: measurement.logVia,
    level: measurement.level,
    levelIsNew: isNew,
    announce,
    percent: measurement.percent,
    ratio: Number(measurement.ratio.toFixed(4)),
    pressureTokens: measurement.pressureTokens,
    window: measurement.window,
    windowSource: measurement.windowSource,
    remainingTokens: measurement.remainingTokens,
    warnAt: measurement.warnAt,
    criticalAt: measurement.criticalAt,
    warnTokens: measurement.warnTokens,
    criticalTokens: measurement.criticalTokens,
    turns: measurement.turns,
    steps: measurement.steps,
    tokensPerStep: measurement.tokensPerStep,
    stepsToCritical: measurement.stepsToCritical,
    turnsToCritical: measurement.turnsToCritical,
    method: measurement.method,
    approximate: measurement.approximate,
    anchorStale: measurement.anchorStale,
    surfaceNodes: measurement.surfaceNodes,
    stateFile,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const parts = [
      `CTX ${measurement.percent}%`,
      `${fmtTokens(measurement.pressureTokens)}/${fmtTokens(measurement.window)}`,
      `level=${measurement.level}${isNew ? '(new)' : ''}`,
      `warn@${fmtThreshold(measurement.warnAt, measurement.window)}`,
      `critical@${fmtThreshold(measurement.criticalAt, measurement.window)}`,
      `turns=${measurement.turns}`,
      `steps=${measurement.steps}`,
    ];
    if (measurement.tokensPerStep) parts.push(`perStep~${fmtTokens(measurement.tokensPerStep)}`);
    if (measurement.stepsToCritical !== null && measurement.level !== 'ok') parts.push(`~${measurement.stepsToCritical}stepsToCritical`);
    if (measurement.approximate) parts.push(`approx(${measurement.method})`);
    console.log(parts.join(' | '));
    if (!args.quiet) {
      console.log(`session=${measurement.sessionId} model=${measurement.provider ?? '?'}/${measurement.model ?? '?'} window=${measurement.windowSource}`);
      if (measurement.anchorTokens !== null && !measurement.approximate) {
        console.log(`anchor=usage:${fmtTokens(measurement.anchorTokens)}@seq${measurement.anchorSeq} +delta~${fmtTokens(measurement.deltaTokens)} (${measurement.surfaceNodes} surface nodes)`);
      } else if (measurement.approximate) {
        console.log(`heuristic surface~${fmtTokens(measurement.surfaceTokens)} + tools~${fmtTokens(measurement.headerTokens)}${measurement.anchorStale ? ' (anchor invalidated by compaction)' : ''}`);
      }
      console.log(`log=${measurement.logPath}`);
    }
    if (announce && measurement.level !== 'ok') console.log(`\n${ADVISORY[measurement.level](measurement)}`);
  }

  if (args.exitCode) process.exit(measurement.level === 'critical' ? 20 : measurement.level === 'warn' ? 10 : 0);
}

main();
