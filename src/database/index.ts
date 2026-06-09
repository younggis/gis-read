import type { Format } from '../format-detect.js';
import type { Feature, ParseResult } from '../types.js';
import { detectFormat } from '../format-detect.js';
import { parseFile, writeFile } from '../parsers/index.js';
import { transformFeatures } from '../crs.js';
import { encodeWKB, decodeWKB } from './wkb.js';
import { inferDatabaseColumns, type DatabaseColumn } from './schema.js';
import {
  buildPostgresCreateTableSQL,
  buildPostgresInsertSQL,
  buildPostgresSelectSQL,
  normalizeTableName as normalizePostgresTableName,
} from './postgresql.js';
import {
  buildSqlServerCreateTableSQL,
  buildSqlServerInsertSQL,
  buildSqlServerSelectSQL,
  normalizeTableName as normalizeSqlServerTableName,
} from './sqlserver.js';
import {
  inferDatabaseOutputPathFromTable,
  inferDatabaseTableNameFromPath,
} from './naming.js';

export type DatabaseKind = 'postgresql' | 'sqlserver';

export interface DatabaseConnectionOptions {
  db: DatabaseKind;
  connection?: string;
}

export interface DatabaseImportOptions extends DatabaseConnectionOptions {
  table?: string;
  geomColumn?: string;
  srid?: number;
  fromCrs?: string;
  toCrs?: string;
}

export interface DatabaseExportOptions extends DatabaseConnectionOptions {
  table: string;
  outputPath?: string;
  outputFormat?: Format;
  geomColumn?: string;
  where?: string;
}

export interface DatabaseTransferSummary {
  db: DatabaseKind;
  table: string;
  featureCount: number;
  geomColumn: string;
  srid?: number;
  outputPath?: string;
}

type DbRow = Record<string, unknown>;

export async function importFileToDatabase(inputPath: string, options: DatabaseImportOptions): Promise<DatabaseTransferSummary> {
  const table = options.table ?? inferDatabaseTableNameFromPath(inputPath);
  const result = parseFile(inputPath);
  return writeDatabaseTable(result, {
    ...options,
    table,
  });
}

export async function exportDatabaseTable(options: DatabaseExportOptions): Promise<DatabaseTransferSummary> {
  const outputPath = options.outputPath ?? inferDatabaseOutputPathFromTable(options.table);
  const format = options.outputFormat ?? detectFormat(outputPath);
  if (!format || format === 'unknown') throw new Error(`Cannot determine output format for: ${outputPath}`);
  const result = await readDatabaseTable(options);
  writeFile(result, outputPath, format);
  return {
    db: options.db,
    table: options.table,
    featureCount: result.features.length,
    geomColumn: options.geomColumn ?? 'geom',
    outputPath,
  };
}

export async function writeDatabaseTable(result: ParseResult, options: DatabaseImportOptions & { table: string }): Promise<DatabaseTransferSummary> {
  const geomColumn = options.geomColumn ?? 'geom';
  const srid = options.srid ?? 4326;
  const features = cloneFeatures(result.features);
  const sourceCrs = options.fromCrs ?? result.crs?.properties.name ?? 'WGS84';
  if (options.toCrs && sourceCrs !== options.toCrs) transformFeatures(features as any, sourceCrs, options.toCrs);
  const columns = inferDatabaseColumns(features);
  const connection = resolveConnection(options);
  if (options.db === 'postgresql') await writePostgresTable(connection, options.table, columns, geomColumn, srid, features);
  else await writeSqlServerTable(connection, options.table, columns, geomColumn, srid, features);
  return { db: options.db, table: options.table, featureCount: features.length, geomColumn, srid };
}

export async function readDatabaseTable(options: DatabaseExportOptions): Promise<ParseResult> {
  const geomColumn = options.geomColumn ?? 'geom';
  const connection = resolveConnection(options);
  const rows = options.db === 'postgresql'
    ? await readPostgresRows(connection, options.table, geomColumn, options.where)
    : await readSqlServerRows(connection, options.table, geomColumn, options.where);
  return {
    name: options.table.replace(/^.*\./, ''),
    features: rows.map(rowToFeature),
    crs: { type: 'name', properties: { name: 'EPSG:4326' } },
    meta: { source: options.db, table: options.table, geomColumn },
  };
}

function resolveConnection(options: DatabaseConnectionOptions): string {
  const connection = options.connection
    || (options.db === 'postgresql' ? process.env.GIS_READ_PG_CONNECTION : process.env.GIS_READ_MSSQL_CONNECTION);
  if (!connection) {
    const envName = options.db === 'postgresql' ? 'GIS_READ_PG_CONNECTION' : 'GIS_READ_MSSQL_CONNECTION';
    throw new Error(`Database connection is required. Pass --connection or set ${envName}.`);
  }
  return connection;
}

