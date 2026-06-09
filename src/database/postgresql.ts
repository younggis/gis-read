import type { DatabaseColumn } from './schema.js';
import { normalizeTableName, validateDatabaseIdentifier, type DatabaseTableName } from './naming.js';

export { normalizeTableName, type DatabaseTableName } from './naming.js';

export function buildPostgresCreateTableSQL(table: DatabaseTableName, columns: DatabaseColumn[], geomColumn: string): string {
  const attrs = columns.map((column) => `${quote(column.name)} ${postgresType(column.type)}`);
  return `CREATE TABLE ${quoteTable(table)} (${['"id" BIGSERIAL PRIMARY KEY', ...attrs, `${quote(geomColumn)} geometry`].join(', ')})`;
}

export function buildPostgresInsertSQL(table: DatabaseTableName, columns: DatabaseColumn[], geomColumn: string, srid: number): string {
  const names = [...columns.map((column) => quote(column.name)), quote(geomColumn)];
  const values = columns.map((_, index) => `$${index + 1}`);
  values.push(`ST_GeomFromWKB($${columns.length + 1}, ${srid})`);
  return `INSERT INTO ${quoteTable(table)} (${names.join(', ')}) VALUES (${values.join(', ')})`;
}

export function buildPostgresSelectSQL(table: DatabaseTableName, columns: string[], geomColumn: string, where?: string): string {
  const attrs = columns.map(quote);
  const sql = `SELECT ${[...attrs, `ST_AsBinary(${quote(geomColumn)}) AS "__geom_wkb"`].join(', ')} FROM ${quoteTable(table)}`;
  return where ? `${sql} WHERE ${where}` : sql;
}

function postgresType(type: DatabaseColumn['type']): string {
  if (type === 'double') return 'DOUBLE PRECISION';
  if (type === 'boolean') return 'BOOLEAN';
  if (type === 'json') return 'JSONB';
  return 'TEXT';
}

function quoteTable(table: DatabaseTableName): string {
  return table.schema ? `${quote(table.schema)}.${quote(table.table)}` : quote(table.table);
}

function quote(name: string): string {
  validateDatabaseIdentifier(name);
  return `"${name.replace(/"/g, '""')}"`;
}
