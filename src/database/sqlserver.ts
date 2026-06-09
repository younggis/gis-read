import type { DatabaseColumn } from './schema.js';
import { normalizeTableName, validateDatabaseIdentifier, type DatabaseTableName } from './naming.js';

export { normalizeTableName, type DatabaseTableName } from './naming.js';

export function buildSqlServerCreateTableSQL(table: DatabaseTableName, columns: DatabaseColumn[], geomColumn: string): string {
  const attrs = columns.map((column) => `${quote(column.name)} ${sqlServerType(column.type)}`);
  return `CREATE TABLE ${quoteTable(table)} (${['[id] BIGINT IDENTITY(1,1) PRIMARY KEY', ...attrs, `${quote(geomColumn)} geometry`].join(', ')})`;
}

export function buildSqlServerInsertSQL(table: DatabaseTableName, columns: DatabaseColumn[], geomColumn: string, srid: number): string {
  const names = [...columns.map((column) => quote(column.name)), quote(geomColumn)];
  const values = columns.map((column) => `@${column.name}`);
  values.push(`geometry::STGeomFromWKB(@${geomColumn}, ${srid})`);
  return `INSERT INTO ${quoteTable(table)} (${names.join(', ')}) VALUES (${values.join(', ')})`;
}

export function buildSqlServerSelectSQL(table: DatabaseTableName, columns: string[], geomColumn: string, where?: string): string {
  const attrs = columns.map(quote);
  const sql = `SELECT ${[...attrs, `${quote(geomColumn)}.STAsBinary() AS [__geom_wkb]`].join(', ')} FROM ${quoteTable(table)}`;
  return where ? `${sql} WHERE ${where}` : sql;
}

function sqlServerType(type: DatabaseColumn['type']): string {
  if (type === 'double') return 'FLOAT';
  if (type === 'boolean') return 'BIT';
  if (type === 'json') return 'NVARCHAR(MAX)';
  return 'NVARCHAR(MAX)';
}

function quoteTable(table: DatabaseTableName): string {
  return table.schema ? `${quote(table.schema)}.${quote(table.table)}` : quote(table.table);
}

function quote(name: string): string {
  validateDatabaseIdentifier(name);
  return `[${name.replace(/]/g, ']]')}]`;
}
