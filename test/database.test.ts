import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  exportDatabaseTable,
  importFileToDatabase,
  inferDatabaseOutputPathFromTable,
  inferDatabaseTableNameFromPath,
  normalizeMssqlModule,
  resolveDatabaseGeometryColumn,
  wrapSqlServerConnectionError,
} from '../src/database/index.js';
import { decodeWKB, encodeWKB } from '../src/database/wkb.js';
import {
  buildPostgresCreateTableSQL,
  buildPostgresInsertSQL,
  normalizeTableName as normalizePostgresTableName,
} from '../src/database/postgresql.js';
import {
  buildSqlServerCreateTableSQL,
  buildSqlServerInsertSQL,
  normalizeTableName as normalizeSqlServerTableName,
} from '../src/database/sqlserver.js';
import { inferDatabaseColumns } from '../src/database/schema.js';
import { parseGeoJSON } from '../src/parsers/geojson.js';
import type { Feature } from '../src/types.js';

test('WKB round-trips common 2D geometry types', () => {
  const geometries = [
    { type: 'Point', coordinates: [116.391, 39.907] },
    { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
    { type: 'LineString', coordinates: [[1, 2], [3, 4]] },
    { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 2]]],
      ],
    },
  ];

  for (const geometry of geometries) {
    assert.deepEqual(decodeWKB(encodeWKB(geometry)), geometry);
  }
});

test('inferDatabaseColumns sanitizes names and preserves property mapping', () => {
  const features: Feature[] = [
    {
      type: 'Feature',
      properties: {
        id: 1,
        'name zh': '成都',
        value: 10,
        value_1: 20,
        active: true,
        nested: { a: 1 },
      },
      geometry: null,
    },
  ];

  const columns = inferDatabaseColumns(features);

  assert.deepEqual(columns.map((column) => [column.name, column.sourceName, column.type]), [
    ['id_1', 'id', 'double'],
    ['name_zh', 'name zh', 'text'],
    ['value', 'value', 'double'],
    ['value_1', 'value_1', 'double'],
    ['active', 'active', 'boolean'],
    ['nested', 'nested', 'json'],
  ]);
});

test('inferDatabaseColumns avoids case-insensitive collision with internal id column', () => {
  const columns = inferDatabaseColumns([
    { type: 'Feature', properties: { ID: 1, Name: 'lake' }, geometry: null },
  ]);

  assert.deepEqual(columns.map((column) => [column.name, column.sourceName]), [
    ['ID_1', 'ID'],
    ['Name', 'Name'],
  ]);
});

test('PostgreSQL SQL builders quote identifiers and use PostGIS WKB functions', () => {
  const table = normalizePostgresTableName('public.roads');
  const columns = inferDatabaseColumns([
    { type: 'Feature', properties: { name: 'A', lanes: 2 }, geometry: null },
  ]);

  const createSQL = buildPostgresCreateTableSQL(table, columns, 'geom');
  const insertSQL = buildPostgresInsertSQL(table, columns, 'geom', 4326);

  assert.match(createSQL, /CREATE TABLE "public"\."roads"/);
  assert.match(createSQL, /"geom" geometry/);
  assert.match(insertSQL, /ST_GeomFromWKB\(\$\d+, 4326\)/);
  assert.match(insertSQL, /INSERT INTO "public"\."roads"/);
});

test('SQL Server SQL builders quote identifiers and use geometry WKB functions', () => {
  const table = normalizeSqlServerTableName('dbo.roads');
  const columns = inferDatabaseColumns([
    { type: 'Feature', properties: { name: 'A', lanes: 2 }, geometry: null },
  ]);

  const createSQL = buildSqlServerCreateTableSQL(table, columns, 'geom');
  const insertSQL = buildSqlServerInsertSQL(table, columns, 'geom', 4326);

  assert.match(createSQL, /CREATE TABLE \[dbo\]\.\[roads\]/);
  assert.match(createSQL, /\[geom\] geometry/);
  assert.match(insertSQL, /geometry::STGeomFromWKB\(@geom, 4326\)/);
  assert.match(insertSQL, /INSERT INTO \[dbo\]\.\[roads\]/);
});

test('normalizeMssqlModule resolves CommonJS default exports', () => {
  const api = { connect: () => undefined, Request: class {}, Transaction: class {}, VarBinary: Symbol('varbinary') };
  assert.equal(normalizeMssqlModule(api), api);
  assert.equal(normalizeMssqlModule({ default: api }), api);
  assert.throws(
    () => normalizeMssqlModule({ default: {} }),
    /mssql package did not expose connect/i,
  );
});

