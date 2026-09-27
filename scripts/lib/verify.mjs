/**
 * Mechanical checks on a handoff document.
 *
 * The lesson this implements: a session that judges its own handoff will pass
 * itself, so nothing that can be verified mechanically is left to judgement.
 * Checks are intentionally dumb and literal — substring search, file existence —
 * because a dumb check cannot be talked out of a failure.
 *
 * What is checked:
 *   1. no `<!-- FILL` placeholder left anywhere
 *   2. all 11 sections present
 *   3. §10 carries a fenced opener that starts with the trigger
 *   4. every row of the §4 decision table resolves: the carrier file exists and
 *      the evidence string is really in it
 *   5. a `previous:` chain pointer (when present) resolves to an existing file
 *   6. §7 has at least one numbered step
 *   7. §9 has real verification content
 */

import fs from 'node:fs';
import path from 'node:path';

export const REQUIRED_SECTIONS = [
  // 只校验序号前缀，标题措辞可不同（DSH 版 §0 叫“新会话怎么用这份文档”，
  // 跨 agent 版叫“用法（任意 agent）”；§10 同理）。
  '## 0. ',
  '## 1. 目标与验收标准',
  '## 2. 当前状态',
  '## 3. 已完成',
  '## 4. 关键决策与约束',
  '## 5. 产物与文件',
  '## 6. 踩过的坑',
  '## 7. 下一步',
  '## 8. 环境事实',
  '## 9. 验证命令',
  '## 10. ',
];

/** Split a markdown document into YAML-ish front-matter data and the body. */
export function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: text.slice(match[0].length) };
}

/** Text of one `## n.` section, up to the next `## ` heading. */
export function sectionText(body, marker) {
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const rest = body.slice(start);
  const next = rest.indexOf('\n## ', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Rows of the §4 decision table: `| 决策 | 载体文件 | 可 grep 的证据 |`. */
export function parseDecisionTable(body) {
  const section = sectionText(body, '## 4. 关键决策与约束');
  if (!section) return [];
  const rows = [];
  let headerSeen = false;
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) {
      headerSeen = true;
      continue;
    }
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (!headerSeen) continue; // the header row itself
    if (cells.length < 3) continue;
    const [decision, carrier, evidence] = cells;
    if (!decision && !carrier && !evidence) continue;
    rows.push({
      decision,
      carrier: carrier.replace(/`/g, '').trim(),
      evidence: evidence.replace(/`/g, '').trim(),
    });
  }
  return rows;
}

function resolveCarrier(carrier, cwd, docDir) {
  const candidates = [];
  if (!carrier) return null;
  if (path.isAbsolute(carrier)) candidates.push(carrier);
  else {
    candidates.push(path.resolve(cwd, carrier));
    candidates.push(path.resolve(docDir, carrier));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

/**
 * Verify a handoff document.
 * @param {string} docPath
 * @param {{cwd?: string, trigger?: string, body?: string}} [opts]
 * @returns {{ok: boolean, docPath: string, checks: object[], decisions: object[], frontMatter: object}}
 */
export function verifyHandoffDoc(docPath, opts = {}) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const docDir = path.dirname(path.resolve(docPath));
  const trigger = opts.trigger ?? '/context-guard';
  const text = opts.body ?? fs.readFileSync(docPath, 'utf8');
  const { data, body } = parseFrontMatter(text);
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  const fills = (text.match(/<!--\s*FILL/g) ?? []).length;
  push('没有遗留 FILL 占位', fills === 0, fills ? `仍有 ${fills} 处 <!-- FILL … --> 未补` : 'ok');

  const missing = REQUIRED_SECTIONS.filter((s) => !body.includes(s));
  push('11 个章节齐全', missing.length === 0, missing.length ? `缺: ${missing.join(' / ')}` : 'ok');

  // §10 必须有一个可复制的开场白代码块：DSH 版以触发词开头，跨 agent 版是“读 <文件>…”式
  const dshOpener = new RegExp('```text\\s*\\r?\\n\\s*' + trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const portableOpener = /```text\s*\r?\n\s*读\s+\S+/;
  const openerOk = dshOpener.test(body) || portableOpener.test(body);
  push('§10 有可复制的开场白代码块', openerOk, openerOk ? 'ok' : '未找到符合格式的代码块');

  const decisions = parseDecisionTable(body);
  if (decisions.length === 0) {
    push('决策落盘表已填写', false, '§4 里没有可解析的表格行（需要 | 决策 | 载体文件 | 可 grep 的证据 |）');
  } else {
    push('决策落盘表已填写', true, `${decisions.length} 条`);
    decisions.forEach((row, index) => {
      const label = `决策 #${index + 1}「${row.decision.slice(0, 24) || '(空)'}」`;
      if (/示例/.test(row.decision) || /示例/.test(row.carrier)) {
        return push(label, false, '仍是模板示例行，请替换成真实决策');
      }
      if (!row.carrier) return push(label, false, '未填载体文件');
      if (!row.evidence) return push(label, false, '未填可 grep 的证据');
      const file = resolveCarrier(row.carrier, cwd, docDir);
      if (!file) return push(label, false, `载体文件不存在: ${row.carrier}`);
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (error) {
        return push(label, false, `载体不可读: ${error.message}`);
      }
      const found = content.includes(row.evidence);
      push(label, found, found ? `已在 ${row.carrier} 中 grep 到` : `grep 不到「${row.evidence}」（${row.carrier}）`);
    });
  }

  const previous = data.previous && data.previous !== '(none)' ? data.previous : null;
  if (previous) {
    const resolved = resolveCarrier(previous, cwd, docDir);
    push('交接链上一棒可解析', Boolean(resolved), resolved ? `→ ${previous}` : `指向的文件不存在: ${previous}`);
  } else {
    push('交接链上一棒可解析', true, '本棒是链首（previous 为空）');
  }

  const sec7 = sectionText(body, '## 7. 下一步') ?? '';
  const steps = (sec7.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
  push('§7 有可执行步骤', steps > 0, steps ? `${steps} 条` : '没有编号步骤');

  const sec9 = (sectionText(body, '## 9. 验证命令') ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  push('§9 有验证命令', sec9.replace(/^## .*$/m, '').trim().length > 10, sec9.length > 10 ? 'ok' : '内容为空');

  return { ok: checks.every((c) => c.pass), docPath: path.resolve(docPath), checks, decisions, frontMatter: data };
}

/** Render a verification result as a small text table. */
export function formatReport(result) {
  const width = Math.max(...result.checks.map((c) => c.name.length), 8);
  const lines = [`交接文档自检: ${result.docPath}`, ''];
  for (const check of result.checks) {
    lines.push(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const failed = result.checks.filter((c) => !c.pass).length;
  lines.push('', result.ok ? '结论: 通过（可以把这个开场白交给新会话）' : `结论: 不通过（${failed} 项失败；补完再跑一次）`);
  return lines.join('\n');
}
