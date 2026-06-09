/**
 * GeoPackage (.gpkg) parser and writer.
 *
 * GeoPackage is an OGC standard based on SQLite for geospatial data.
 * It supports multiple feature layers (tables) in a single file.
 *
 * Reference: https://www.geopackage.org/spec/
 *
 * Also supports reading SpatiaLite .sqlite files as a fallback.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, Geometry, CRS, BBox, ParseResult, ParseOptions, WriteOptions, Properties } from '../types.js';
import { decodeWKB, encodeWKB } from '../database/wkb.js';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// sql.js initialization (top-level await — module is async on first import)
// ---------------------------------------------------------------------------
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();

// ---------------------------------------------------------------------------
// GeoPackage Binary Header
// ---------------------------------------------------------------------------

/** GeoPackage geometry magic bytes: "GP" */
const GPKG_MAGIC_0 = 0x47; // 'G'
const GPKG_MAGIC_1 = 0x50; // 'P'

/** Envelope sizes in bytes based on flags bits 1-3 (GeoPackage spec Annex F.3.1). */
const ENVELOPE_SIZES = [0, 32, 48, 48, 64]; // none, XY, XYZ, XYM, XYZM

interface GpkgHeader {
  srid: number;
  envelopeType: number;
  headerSize: number;
  byteOrder: number; // 0 = little-endian, 1 = big-endian
}

/**
 * Parse the GeoPackage binary header from a geometry blob.
 * Returns header info and the offset where WKB data starts.
 */
function parseGpkgHeader(buf: Buffer): GpkgHeader | null {
  if (buf.length < 8) return null;
  // Check magic bytes
  if (buf[0] !== GPKG_MAGIC_0 || buf[1] !== GPKG_MAGIC_1) return null;

  const flags = buf[3];
  const byteOrder = flags & 0x01; // bit 0
  const envelopeType = (flags >> 1) & 0x07; // bits 1-3
  const envelopeSize = ENVELOPE_SIZES[envelopeType] ?? 0;

  const headerSize = 8 + envelopeSize; // 2 magic + 1 version + 1 flags + 4 srid + envelope
  // Validate buffer is long enough for the full header + at least 1 byte of WKB
  if (buf.length < headerSize + 1) return null;

  const srid = byteOrder === 0
    ? buf.readInt32LE(4)
    : buf.readInt32BE(4);

  return { srid, envelopeType, headerSize, byteOrder };
}

/**
 * Build a minimal GeoPackage binary header (8 bytes, no envelope, little-endian).
 */
function buildGpkgHeader(srid: number): Buffer {
  const buf = Buffer.alloc(8);
  buf[0] = GPKG_MAGIC_0;
  buf[1] = GPKG_MAGIC_1;
  buf[2] = 0; // version
  buf[3] = 0x00; // flags: little-endian (bit 0=0), no envelope (bits 1-3=000), reserved=0
  buf.writeInt32LE(srid, 4);
  return buf;
}

// ---------------------------------------------------------------------------
// CRS Helpers
// ---------------------------------------------------------------------------

/** Try to build a CRS object from an SRID. */
function crsFromSrid(srid: number): CRS | undefined {
  if (srid === 4326) return { type: 'name', properties: { name: 'WGS84' } };
  if (srid === 3857) return { type: 'name', properties: { name: 'WebMercator' } };
  if (srid === 4490) return { type: 'name', properties: { name: 'CGCS2000' } };
  if (srid > 0) return { type: 'name', properties: { name: `EPSG:${srid}` } };
  return undefined;
}