test('wrapSqlServerConnectionError explains unsupported TLS protocol failures', () => {
  const error = new Error('Failed to connect - ssl_choose_client_version:unsupported protocol');
  const wrapped = wrapSqlServerConnectionError(error);

  assert.equal(wrapped, error);
  assert.match(wrapped.message, /SQL Server TLS handshake failed/i);
  assert.match(wrapped.message, /Encrypt=false/);
  assert.match(wrapped.message, /TLS 1\.2/);
});

test('resolveDatabaseGeometryColumn auto-detects geometry columns for export', () => {
  assert.equal(resolveDatabaseGeometryColumn(undefined, ['Shape'], 'dbo.t_gis_county'), 'Shape');
  assert.equal(resolveDatabaseGeometryColumn('shape', ['Shape'], 'dbo.t_gis_county'), 'Shape');
  assert.throws(
    () => resolveDatabaseGeometryColumn('geom', ['Shape'], 'dbo.t_gis_county'),
    /Geometry column "geom" was not found/i,
  );
  assert.throws(
    () => resolveDatabaseGeometryColumn(undefined, [], 'dbo.t_gis_county'),
    /No geometry or geography column/i,
  );
  assert.throws(
    () => resolveDatabaseGeometryColumn(undefined, ['Shape', 'Center'], 'dbo.t_gis_county'),
    /Multiple geometry or geography columns/i,
  );
});

test('database import infers a valid target table name from the input filename', () => {
  assert.equal(inferDatabaseTableNameFromPath(path.join('fixtures', 'roads.geojson')), 'roads');
  assert.equal(inferDatabaseTableNameFromPath(path.join('fixtures', '道路.geojson')), '道路');
  assert.throws(
    () => inferDatabaseTableNameFromPath(path.join('fixtures', 'bad-name.geojson')),
    /Invalid identifier/,
  );
});

test('database export infers a GeoJSON output path from the table name', () => {
  assert.equal(inferDatabaseOutputPathFromTable('roads'), 'roads.geojson');
  assert.equal(inferDatabaseOutputPathFromTable('public.roads'), 'roads.geojson');
  assert.equal(inferDatabaseOutputPathFromTable('dbo.道路'), '道路.geojson');
  assert.throws(
    () => inferDatabaseOutputPathFromTable('public.bad-name'),
    /Invalid identifier/,
  );
});

test('PostGIS integration imports and exports a vector table', {
  skip: process.env.GIS_READ_TEST_PG_CONNECTION ? false : 'GIS_READ_TEST_PG_CONNECTION is not set',
}, async () => {
  const connection = process.env.GIS_READ_TEST_PG_CONNECTION!;
  const tableBase = `gis_read_integration_${Date.now()}`;
  const table = `public.${tableBase}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gis-read-db-'));
  const input = path.join(dir, `${tableBase}.geojson`);
  const output = path.join(dir, 'output.geojson');
  fs.writeFileSync(input, JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { id: 1, name: 'point' }, geometry: { type: 'Point', coordinates: [116.391, 39.907] } },
      { type: 'Feature', properties: { id: 2, name: 'line' }, geometry: { type: 'LineString', coordinates: [[116.391, 39.907], [116.4, 39.91]] } },
    ],
  }));

  const pg = await import('pg');
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await client.query(`DROP TABLE IF EXISTS ${table}`);

    const imported = await importFileToDatabase(input, {
      db: 'postgresql',
      connection,
      srid: 4326,
    });
    assert.equal(imported.featureCount, 2);
    assert.equal(imported.table, tableBase);

    const count = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    assert.equal(count.rows[0].n, 2);
    const column = await client.query(
      "SELECT udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'geom'",
      [table.replace(/^public\./, '')],
    );
    assert.equal(column.rows[0].udt_name, 'geometry');
    const geom = await client.query(`SELECT GeometryType(geom) AS type, ST_SRID(geom) AS srid, ST_AsText(geom) AS text FROM ${table} ORDER BY id LIMIT 1`);
    assert.equal(geom.rows[0].type, 'POINT');
    assert.equal(geom.rows[0].srid, 4326);
    assert.equal(geom.rows[0].text.includes('|'), false);

    const exported = await exportDatabaseTable({
      db: 'postgresql',
      connection,
      table,
      outputPath: output,
    });
    assert.equal(exported.featureCount, 2);
    assert.equal(parseGeoJSON(fs.readFileSync(output)).features.length, 2);
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await client.end();
  }
});
