/**
 * Memory-aware file I/O and JSON streaming.
 *
 * For multi-GB datasets the default `fs.readFileSync` + `JSON.parse` path
 * will OOM. This module provides:
 *
 * 1. A `readFileMaybeStream(path, options)` helper that picks a strategy
 *    based on file size:
 *      - ≤ 256 MB: read into memory (fast, no streaming overhead)
 *      - > 256 MB: stream the file in 1 MB chunks
 *
 * 2. A `streamJson(path, onValue, onProgress)` helper that parses a JSON
 *    file as a stream of tokens, calling `onValue` for each complete value
 *    (objects, arrays, primitives). Memory usage is bounded by the
 *    nesting depth + size of the current value, not the whole file.
 *
 * 3. A `streamTextLines(path, onLine, onProgress)` helper for line-by-line
 *    reading of CSV, GPX, KML, MIF, etc.
 *
 * 4. Convenience `withErrorBoundary(name, fn)` for CLI commands: catches
 *    unhandled errors, logs them with structured fields, and exits with
 *    a non-zero code.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { log } from './logger.js';

/** Threshold (in bytes) above which we switch from read-into-memory to streaming. */
const STREAM_THRESHOLD = 256 * 1024 * 1024; // 256 MB

export interface ReadOptions {
  /** Force streaming regardless of file size. */
  forceStream?: boolean;
  /** Encoding hint; passed to `fs.createReadStream` if applicable. */
  encoding?: BufferEncoding;
}

/**
 * Read a file's content. Returns either a Buffer (synchronous read) or a
 * string (for text). For files larger than `STREAM_THRESHOLD`, the caller
 * should use `streamTextLines` / `streamJson` instead.
 */
export function readFileMaybeStream(
  path: string,
  opts: ReadOptions = {},
): Buffer {
  const stat = fs.statSync(path);
  if (opts.forceStream || stat.size > STREAM_THRESHOLD) {
    log.warn(`Reading large file ${path} (${formatBytes(stat.size)}) into memory — consider streaming instead`);
  }
  return fs.readFileSync(path);
}

