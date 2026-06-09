import * as path from 'node:path';

export interface DatabaseTableName {
  schema?: string;
  table: string;
}

const IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

export function normalizeTableName(input: string): DatabaseTableName {
  const trimmed = input.trim();
  const parts = trimmed.split('.');
  if (!trimmed || parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid table name: ${input}`);
  }
  const table = parts.length === 1 ? { table: parts[0] } : { schema: parts[0], table: parts[1] };
  validateDatabaseTableName(table);
  return table;
}

export function inferDatabaseTableNameFromPath(inputPath: string): string {
  const table = path.basename(inputPath, path.extname(inputPath));
  validateDatabaseIdentifier(table);
  return table;
}

export function inferDatabaseOutputPathFromTable(tableName: string): string {
  const table = normalizeTableName(tableName);
  return `${table.table}.geojson`;
}

export function validateDatabaseTableName(table: DatabaseTableName): void {
  if (table.schema) validateDatabaseIdentifier(table.schema);
  validateDatabaseIdentifier(table.table);
}

export function validateDatabaseIdentifier(name: string): void {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`Invalid identifier: ${name}`);
}
