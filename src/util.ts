/**
 * Shared small utilities.
 */
import * as path from 'node:path';

export function stripExt(p: string): string {
  return p.replace(/\.[^./\\]+$/, '');
}

export function basename(p: string, ext?: string): string {
  return path.basename(p, ext);
}

export function ensureDir(p: string): void {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(p, { recursive: true });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