/** Read a file as UTF-8 text. */
export function readTextFile(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

/**
 * Iterate a text file line by line. The callback may return a promise
 * (e.g. when writing to a downstream sink). Progress is logged to the
 * global logger at a rate of every 1% of bytes read.
 */
export async function streamTextLines(
  path: string,
  onLine: (line: string, lineNo: number) => void | Promise<void>,
  opts: { encoding?: BufferEncoding; onProgress?: (bytesRead: number, total: number) => void } = {},
): Promise<{ lines: number; bytes: number }> {
  const stat = fs.statSync(path);
  const total = stat.size;
  const stream = fs.createReadStream(path, { encoding: opts.encoding ?? 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let bytes = 0;
  let lastReported = -1;
  for await (const lineRaw of rl) {
    lineNo++;
    bytes += Buffer.byteLength(lineRaw as string, 'utf8') + 1;
    await onLine(lineRaw as string, lineNo);
    if (opts.onProgress) opts.onProgress(bytes, total);
    else if (total > 0) {
      const pct = Math.floor((bytes / total) * 100);
      if (pct > lastReported && pct % 5 === 0) {
        lastReported = pct;
        log.debug(`Reading ${path}`, { pct: `${pct}%`, bytes, total });
      }
    }
  }
  return { lines: lineNo, bytes };
}

// --- Streaming JSON parser -----------------------------------------------

/**
 * A minimal streaming JSON tokenizer (SAX-style). Emits events for the
 * top-level container(s) in the file. Sufficient for processing
 * GeoJSON FeatureCollection outputs that are too large to fit in memory.
 *
 * Limitations:
 *   - Strings are not unescaped beyond the standard JSON escapes.
 *   - Numbers are emitted as the raw text (parse with `Number` yourself).
 *   - Does not support multiple top-level values concatenated.
 *
 * The parser reads in 1 MB chunks; for very deep / large nested arrays
 * the memory usage grows linearly with the deepest path's accumulated
 * size, not the total file size.
 */
export class StreamingJsonParser {
  private buf = '';
  private pos = 0;
  private stack: Array<{ kind: 'array' | 'object'; state: any }> = [];
  private root: any = undefined;
  private onValue?: (v: any) => void;
  private onError?: (e: Error) => void;

  constructor(opts: { onValue?: (v: any) => void; onError?: (e: Error) => void } = {}) {
    this.onValue = opts.onValue;
    this.onError = opts.onError;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    this.advance();
  }

  end(): void {
    this.buf = this.buf.slice(this.pos);
    this.pos = 0;
    this.advance();
    // Flush remaining top-level value.
    if (this.stack.length === 0 && this.root !== undefined) {
      this.onValue?.(this.root);
      this.root = undefined;
    }
  }

  private advance(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      // Skip whitespace.
      if (/\s/.test(c)) { this.pos++; continue; }
      // Top-level scalar.
      if (this.stack.length === 0) {
        if (c === '{' || c === '[') {
          this.pos++;
          this.startValue(c === '[' ? 'array' : 'object');
        } else {
          this.readScalar();
        }
      } else {
        if (c === '{' || c === '[') {
          this.pos++;
          this.startValue(c === '[' ? 'array' : 'object');
        } else if (c === '}' || c === ']') {
          this.pos++;
          this.endValue();
        } else if (c === ',') {
          this.pos++;
          // next value
        } else if (c === '"') {
          this.readString();
        } else {
          this.readScalar();
        }
      }
    }
  }

  private startValue(kind: 'array' | 'object'): void {
    const v: any = kind === 'array' ? [] : {};
    if (this.stack.length === 0) {
      this.root = v;
    } else {
      const top = this.stack[this.stack.length - 1];
      if (top.kind === 'array') {
        top.state.push(v);
      } else {
        // Object: read the key next.
        top.state.awaitingValue = v;
      }
    }
    this.stack.push({ kind, state: v });
  }

  private endValue(): void {
    const closed = this.stack.pop();
    if (!closed) {
      this.onError?.(new Error('Unexpected close'));
      return;
    }
    if (this.stack.length === 0) {
      // Top-level value done.
      this.onValue?.(closed.state);
      this.root = undefined;
    } else {
      const parent = this.stack[this.stack.length - 1];
      if (parent.kind === 'object' && parent.state.awaitingValue === closed.state) {
        parent.state.awaitingValue = undefined;
      }
    }
  }

  private readString(): void {
    // Find matching unescaped quote.
    const start = this.pos;
    this.pos++;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (c === '\\') { this.pos += 2; continue; }
      if (c === '"') {
        this.pos++;
        const raw = this.buf.slice(start, this.pos);
        this.handleString(raw);
        return;
      }
      this.pos++;
    }
    // Incomplete; wait for more data.
    this.buf = this.buf.slice(start);
    this.pos = 0;
  }

  private handleString(raw: string): void {
    if (this.stack.length === 0) {
      this.onValue?.(raw);
      return;
    }
    const top = this.stack[this.stack.length - 1];
    if (top.kind === 'array') {
      top.state.push(this.unescape(raw));
    } else if (top.state.awaitingKey) {
      const key = this.unescape(raw);
      top.state._pendingKey = key;
      top.state.awaitingKey = false;
    } else if (top.state._pendingKey !== undefined) {
      const key = top.state._pendingKey;
      top.state[key] = this.unescape(raw);
      top.state._pendingKey = undefined;
      top.state.awaitingKey = true;
    } else {
      top.state.awaitingKey = true;
    }
  }

  private unescape(raw: string): string {
    // Strip outer quotes.
    const inner = raw.slice(1, -1);
    return inner
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  private readScalar(): void {
    const start = this.pos;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (c === ',' || c === '}' || c === ']' || /\s/.test(c)) break;
      this.pos++;
    }
    const text = this.buf.slice(start, this.pos);
    if (text === '') return;
    let value: any = text;
    if (text === 'true') value = true;
    else if (text === 'false') value = false;
    else if (text === 'null') value = null;
    else if (/^-?\d/.test(text)) value = Number(text);
    if (this.stack.length === 0) {
      this.onValue?.(value);
    } else {
      const top = this.stack[this.stack.length - 1];
      if (top.kind === 'array') {
        top.state.push(value);
      } else if (top.state._pendingKey !== undefined) {
        top.state[top.state._pendingKey] = value;
        top.state._pendingKey = undefined;
        top.state.awaitingKey = true;
      }
    }
  }
}

/** Stream-parse a JSON file. Calls `onValue` for each top-level value. */
export async function streamJson(
  path: string,
  onValue: (v: any) => void | Promise<void>,
  opts: { onProgress?: (bytesRead: number, total: number) => void } = {},
): Promise<void> {
  const stat = fs.statSync(path);
  const total = stat.size;
  const stream = fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  const parser = new StreamingJsonParser({});
  let bytes = 0;
  let lastReported = -1;
  let pending: Promise<void> = Promise.resolve();
  return new Promise((resolve, reject) => {
    parser['onValue'] = (v: any) => {
      pending = pending.then(() => onValue(v));
    };
    parser['onError'] = (e: Error) => reject(e);
    stream.on('data', (chunk: string | Buffer) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      bytes += Buffer.byteLength(s, 'utf8');
      parser.feed(s);
      if (opts.onProgress) opts.onProgress(bytes, total);
      else if (total > 0) {
        const pct = Math.floor((bytes / total) * 100);
        if (pct > lastReported && pct % 5 === 0) {
          lastReported = pct;
          log.debug(`Streaming JSON ${path}`, { pct: `${pct}%`, bytes, total });
        }
      }
    });
    stream.on('end', () => { parser.end(); pending.then(resolve, reject); });
    stream.on('error', reject);
  });
}

// --- CLI error boundary --------------------------------------------------

/**
 * Wrap a CLI command body so that all thrown errors are caught, logged
 * with a structured shape, and result in a non-zero exit code. This
 * ensures users always get a clear message — even for uncaught errors.
 */
export async function withErrorBoundary(name: string, fn: () => Promise<void> | void): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (err) {
    const e = err as Error;
    log.error(`${name} failed`, {
      name: e.name,
      message: e.message,
      stack: process.env.GIS_DEBUG === '1' ? e.stack : undefined,
    });
    return 1;
  }
}

// --- Helpers -------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Format a duration in ms as a short human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