async function writePostgresTable(connection: string, tableName: string, columns: DatabaseColumn[], geomColumn: string, srid: number, features: Feature[]): Promise<void> {
  const pg = await importOptional('pg', 'PostgreSQL support requires the "pg" package. Run npm install first.');
  const client = new pg.Client({ connectionString: connection });
  const table = normalizePostgresTableName(tableName);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(buildPostgresCreateTableSQL(table, columns, geomColumn));
    const insertSQL = buildPostgresInsertSQL(table, columns, geomColumn, srid);
    for (const feature of features) {
      await client.query(insertSQL, [...columns.map((column) => normalizeValue(feature.properties?.[column.sourceName])), geometryToWkb(feature)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function readPostgresRows(connection: string, tableName: string, geomColumn: string, where?: string): Promise<DbRow[]> {
  const pg = await importOptional('pg', 'PostgreSQL support requires the "pg" package. Run npm install first.');
  const client = new pg.Client({ connectionString: connection });
  const table = normalizePostgresTableName(tableName);
  await client.connect();
  try {
    const columnRows = await client.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2) AND column_name <> $3 ORDER BY ordinal_position',
      [table.table, table.schema ?? null, geomColumn],
    );
    const columns = columnRows.rows.map((row: { column_name: string }) => row.column_name).filter((name: string) => name !== 'id');
    const rows = await client.query(buildPostgresSelectSQL(table, columns, geomColumn, where));
    return rows.rows;
  } finally {
    await client.end();
  }
}

async function writeSqlServerTable(connection: string, tableName: string, columns: DatabaseColumn[], geomColumn: string, srid: number, features: Feature[]): Promise<void> {
  const mssql = await importOptional('mssql', 'SQL Server support requires the "mssql" package. Run npm install first.');
  const pool = await mssql.connect(connection);
  const table = normalizeSqlServerTableName(tableName);
  const transaction = new mssql.Transaction(pool);
  await transaction.begin();
  try {
    await new mssql.Request(transaction).query(buildSqlServerCreateTableSQL(table, columns, geomColumn));
    const insertSQL = buildSqlServerInsertSQL(table, columns, geomColumn, srid);
    for (const feature of features) {
      const request = new mssql.Request(transaction);
      for (const column of columns) request.input(column.name, normalizeValue(feature.properties?.[column.sourceName]));
      request.input(geomColumn, mssql.VarBinary, geometryToWkb(feature));
      await request.query(insertSQL);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  } finally {
    await pool.close();
  }
}

async function readSqlServerRows(connection: string, tableName: string, geomColumn: string, where?: string): Promise<DbRow[]> {
  const mssql = await importOptional('mssql', 'SQL Server support requires the "mssql" package. Run npm install first.');
  const pool = await mssql.connect(connection);
  const table = normalizeSqlServerTableName(tableName);
  try {
    const columnsResult = await pool.request()
      .input('table', table.table)
      .input('schema', table.schema ?? 'dbo')
      .input('geom', geomColumn)
      .query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @table AND TABLE_SCHEMA = @schema AND COLUMN_NAME <> @geom ORDER BY ORDINAL_POSITION');
    const columns = columnsResult.recordset.map((row: { COLUMN_NAME: string }) => row.COLUMN_NAME).filter((name: string) => name !== 'id');
    const result = await pool.request().query(buildSqlServerSelectSQL(table, columns, geomColumn, where));
    return result.recordset;
  } finally {
    await pool.close();
  }
}

async function importOptional(name: string, message: string): Promise<any> {
  try {
    return await import(name);
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') throw new Error(message);
    throw error;
  }
}

function cloneFeatures(features: Feature[]): Feature[] {
  return features.map((feature) => ({
    ...feature,
    properties: { ...(feature.properties ?? {}) },
    geometry: feature.geometry ? JSON.parse(JSON.stringify(feature.geometry)) : null,
  }));
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function geometryToWkb(feature: Feature): Buffer | null {
  return feature.geometry ? encodeWKB(feature.geometry) : null;
}

function rowToFeature(row: DbRow): Feature {
  const properties: Record<string, unknown> = {};
  let geometry = null;
  for (const [key, value] of Object.entries(row)) {
    if (key === '__geom_wkb') geometry = value ? decodeWKB(Buffer.from(value as Uint8Array)) : null;
    else properties[key] = value;
  }
  return { type: 'Feature', properties, geometry };
}

export { encodeWKB, decodeWKB } from './wkb.js';
export { inferDatabaseColumns } from './schema.js';
export {
  inferDatabaseOutputPathFromTable,
  inferDatabaseTableNameFromPath,
  validateDatabaseIdentifier,
  validateDatabaseTableName,
} from './naming.js';