/** Extract SRID from CRS name. */
function sridFromCrs(crs?: CRS): number {
  if (!crs) return 4326;
  const name = crs.properties?.name ?? '';
  if (name === 'WGS84') return 4326;
  if (name === 'WebMercator') return 3857;
  if (name === 'CGCS2000') return 4490;
  const m = name.match(/EPSG:(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return 4326;
}

// ---------------------------------------------------------------------------
// GeoPackage Reader
// ---------------------------------------------------------------------------

/** Metadata about a feature table in the GeoPackage. */
interface LayerInfo {
  tableName: string;
  geometryColumn: string;
  geometryType: string;
  srid: number;
  bbox?: BBox;
}

/** Check if a table exists in the database. */
function tableExists(db: InstanceType<typeof SQL.Database>, name: string): boolean {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [name]
  );
  return result.length > 0 && result[0].values.length > 0;
}

/** Get feature layer metadata from GeoPackage or SpatiaLite tables. */
function getLayerInfos(db: InstanceType<typeof SQL.Database>): LayerInfo[] {
  const layers: LayerInfo[] = [];

  if (tableExists(db, 'gpkg_contents')) {
    // GeoPackage mode
    const contents = db.exec(
      "SELECT table_name, data_type, srs_id, min_x, min_y, max_x, max_y FROM gpkg_contents WHERE data_type='features'"
    );
    if (contents.length === 0) return layers;

    const geomCols = tableExists(db, 'gpkg_geometry_columns')
      ? db.exec('SELECT table_name, column_name, geometry_type_name, srs_id FROM gpkg_geometry_columns')
      : null;

    for (const row of contents[0].values) {
      const tableName = row[0] as string;
      const srid = Number(row[2]) || 4326;
      const bbox: BBox | undefined = (row[3] != null && row[4] != null && row[5] != null && row[6] != null)
        ? [Number(row[3]), Number(row[4]), Number(row[5]), Number(row[6])]
        : undefined;

      let geometryColumn = 'geom';
      let geometryType = 'GEOMETRY';
      if (geomCols && geomCols.length > 0) {
        const match = geomCols[0].values.find((r: any[]) => r[0] === tableName);
        if (match) {
          geometryColumn = match[1] as string;
          geometryType = (match[2] as string) || 'GEOMETRY';
        }
      }

      layers.push({ tableName, geometryColumn, geometryType, srid, bbox });
    }
  } else if (tableExists(db, 'geometry_columns')) {
    // SpatiaLite fallback
    const geomCols = db.exec(
      'SELECT f_table_name, f_geometry_column, geometry_type, srid FROM geometry_columns'
    );
    if (geomCols.length > 0) {
      for (const row of geomCols[0].values) {
        layers.push({
          tableName: row[0] as string,
          geometryColumn: row[1] as string,
          geometryType: (row[2] as string) || 'GEOMETRY',
          srid: Number(row[3]) || 4326,
        });
      }
    }
  }

  return layers;
}

/** Get CRS info for a given SRID. */
function getCrsInfo(db: InstanceType<typeof SQL.Database>, srid: number): CRS | undefined {
  // Try GeoPackage table first
  if (tableExists(db, 'gpkg_spatial_ref_sys')) {
    const result = db.exec(
      'SELECT srs_name, definition FROM gpkg_spatial_ref_sys WHERE srs_id=?',
      [srid]
    );
    if (result.length > 0 && result[0].values.length > 0) {
      const name = result[0].values[0][0] as string;
      return { type: 'name', properties: { name: name || `EPSG:${srid}` } };
    }
  }
  // Try SpatiaLite table
  if (tableExists(db, 'spatial_ref_sys')) {
    const result = db.exec(
      'SELECT ref_sys_name, proj4text FROM spatial_ref_sys WHERE srid=?',
      [srid]
    );
    if (result.length > 0 && result[0].values.length > 0) {
      const name = result[0].values[0][0] as string;
      return { type: 'name', properties: { name: name || `EPSG:${srid}` } };
    }
  }
  return crsFromSrid(srid);
}

/** Parse a geometry blob, handling GeoPackage header or raw WKB. */
function parseGeometryBlob(blob: Uint8Array | null): Geometry | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.from(blob);

  const header = parseGpkgHeader(buf);
  if (header) {
    // GeoPackage format: strip header, decode remaining WKB
    const wkbData = buf.subarray(header.headerSize);
    try {
      return decodeWKB(wkbData);
    } catch {
      return null;
    }
  }

  // Fallback: try as raw WKB (SpatiaLite or plain WKB)
  try {
    return decodeWKB(buf);
  } catch {
    return null;
  }
}

