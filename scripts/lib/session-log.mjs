/**
 * DSH session-log reader shared by the context-guard scripts.
 *
 * A DSH session log is a concatenated multi-frame Zstandard container
 * (`session.v<N>.jsonl.zstd`): the first frame holds the `session` header and
 * every later frame holds one appended batch of JSONL events. Node's one-shot
 * `zstdDecompressSync` decodes only the first frame, so frames are located
 * structurally first (same algorithm as dsh-session-persistence-jsonl) and
 * decoded one by one. A torn final frame (a live append) is tolerated.
 *
 * Filesystem-only on purpose: it must keep working when the harness runs under
 * a sandbox that forbids child processes and named pipes.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;
const LOG_RE = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/;

/**
 * Fail loudly and understandably when the runtime predates Node's built-in
 * Zstandard support (added in Node 22.15 / 23.8) instead of letting a raw
 * TypeError surface from deep inside the decoder.
 */
function assertZstdAvailable() {
  if (typeof zstdDecompressSync === 'function') return;
  const version = process.versions?.node ?? 'unknown';
  const error = new Error(
    `当前 Node (v${version}) 的 zlib 不提供 Zstandard 解压（zstdDecompressSync），无法读取 DSH 的 .jsonl.zstd 会话日志。` +
      '请使用 Node 22.15+ / 23.8+（推荐 24 LTS 及以上），或用 --log 指向未压缩的 session.v<N>.jsonl。',
  );
  error.code = 'ENOZSTD';
  throw error;
}

/**
 * Locate structurally complete Zstandard frames without decompressing them.
 * @param {Buffer} buffer complete bytes currently present in the log artifact.
 * @returns {{frames: {start: number, end: number}[], tornStart: number|undefined}}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart: undefined };
}

/**
 * Decode a whole log artifact, tolerating plain (uncompressed) JSONL too.
 * @param {Buffer} buffer artifact bytes.
 * @returns {{text: string, frames: number, bytes: number, tornStart: number|undefined}}
 */
export function decodeLogBuffer(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    assertZstdAvailable();
    const { frames, tornStart } = scanZstdFrames(buffer);
    const parts = [];
    for (const frame of frames) {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
    }
    return { text: parts.join(''), frames: frames.length, bytes: buffer.length, tornStart };
  }
  return { text: buffer.toString('utf8'), frames: 0, bytes: buffer.length, tornStart: undefined };
}

/** Parse JSONL text into events, skipping blank or malformed lines. */
export function parseEventLines(text) {
  const events = [];
  // Tolerate a UTF-8 BOM on hand-written or exported logs (never on harness logs).
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.type === 'string') events.push(value);
    } catch {
      /* a torn tail line is expected while the session is live */
    }
  }
  return events;
}

/**
 * Read and parse a session log.
 * @param {string} logPath path to `session.v<N>.jsonl[.zstd]`.
 * @returns {{events: object[], frames: number, bytes: number, tornStart: number|undefined}}
 */
export function readSessionLog(logPath) {
  const decoded = decodeLogBuffer(fs.readFileSync(logPath));
  const events = parseEventLines(decoded.text);
  return { events, frames: decoded.frames, bytes: decoded.bytes, tornStart: decoded.tornStart };
}

/** Read only the header frame — cheap identity check for a session log. */
export function readSessionHeader(logPath) {
  const buffer = fs.readFileSync(logPath);
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    assertZstdAvailable();
    const { frames } = scanZstdFrames(buffer);
    if (frames.length === 0) return null;
    const first = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8');
    return parseEventLines(first)[0] ?? null;
  }
  return parseEventLines(buffer.toString('utf8'))[0] ?? null;
}

/**
 * Human-navigable project directory key for a workspace path (mirrors the
 * persistence backend: separators collapse to `-`, unsafe units become `~XXXX`).
 */
export function projectKey(cwd) {
  if (!cwd) throw new Error('projectKey requires a cwd');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** Encode an arbitrary string as one safe path segment (mirrors the backend). */
export function encodeSegment(raw) {
  if (!raw) throw new Error('encodeSegment requires a non-empty string');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Resolve the DSH home directory. */
export function resolveDshHome(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

/** Newest canonical log generation inside one session directory, or undefined. */
export function newestLogIn(sessionDir) {
  let entries;
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LOG_RE.exec(entry.name);
    if (!match) continue;
    found.push({ path: path.join(sessionDir, entry.name), version: Number(match[1]), zstd: entry.name.endsWith('.zstd') });
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => b.version - a.version || Number(b.zstd) - Number(a.zstd));
  return found[0].path;
}

function listDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Find the session log for a session id / workspace.
 *
 * Order: exact backend path, then an id scan across project directories, then
 * the newest log in the workspace's project directory. When an id is given the
 * header must match it, so a stale or partial path can never be measured.
 *
 * @returns {{logPath: string, sessionId: string, cwd: string|undefined, header: object|null, via: string}}
 */
export function findSessionLog({ sessionId, cwd, dshHome } = {}) {
  const root = path.join(resolveDshHome(dshHome), 'sessions');
  const wanted = sessionId ?? process.env.DSH_SESSION_ID;
  const workspace = cwd ?? process.cwd();

  const accept = (logPath, via) => {
    const header = readSessionHeader(logPath);
    if (wanted && header?.id && header.id !== wanted) return null;
    return { logPath, sessionId: header?.id ?? wanted, cwd: header?.cwd ?? workspace, header, via };
  };

  if (wanted) {
    const direct = newestLogIn(path.join(root, projectKey(workspace), encodeSegment(wanted)));
    if (direct) {
      const hit = accept(direct, 'direct');
      if (hit) return hit;
    }
    for (const projectDir of listDirs(root)) {
      const candidate = newestLogIn(path.join(projectDir, encodeSegment(wanted)));
      if (!candidate) continue;
      const hit = accept(candidate, 'id-scan');
      if (hit) return hit;
    }
    for (const projectDir of listDirs(root)) {
      for (const sessionDir of listDirs(projectDir)) {
        const candidate = newestLogIn(sessionDir);
        if (!candidate) continue;
        const header = readSessionHeader(candidate);
        if (header?.id === wanted) return { logPath: candidate, sessionId: wanted, cwd: header.cwd, header, via: 'deep-scan' };
      }
    }
    const error = new Error(
      `no DSH session log found for session id "${wanted}". Pass --log <path> or --session <id>, or set DSH_SESSION_ID.`,
    );
    error.code = 'ENOLOG';
    throw error;
  }

  const projectDirs = cwd ? [path.join(root, projectKey(workspace))] : listDirs(root);
  let best;
  for (const projectDir of projectDirs) {
    for (const sessionDir of listDirs(projectDir)) {
      const candidate = newestLogIn(sessionDir);
      if (!candidate) continue;
      const stamp = mtimeOf(candidate);
      if (!best || stamp > best.stamp) best = { path: candidate, stamp };
    }
  }
  if (!best) {
    const error = new Error(`no session log found under ${root}. Pass --log <path> or set DSH_SESSION_ID.`);
    error.code = 'ENOLOG';
    throw error;
  }
  const header = readSessionHeader(best.path);
  return { logPath: best.path, sessionId: header?.id, cwd: header?.cwd ?? workspace, header, via: 'newest' };
}
