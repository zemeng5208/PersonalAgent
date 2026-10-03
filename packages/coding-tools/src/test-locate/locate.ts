import {realpathSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {isAbsolute, resolve, relative, sep} from 'node:path';
import {ProtocolError} from '@personal-agent/contracts';

/** Deterministic failure locator for `node --test` output; no model, no side effects. */
export interface TestFailureFrame {
  file: string;
  line: number;
  column?: number;
  snippet?: string;
  confidence: number;
}

export interface TestFailure {
  name: string;
  error: string;
  frames: TestFailureFrame[];
  timedOut: boolean;
  reporter: 'spec' | 'tap';
}

export interface TestFailureReport {
  failures: TestFailure[];
  totalFailures: number;
}

export interface TestLocateOptions {
  /** Repository root used to classify frames and read snippets. Defaults to process.cwd(). */
  root?: string;
  /** Context lines around each suspect frame. Default 2, max 8. */
  contextLines?: number;
  /** Maximum accepted input length. Default 2 MiB. */
  maxInputBytes?: number;
}

interface RawFailure {
  name: string;
  errorLines: string[];
  frames: {file: string; line: number; column?: number}[];
  timedOut: boolean;
}

const STACK_FRAME = /^\s*at\s+(?:async\s+)?[^\s(]*\s*\(?(?:file:\/\/\/)?([^()]+?):(\d+)(?::(\d+))?\)?\s*$/u;
const INTERNAL = /(^|\/)node:internal\//u;
const NODE_MODULES = /(^|\/)node_modules\//u;
const SOURCE_FILE = /\.m?[jt]sx?$/u;

function invalid(message: string): never { throw new ProtocolError('INVALID_ARGUMENT', message); }

function toPosix(path: string): string { return sep === '\\' ? path.replace(/\\/g, '/') : path; }

function absoluteOf(raw: string, root: string): string {
  let candidate = raw;
  if (candidate.startsWith('file://')) {
    try { candidate = decodeURIComponent(new URL(candidate).pathname); } catch { /* keep raw */ }
  }
  if (!isAbsolute(candidate)) candidate = resolve(root, candidate);
  return candidate;
}

/** Repo-relative when inside root; otherwise the normalized original path. */
function displayPath(raw: string, root: string): string {
  const absolute = absoluteOf(raw, root);
  const rel = relative(root, absolute);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  return toPosix(raw);
}

function extractFrames(lines: readonly string[], root: string): {file: string; line: number; column?: number}[] {
  const frames = [];
  for (const rawLine of lines) {
    const match = STACK_FRAME.exec(rawLine);
    if (!match) continue;
    const file = match[1]!.trim();
    if (!file || INTERNAL.test(file) || NODE_MODULES.test(file) || !SOURCE_FILE.test(file)) continue;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    const column = match[3] === undefined ? undefined : Number(match[3]);
    frames.push({file: displayPath(file, root), line,
      ...(column !== undefined && Number.isSafeInteger(column) && column >= 0 ? {column} : {})});
  }
  return frames.slice(0, 32);
}

function classifyTimeout(name: string, errorText: string): boolean {
  return /timed?[ -]?out|Test timed out|operation timed out/i.test(`${name} ${errorText}`);
}

/** spec reporter: run summary "✖ name (12ms)" plus trailing "✖ failing tests:" detail blocks. */
function parseSpec(output: string, root: string): RawFailure[] {
  const byName = new Map<string, RawFailure>();
  const failures: RawFailure[] = [];
  const summaryName = /^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/u;
  const detailName = /^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*\((?:[\d.]+m?s)\)\s*$/u;
  const lines = output.split('\n');
  let inDetail = false;
  let current: RawFailure | undefined;
  let atLines: string[] = [];

  const flushFrames = () => {
    if (current && atLines.length) {
      const frames = extractFrames(atLines, root);
      if (frames.length) current.frames = frames;
      atLines = [];
    } else atLines = [];
  };
  const open = (name: string) => {
    flushFrames();
    const key = name;
    let failure = byName.get(key);
    if (!failure) { failure = {name, errorLines: [], frames: [], timedOut: false}; byName.set(key, failure); failures.push(failure); }
    current = failure;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^✖ failing tests:/u.test(line)) { flushFrames(); inDetail = true; current = undefined; continue; }
    const header = inDetail ? detailName.exec(line) ?? summaryName.exec(line) : summaryName.exec(line);
    if (/^✖\s+/u.test(line) && header) { open(header[1]!.trim()); continue; }
    if (!current) continue;
    if (/^\s*at\s/u.test(line)) { atLines.push(line); continue; }
    flushFrames();
    if (current.errorLines.length < 4 && line.trim() && !/^(ℹ|✔|✖|#)/u.test(line)) {
      current.errorLines.push(line.trim());
    }
  }
  flushFrames();
  for (const failure of failures) failure.timedOut = classifyTimeout(failure.name, failure.errorLines.join(' '));
  return failures;
}

/** TAP: "not ok 1 - name" with YAML-ish indented error and stack. */
function parseTap(output: string, root: string): RawFailure[] {
  const failures: RawFailure[] = [];
  let current: RawFailure | undefined;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const notOk = /^not ok\s+(?:\d+\s+-\s+)?(.+)$/u.exec(line);
    if (notOk) {
      current = {name: notOk[1]!.replace(/ # Timeouts?$/u, '').trim(), errorLines: [], frames: [], timedOut: false};
      failures.push(current);
      continue;
    }
    if (!current) continue;
    if (/^(\s{4}|\s{2})error: /u.test(line)) { current.errorLines.push(line.trim()); continue; }
    if (/^\s+at\s/u.test(line)) {
      const frame = extractFrames([line], root)[0];
      if (frame && !current.frames.some(f => f.file === frame.file && f.line === frame.line)) current.frames.push(frame);
    }
  }
  for (const failure of failures) failure.timedOut = classifyTimeout(failure.name, failure.errorLines.join(' '));
  return failures;
}

function readSnippet(file: string, line: number, context: number, root: string): string | undefined {
  try {
    const content = readFileSync(absoluteOf(file, root), 'utf8');
    const lines = content.split('\n');
    if (line > lines.length || line < 1) return undefined;
    const from = Math.max(1, line - context);
    const to = Math.min(lines.length, line + context);
    const parts = [];
    for (let i = from; i <= to; i++) parts.push(`${i === line ? '>' : ' '} ${i} ${lines[i - 1]}`);
    return parts.join('\n').slice(0, 4000);
  } catch { return undefined; }
}

function scoreFrame(index: number, total: number, file: string, timedOut: boolean): number {
  let score = Math.max(0.1, 1 - index * 0.15);
  if (total === 1) score = Math.max(score, 0.6);
  if (/\.test\.m?js$/u.test(file) || /\/test\//u.test(file)) score *= 0.85;
  if (timedOut) score *= 0.7;
  return Math.round(Math.min(1, score) * 100) / 100;
}

export function locateTestFailures(output: string, options: TestLocateOptions = {}): TestFailureReport {
  if (typeof output !== 'string') invalid('Test output must be a string');
  const maxBytes = options.maxInputBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) invalid('Invalid input byte limit');
  if (Buffer.byteLength(output) > maxBytes) invalid('Test output exceeds the configured byte limit');
  const contextLines = options.contextLines ?? 2;
  if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 8) invalid('Invalid context line count');
  const root = realpathSync.native(options.root ?? process.cwd());
  const isTap = /^TAP version/mu.test(output) || /^not ok /mu.test(output);
  const parsed = isTap ? parseTap(output, root) : parseSpec(output, root);
  const seen = new Set<string>();
  const failures: TestFailure[] = parsed
    .filter(f => f.name.length > 0 && f.name.length <= 4096)
    .filter(f => { const key = `${f.name}#${f.frames[0]?.file ?? ''}:${f.frames[0]?.line ?? 0}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 64)
    .map(f => ({
      name: f.name,
      error: f.errorLines.join('\n').slice(0, 2000) || '(no error message captured)',
      timedOut: f.timedOut,
      reporter: isTap ? 'tap' as const : 'spec' as const,
      frames: f.frames.map((frame, index): TestFailureFrame => ({
        ...frame,
        ...(readSnippet(frame.file, frame.line, contextLines, root) !== undefined
          ? {snippet: readSnippet(frame.file, frame.line, contextLines, root) as string}
          : {}),
        confidence: scoreFrame(index, f.frames.length, frame.file, f.timedOut),
      })),
    }));
  return {failures, totalFailures: failures.length};
  return {failures, totalFailures: failures.length};
}