/** Read all features from a single table. */
function readFeatures(
  db: InstanceType<typeof SQL.Database>,
  layer: LayerInfo,
  opts: ParseOptions,
): Feature[] {
  const features: Feature[] = [];
  const limit = opts.limit ?? 0;

  // Get column names
  const tableInfo = db.exec(`PRAGMA table_info("${layer.tableName}")`);
  const columns: string[] = [];
  if (tableInfo.length > 0) {
    for (const row of tableInfo[0].values) {
      const colName = row[1] as string;
      if (colName !== layer.geometryColumn) {
        columns.push(colName);
      }
    }
  }

  const selectCols = `"${layer.geometryColumn}", ${columns.map(c => `"${c}"`).join(', ')}`;
  const sql = `SELECT ${selectCols} FROM "${layer.tableName}"`;

  const result = db.exec(sql);
  if (result.length === 0) return features;

  const rows = result[0].values;
  const bbox = opts.bbox;

  for (const row of rows) {
    if (limit > 0 && features.length >= limit) break;

    const geomBlob = row[0] as Uint8Array | null;
    const geometry = parseGeometryBlob(geomBlob);

    // Apply bbox filter
    if (bbox && geometry) {
      const geomBbox = computeGeometryBBox(geometry);
      if (geomBbox && !bboxIntersects(bbox, geomBbox)) continue;
    }

    const properties: Properties = {};
    for (let i = 0; i < columns.length; i++) {
      const val = row[i + 1];
      if (val !== null && val !== undefined) {
        properties[columns[i]] = val;
      }
    }

    const feature: Feature = {
      type: 'Feature',
      geometry,
      properties,
    };

    // Use a row id if available
    if (properties['id'] !== undefined) {
      feature.id = properties['id'] as string | number;
    } else if (properties['fid'] !== undefined) {
      feature.id = properties['fid'] as string | number;
    }

    features.push(feature);
  }

  return features;
}

/** Compute a simple bounding box for a geometry. */
function computeGeometryBBox(geom: Geometry): BBox | null {
  const coords = getAllCoordinates(geom);
  if (coords.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of coords) {
    if (c[0] < minX) minX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] > maxY) maxY = c[1];
  }
  return [minX, minY, maxX, maxY];
}

