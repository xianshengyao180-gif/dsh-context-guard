/**
 * Context measurement and configuration for the context-guard skill.
 *
 * Measurement strategy, in order of trust:
 *  1. Provider-reported usage anchor — the newest `assistant/message.usage`
 *     carries `totalTokens`, which is the whole prompt of that request
 *     (fresh input + cache reads + generated output). That IS the context
 *     occupancy at that step.
 *  2. Everything appended to the model surface after the anchor, priced with a
 *     local heuristic, is added as a delta, so a check made mid-turn (after new
 *     tool results landed) still reports current pressure.
 *  3. With no anchor at all (a brand-new session) the whole visible surface plus
 *     the newest request header (tool schemas) is priced heuristically.
 * Replacements (`surfaceOp: {op:'replace'}`) are folded, and an anchor invalidated
 * by a later replacement falls back to (3) and is flagged approximate.
 *
 * The heuristic is 4 characters per token for non-CJK plus 0.8 per CJK code point
 * with a small structural overhead per message. It is approximate by design — it
 * is only ever used for deltas and for the anchorless fallback, never to
 * contradict provider usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findSessionLog, readSessionHeader, readSessionLog, resolveDshHome } from './session-log.mjs';

export const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

export const DEFAULT_CONFIG = {
  contextWindow: null,
  warnAt: 0.7,
  criticalAt: 0.9,
  windowFallback: 128000,
  handoffDir: '.agents/handoff',
  announceOnce: true,
  writeState: true,
};

/** Approximate token price of a value (string or JSON-serializable). */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : safeStringify(value);
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(other / 4 + cjk * 0.8) + 8;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Provider usage → context occupancy of that request, or undefined. */
export function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  const parts = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .map((key) => (Number.isFinite(usage[key]) ? usage[key] : 0))
    .reduce((a, b) => a + b, 0);
  return parts > 0 ? parts : undefined;
}

/** The model-visible message payload carried by one surface event. */
export function surfacePayload(event) {
  if (event.data?.message) return event.data.message;
  return { role: event.data?.role ?? 'user', content: event.data?.content };
}

/**
 * Visible text of a message payload.
 *
 * Deliberately collects ONLY `text` blocks: reasoning blocks are the model's
 * private chain-of-thought and tool-call arguments are already summarized
 * elsewhere, so neither belongs in a handoff document.
 */
export function messageText(message) {
  const parts = [];
  const isTextBlock = (value) => typeof value.text === 'string' && (value.type === 'text' || value.type === undefined);
  const walk = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object') return;
    if (isTextBlock(value)) parts.push(value.text);
    if (typeof value.content === 'string') walk({ type: 'text', text: value.content });
    else if (Array.isArray(value.content)) walk(value.content);
  };
  walk(message?.content);
  return parts.join('\n').trim();
}

/**
 * Fold a session's durable log into measurement facts.
 * @param {object[]} events session events in seq order.
 */
