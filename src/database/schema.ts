import type { Feature } from '../types.js';

export type DatabaseColumnType = 'text' | 'double' | 'boolean' | 'json';

export interface DatabaseColumn {
  name: string;
  sourceName: string;
  type: DatabaseColumnType;
}

export function inferDatabaseColumns(features: Feature[]): DatabaseColumn[] {
  const seen = new Set<string>(['id']);
  const columns: DatabaseColumn[] = [];
  const sourceNames: string[] = [];
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) {
      if (!sourceNames.includes(key)) sourceNames.push(key);
    }
  }

  for (const sourceName of sourceNames) {
    const base = sanitizeIdentifier(sourceName);
    let name = base;
    let index = 1;
    while (seen.has(name)) {
      name = `${base}_${index}`;
      index++;
    }
    seen.add(name);
    columns.push({ name, sourceName, type: inferColumnType(features, sourceName) });
  }
  return columns;
}

export function sanitizeIdentifier(input: string): string {
  const normalized = input.trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  const safe = normalized || 'field';
  return /^\p{L}|_/u.test(safe) ? safe : `f_${safe}`;
}

function inferColumnType(features: Feature[], sourceName: string): DatabaseColumnType {
  let type: DatabaseColumnType | undefined;
  for (const feature of features) {
    const value = feature.properties?.[sourceName];
    if (value === null || value === undefined) continue;
    const next = typeof value === 'number'
      ? 'double'
      : typeof value === 'boolean'
        ? 'boolean'
        : typeof value === 'string'
          ? 'text'
          : 'json';
    if (!type) type = next;
    else if (type !== next) return 'text';
  }
  return type ?? 'text';
}