function getAllCoordinates(geom: Geometry): number[][] {
  if (!geom) return [];
  switch (geom.type) {
    case 'Point': return [geom.coordinates as number[]];
    case 'MultiPoint':
    case 'LineString': return (geom.coordinates as number[][]);
    case 'MultiLineString':
    case 'Polygon': return (geom.coordinates as number[][][]).flat();
    case 'MultiPolygon': return (geom.coordinates as number[][][][]).flat(2);
    default: return [];
  }
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a GeoPackage file and return features from all layers.
 *
 * Each layer's features are tagged with a `_layer` property containing the
 * table name. Layer names are stored in `meta.layers`.
 *
 * If `opts.layer` is specified, only that layer is parsed.
 */
export function parseGeoPackage(filePath: string, opts: ParseOptions = {}): ParseResult {
  const fileBuffer = fs.readFileSync(filePath);
  const db = new SQL.Database(fileBuffer);

  try {
    const layers = getLayerInfos(db);
    if (layers.length === 0) {
      throw new Error(`No feature layers found in: ${filePath}`);
    }

    const layerNames = layers.map(l => l.tableName);
    const targetLayer = opts.layer;
    const features: Feature[] = [];
    let crs: CRS | undefined;
    let bbox: BBox | undefined;

    for (const layer of layers) {
      // If --layer specified, skip other layers
      if (targetLayer && layer.tableName !== targetLayer) continue;

      const layerFeatures = readFeatures(db, layer, opts);

      // Tag features with layer name (like TopoJSON pattern)
      for (const f of layerFeatures) {
        f.properties._layer = layer.tableName;
        features.push(f);
      }

      // Use CRS from first processed layer
      if (!crs) {
        crs = getCrsInfo(db, layer.srid);
      }

      // Merge bbox
      if (layer.bbox) {
        if (!bbox) {
          bbox = [...layer.bbox];
        } else {
          bbox = [
            Math.min(bbox[0], layer.bbox[0]),
            Math.min(bbox[1], layer.bbox[1]),
            Math.max(bbox[2], layer.bbox[2]),
            Math.max(bbox[3], layer.bbox[3]),
          ];
        }
      }
    }

    // Compute bbox from features if not available from metadata
    if (!bbox && features.length > 0) {
      for (const f of features) {
        if (!f.geometry) continue;
        const fb = computeGeometryBBox(f.geometry);
        if (!fb) continue;
        if (!bbox) {
          bbox = [...fb];
        } else {
          bbox = [
            Math.min(bbox[0], fb[0]),
            Math.min(bbox[1], fb[1]),
            Math.max(bbox[2], fb[2]),
            Math.max(bbox[3], fb[3]),
          ];
        }
      }
    }

    const name = targetLayer
      ?? path.basename(filePath, path.extname(filePath));

    return {
      name,
      features,
      crs,
      bbox,
      meta: {
        source: 'geopackage',
        layers: layerNames,
        table_name: targetLayer ?? layerNames.join(', '),
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Parse a GeoPackage file and return a separate ParseResult for each layer.
 * Useful for multi-layer export.
 */
export function parseGeoPackageLayers(filePath: string, opts: ParseOptions = {}): ParseResult[] {
  const fileBuffer = fs.readFileSync(filePath);
  const db = new SQL.Database(fileBuffer);

  try {
    const layers = getLayerInfos(db);
    if (layers.length === 0) {
      throw new Error(`No feature layers found in: ${filePath}`);
    }

    const results: ParseResult[] = [];
    const allLayerNames = layers.map(l => l.tableName);

    for (const layer of layers) {
      const features = readFeatures(db, layer, opts);
      const crs = getCrsInfo(db, layer.srid);

      let bbox = layer.bbox;
      if (!bbox && features.length > 0) {
        for (const f of features) {
          if (!f.geometry) continue;
          const fb = computeGeometryBBox(f.geometry);
          if (!fb) continue;
          if (!bbox) {
            bbox = [...fb];
          } else {
            bbox = [
              Math.min(bbox[0], fb[0]),
              Math.min(bbox[1], fb[1]),
              Math.max(bbox[2], fb[2]),
              Math.max(bbox[3], fb[3]),
            ];
          }
        }
      }

      results.push({
        name: layer.tableName,
        features,
        crs,
        bbox,
        meta: {
          source: 'geopackage',
          layers: allLayerNames,
          table_name: layer.tableName,
        },
      });
    }

    return results;
  } finally {
    db.close();
  }
}

/**
 * List all feature layers in a GeoPackage file.
 */
export function listGeoPackageLayers(filePath: string): string[] {
  const fileBuffer = fs.readFileSync(filePath);
  const db = new SQL.Database(fileBuffer);

  try {
    return getLayerInfos(db).map(l => l.tableName);
  } finally {
    db.close();
  }
}

/**
 * Write a ParseResult to a GeoPackage file.
 */
export function writeGeoPackage(result: ParseResult, opts: WriteOptions = {}): void {
  if (!opts.outputPath) throw new Error('writeGeoPackage requires outputPath.');

  const outputPath = path.resolve(opts.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tableName = opts.name ?? result.name ?? 'features';
  const srid = sridFromCrs(result.crs);

  const db = new SQL.Database();

  try {
    // Set GeoPackage application_id and user_version
    db.run('PRAGMA application_id = 1196437808'); // 0x47503130 = "GP10"
    db.run('PRAGMA user_version = 10200'); // GeoPackage 1.2

    // Create gpkg_spatial_ref_sys
    db.run(`CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL,
      description TEXT
    )`);
    db.run(
      `INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['WGS 84', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",...]', '']
    );
    // Also insert the target CRS if different from 4326
    if (srid !== 4326) {
      const crsName = result.crs?.properties?.name ?? `EPSG:${srid}`;
      db.run(
        `INSERT OR IGNORE INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crsName, srid, 'EPSG', srid, '', '']
      );
    }

    // Create gpkg_contents
    db.run(`CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      identifier TEXT,
      description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE,
      min_y DOUBLE,
      max_x DOUBLE,
      max_y DOUBLE,
      srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    )`);

    // Create gpkg_geometry_columns
    db.run(`CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL DEFAULT 0,
      m TINYINT NOT NULL DEFAULT 0,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    )`);

    // Infer attribute columns from features
    const columns = inferColumns(result.features);

    // Create feature table
    const colDefs = columns.map(c => `"${c.name}" ${c.sqlType}`).join(', ');
    db.run(`CREATE TABLE "${tableName}" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT,
      geom BLOB${colDefs ? ', ' + colDefs : ''}
    )`);

    // Insert features
    const geomHeader = buildGpkgHeader(srid);
    const colNames = columns.map(c => `"${c.name}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO "${tableName}" (geom${colNames ? ', ' + colNames : ''}) VALUES (?${placeholders ? ', ' + placeholders : ''})`;
    const stmt = db.prepare(insertSql);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const feature of result.features) {
      let geomBlob: Uint8Array | null = null;
      if (feature.geometry) {
        const wkb = encodeWKB(feature.geometry);
        const blob = Buffer.concat([geomHeader, wkb]);
        geomBlob = new Uint8Array(blob);

        // Update bbox
        const fb = computeGeometryBBox(feature.geometry);
        if (fb) {
          if (fb[0] < minX) minX = fb[0];
          if (fb[1] < minY) minY = fb[1];
          if (fb[2] > maxX) maxX = fb[2];
          if (fb[3] > maxY) maxY = fb[3];
        }
      }

      const values: unknown[] = [geomBlob];
      for (const col of columns) {
        const val = feature.properties[col.name];
        values.push(val === undefined ? null : val);
      }
      stmt.run(values);
    }
    stmt.free();

    // Compute final bbox
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

    // Populate gpkg_contents
    const identifier = tableName;
    const description = `Imported from ${result.name ?? 'unknown'}`;
    db.run(
      `INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
       VALUES (?, 'features', ?, ?, ?, ?, ?, ?, ?)`,
      [tableName, identifier, description, minX, minY, maxX, maxY, srid]
    );

    // Populate gpkg_geometry_columns
    db.run(
      `INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m)
       VALUES (?, 'geom', 'GEOMETRY', ?, 0, 0)`,
      [tableName, srid]
    );

    // Write to file
    const data = db.export();
    fs.writeFileSync(outputPath, Buffer.from(data));

    log.debug(`Wrote GeoPackage: ${outputPath} (${result.features.length} features)`);
  } finally {
    db.close();
  }
}

/** Infer SQL column types from feature properties. */
interface ColumnDef {
  name: string;
  sqlType: string;
}

function inferColumns(features: Feature[]): ColumnDef[] {
  const typeMap = new Map<string, string>();

  // Columns reserved by GeoPackage or used as primary key
  const reserved = new Set(['fid', 'id', '_layer', 'rowid']);

  for (const f of features) {
    for (const [key, val] of Object.entries(f.properties)) {
      if (reserved.has(key)) continue; // Skip reserved columns
      if (typeMap.has(key)) continue; // Already determined

      if (val === null || val === undefined) continue;
      if (typeof val === 'number') {
        typeMap.set(key, Number.isInteger(val) ? 'INTEGER' : 'REAL');
      } else if (typeof val === 'boolean') {
        typeMap.set(key, 'INTEGER');
      } else if (typeof val === 'string') {
        typeMap.set(key, 'TEXT');
      } else {
        typeMap.set(key, 'TEXT'); // fallback to TEXT for complex types
      }
    }
  }

  return Array.from(typeMap.entries()).map(([name, sqlType]) => ({ name, sqlType }));
}