export function analyzeEvents(events) {
  let header = null;
  let title = null;
  let provider = null;
  let model = null;
  let contextWindow = null;
  let turns = 0;
  let steps = 0;
  let anchor = null;
  let headerTokens = 0;
  let headerSeq = -1;
  let replacementsAfterAnchor = 0;
  const nodes = new Map();
  const replacements = [];

  for (const event of events) {
    switch (event.type) {
      case 'session':
        header = event;
        break;
      case 'session/title':
        if (typeof event.data?.title === 'string' && event.data.title.trim()) title = event.data.title;
        break;
      case 'model/selection':
        provider = event.data?.provider ?? provider;
        model = event.data?.model ?? model;
        break;
      case 'request/context':
        if (Number.isFinite(event.data?.contextWindow)) contextWindow = event.data.contextWindow;
        provider = event.data?.provider ?? provider;
        model = event.data?.model ?? model;
        break;
      case 'request/header':
        if (event.data?.header) {
          headerTokens = estimateTokens(event.data.header);
          headerSeq = event.seq;
        }
        break;
      case 'turn/start':
        turns = Math.max(turns, event.data?.turn ?? 0);
        break;
      case 'step/end':
        steps += 1;
        break;
      case 'assistant/message': {
        const total = usageTotal(event.data?.usage);
        if (total !== undefined) anchor = { seq: event.seq, tokens: total, usage: event.data.usage };
        break;
      }
      default:
        break;
    }

    if (!SURFACE_TYPES.has(event.type)) continue;
    const op = event.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace') {
      for (const seq of [...nodes.keys()]) {
        if (seq >= op.startSeq && seq <= op.endSeq) nodes.delete(seq);
      }
      replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq });
      if (anchor && event.seq > anchor.seq) replacementsAfterAnchor += 1;
    }
    nodes.set(event.seq, event);
  }

  const surface = [...nodes.values()];
  const priced = surface.map((event) => ({ seq: event.seq, type: event.type, tokens: estimateTokens(surfacePayload(event)) }));
  const surfaceTokens = priced.reduce((sum, node) => sum + node.tokens, 0);
  const afterAnchor = anchor ? priced.filter((node) => node.seq > anchor.seq) : [];
  const deltaTokens = afterAnchor.reduce((sum, node) => sum + node.tokens, 0);

  const anchorUsable = Boolean(anchor) && replacementsAfterAnchor === 0;
  const pressureTokens = anchorUsable ? anchor.tokens + deltaTokens : surfaceTokens + headerTokens;
  const anchorTokens = anchor?.tokens ?? null;

  return {
    header,
    sessionId: header?.id ?? null,
    cwd: header?.cwd ?? null,
    title,
    provider,
    model,
    contextWindow,
    turns,
    steps,
    anchorSeq: anchor?.seq ?? null,
    anchorTokens,
    deltaTokens,
    surfaceTokens,
    headerTokens,
    headerSeq,
    surfaceNodes: surface.length,
    replacements,
    anchorStale: Boolean(anchor) && replacementsAfterAnchor > 0,
    method: anchorUsable ? 'usage-anchor' : 'heuristic-surface',
    approximate: !anchorUsable,
    pressureTokens,
    nodes: priced.slice(-25),
  };
}

