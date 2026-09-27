/**
 * Locating handoff documents — one implementation for the CLI and the hook.
 *
 * Two rules, both learned the hard way:
 *   - the newest hop is whatever `LATEST` points at (a stable pointer beats
 *     guessing from filenames or dates);
 *   - if the pointer is missing (documents written by an older version), fall
 *     back to the newest real handoff document, so the reader is never told
 *     "there is no handoff" while one is sitting right there.
 *
 * Cross-agent exports (`kind: context-guard-portable`) are views of the current
 * state, not hops, so they never participate in the chain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './measure.mjs';
import { parseFrontMatter } from './verify.mjs';

/** Directory holding this workspace's handoff documents. */
export function handoffDirFor(cwd, { skillDir, handoffDir } = {}) {
  const { config } = loadConfig({ skillDir, cwd, cli: { handoffDir } });
  return path.isAbsolute(config.handoffDir) ? config.handoffDir : path.join(cwd, config.handoffDir);
}

/** Newest real handoff document in a directory (by `created`, then mtime). */
export function newestDocIn(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  const docs = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let created = '';
    let kind = '';
    let mtime = 0;
    try {
      const data = parseFrontMatter(fs.readFileSync(file, 'utf8')).data;
      created = data.created ?? '';
      kind = data.kind ?? '';
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      /* an unreadable doc just sorts first */
    }
    if (kind && kind !== 'context-guard-handoff') continue;
    docs.push({ file, created, mtime });
  }
  if (!docs.length) return null;
  docs.sort((a, b) => (a.created || String(a.mtime)).localeCompare(b.created || String(b.mtime)) || a.mtime - b.mtime);
  return docs[docs.length - 1].file;
}

/**
 * Latest handoff document for a workspace, via `LATEST` with a scan fallback.
 * @param {string} cwd
 * @param {{skillDir?: string, handoffDir?: string}} [opts]
 * @returns {string|null} absolute path with forward slashes, or null
 */
export function latestHandoffDoc(cwd, opts = {}) {
  const dir = handoffDirFor(cwd, opts);
  let name = null;
  try {
    name = fs.readFileSync(path.join(dir, 'LATEST'), 'utf8').split(/\r?\n/)[0].trim() || null;
  } catch {
    name = null;
  }
  const pointed = name ? path.join(dir, name) : null;
  if (pointed && fs.existsSync(pointed)) return pointed.replace(/\\/g, '/');
  const newest = newestDocIn(dir);
  return newest ? newest.replace(/\\/g, '/') : null;
}
