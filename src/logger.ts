/**
 * Structured logger.
 *
 * Provides a single `Logger` interface that can write timestamped, level-
 * filtered messages to one or more sinks (stderr, file, future log
 * aggregators). All CLI commands route their output through this module
 * so that log lines are uniform and machine-parseable.
 *
 * Format: `<ISO8601> <LEVEL> [<caller>] <message>`
 *
 * Use `--log-level` on the CLI to filter; default is `info`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogSink {
  write(line: string): void;
}

class StderrSink implements LogSink {
  private buffered = '';
  write(line: string): void {
    process.stderr.write(line + '\n');
  }
  // For test-isolation; not currently used by CLI.
  drain(): string {
    const b = this.buffered;
    this.buffered = '';
    return b;
  }
}

class FileSink implements LogSink {
  private stream: fs.WriteStream;
  constructor(path: string) {
    this.stream = fs.createWriteStream(path, { flags: 'a' });
  }
  write(line: string): void {
    this.stream.write(line + '\n');
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

import * as fs from 'node:fs';

export class Logger {
  private level: LogLevel = 'info';
  private sinks: LogSink[] = [];
  private timer: [number, number] | null = null;
  private tag: string;

  constructor(tag: string = 'gis') {
    this.tag = tag;
    this.sinks.push(new StderrSink());
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setTag(tag: string): void {
    this.tag = tag;
  }

  addFileSink(path: string): void {
    this.sinks.push(new FileSink(path));
  }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const ts = new Date().toISOString();
    const fieldsStr = fields && Object.keys(fields).length
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')
      : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${this.tag}] ${msg}${fieldsStr}`;
    for (const s of this.sinks) s.write(line);
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log('error', msg, fields); }

  /**
   * Time a long-running operation. Returns a `done` function that, when
   * called with `(msg?, fields?)`, logs the elapsed time. Useful for
   * measuring and reporting slow conversions.
   */
  startTimer(label: string): (msg?: string, fields?: Record<string, unknown>) => void {
    const start = process.hrtime.bigint();
    return (msg: string = `${label} done`, fields: Record<string, unknown> = {}) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      this.info(msg, { ...fields, elapsed_ms: Math.round(elapsed) });
    };
  }
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Global default logger; use this for most output. */
export const log = new Logger('gis');