/** Read one config file; missing or malformed files contribute nothing. */
export function readConfigFile(file) {
  if (!file) return {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    // PowerShell's `Out-File -Encoding utf8` may prepend a BOM; tolerate it.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse a threshold: `0.7` / `70%` is a ratio, anything above 1 is absolute tokens. */
export function parseThreshold(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text.endsWith('%')) {
    const ratio = Number(text.slice(0, -1)) / 100;
    return Number.isFinite(ratio) ? ratio : undefined;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

/**
 * Merge configuration: skill defaults < skill config.json < workspace
 * `.agents/context-guard.json` < environment < CLI flags.
 */
export function loadConfig({ skillDir, cwd, env = process.env, cli = {} } = {}) {
  const skillFile = skillDir ? path.join(skillDir, 'config.json') : null;
  const workspaceFile = cwd ? path.join(cwd, '.agents', 'context-guard.json') : null;
  const merged = {
    ...DEFAULT_CONFIG,
    ...readConfigFile(skillFile),
    ...readConfigFile(workspaceFile),
  };
  const sources = { skillFile, workspaceFile };
  const envConfig = {
    contextWindow: parseThreshold(env.DSH_CTX_WINDOW),
    windowFallback: parseThreshold(env.DSH_CTX_WINDOW_FALLBACK),
    warnAt: parseThreshold(env.DSH_CTX_WARN),
    criticalAt: parseThreshold(env.DSH_CTX_CRITICAL),
    handoffDir: env.DSH_CTX_HANDOFF_DIR,
    announceOnce: env.DSH_CTX_ANNOUNCE_ONCE === undefined ? undefined : env.DSH_CTX_ANNOUNCE_ONCE !== '0',
    writeState: env.DSH_CTX_NO_STATE === '1' ? false : undefined,
  };
  const cliConfig = {
    contextWindow: parseThreshold(cli.window),
    windowFallback: parseThreshold(cli.windowFallback),
    warnAt: parseThreshold(cli.warn),
    criticalAt: parseThreshold(cli.critical),
    handoffDir: cli.handoffDir,
    writeState: cli.noState ? false : undefined,
  };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = firstDefined(cliConfig[key], envConfig[key]);
    if (value !== undefined) merged[key] = value;
  }
  merged.warnAt = normalizeThreshold(merged.warnAt, 0.7);
  merged.criticalAt = normalizeThreshold(merged.criticalAt, 0.9);
  return { config: merged, sources };
}

function normalizeThreshold(value, fallback) {
  const parsed = parseThreshold(value);
  return parsed === undefined || parsed <= 0 ? fallback : parsed;
}

/** Turn a threshold (ratio or absolute tokens) into tokens for a window size. */
export function thresholdTokens(threshold, window) {
  return threshold <= 1 ? Math.round(threshold * window) : Math.round(threshold);
}

/**
 * Full measurement: locate the log, fold it, apply thresholds and report.
 * @returns measurement object consumed by both CLIs.
 */
export function measureContext(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const dshHome = resolveDshHome(options.dshHome);
  const located = options.logPath
    ? (() => {
        const header = readSessionHeader(options.logPath);
        return {
          logPath: options.logPath,
          sessionId: header?.id ?? options.session ?? null,
          cwd: header?.cwd ?? cwd,
          header,
          via: 'explicit',
        };
      })()
    : findSessionLog({ sessionId: options.session, cwd, dshHome: options.dshHome });
  const { events, frames, bytes, tornStart } = readSessionLog(located.logPath);
  const analysis = analyzeEvents(events);
  const { config, sources } = loadConfig({ skillDir: options.skillDir, cwd, env: options.env, cli: options.cli ?? {} });

  const window = firstDefined(config.contextWindow, analysis.contextWindow, config.windowFallback);
  const windowSource = config.contextWindow
    ? 'config'
    : Number.isFinite(analysis.contextWindow)
      ? 'session(request/context)'
      : 'windowFallback';
  const warnTokens = thresholdTokens(config.warnAt, window);
  const criticalTokens = thresholdTokens(config.criticalAt, window);
  const pressure = Math.max(0, Math.round(analysis.pressureTokens));
  const ratio = window > 0 ? pressure / window : 0;
  const level = pressure >= criticalTokens ? 'critical' : pressure >= warnTokens ? 'warn' : 'ok';
  // Growth rate: the surface reached `pressure` over `steps` model requests, so
  // the mean increment per request is the honest extrapolation basis.
  const tokensPerStep = analysis.steps > 0 ? Math.round(pressure / analysis.steps) : null;
  const stepsPerTurn = analysis.steps > 0 && analysis.turns > 0 ? analysis.steps / analysis.turns : null;
  const remainingToCritical = Math.max(0, criticalTokens - pressure);
  const stepsToCritical = tokensPerStep ? Math.ceil(remainingToCritical / tokensPerStep) : null;
  const turnsToCritical =
    stepsToCritical !== null && stepsToCritical > 0 && stepsPerTurn ? Math.max(1, Math.ceil(stepsToCritical / stepsPerTurn)) : stepsToCritical;

  return {
    ...analysis,
    logPath: located.logPath,
    logVia: located.via,
    logBytes: bytes,
    logFrames: frames,
    logTornTail: tornStart !== undefined,
    dshHome,
    window,
    windowSource,
    warnAt: config.warnAt,
    criticalAt: config.criticalAt,
    warnTokens,
    criticalTokens,
    pressureTokens: pressure,
    ratio,
    percent: Number((ratio * 100).toFixed(1)),
    remainingTokens: Math.max(0, window - pressure),
    tokensPerStep,
    stepsPerTurn,
    stepsToCritical,
    turnsToCritical,
    level,
    config,
    configSources: sources,
  };
}
