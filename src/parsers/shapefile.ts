/**
 * Shapefile (.shp + .dbf) reader.
 *
 * ESRI Shapefile is a multi-file format. The geometry is in `.shp` and the
 * attribute table is in `.dbf`. This module reads both, plus `.prj` for
 * the coordinate reference system and `.cpg` for the dbf code page.
 *
 * Supported shape types (subset of the full spec, covering the common ones):
 *   0  Null
 *   1  Point       11 PointZ
 *   3  PolyLine    13 PolyLineZ
 *   5  Polygon     15 PolygonZ
 *   8  MultiPoint  18 MultiPointZ
 *  23  PolyLineM   31 MultiPointM
 *  25  PolygonM
 *  28  PointM
 *
 * The format is little-endian, with a 100-byte header followed by records.
 * See ESRI Shapefile Technical Description (July 1998) for the spec.
 *
 * Encoding: character encoding of the .dbf attribute table is resolved
 * automatically (see ../encoding.ts). Precedence is .cpg > heuristic probe
 * of the data > dBASE language-driver byte.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BBox, CRS, Feature, Geometry, ParseResult, Properties } from '../types.js';
import { detectFormat } from '../format-detect.js';
import { readCPG, detectEncoding, decoderFor, driverToEncoding, decodeStringField } from '../encoding.js';

// Shape type codes.
const SHAPE_NULL = 0;
const SHAPE_POINT = 1;
const SHAPE_POLYLINE = 3;
const SHAPE_POLYGON = 5;
const SHAPE_MULTIPOINT = 8;
const SHAPE_POINT_Z = 11;
const SHAPE_POLYLINE_Z = 13;
const SHAPE_POLYGON_Z = 15;
const SHAPE_POINT_M = 28;
const SHAPE_POLYLINE_M = 23;
const SHAPE_POLYGON_M = 25;
const SHAPE_MULTIPOINT_M = 31;
const SHAPE_MULTIPOINT_Z = 18;

interface DbfField {
  name: string;
  type: string; // C, N, F, L, D, M, B
  size: number;
  decimals: number;
  offset: number;
}

/** Read a Shapefile (.shp + companion files) into our ParseResult. */
export function parseShapefile(inputPath: string): ParseResult {
  const base = stripExt(inputPath);
  const shpPath = base + '.shp';
  const dbfPath = base + '.dbf';
  const prjPath = base + '.prj';
  const cpgPath = base + '.cpg';

  if (!fs.existsSync(shpPath)) throw new Error(`Shapefile not found: ${shpPath}`);
  if (detectFormat(shpPath) !== 'shapefile') {
    throw new Error(`Not a shapefile (bad magic): ${shpPath}`);
  }

  const shp = readShpGeometry(shpPath);
  const dbf = fs.existsSync(dbfPath) ? readDbf(dbfPath, cpgPath) : { records: [], fields: [], encoding: 'latin1' };
  const prj = fs.existsSync(prjPath) ? fs.readFileSync(prjPath, 'utf8').trim() : undefined;
  const name = path.basename(base);

  // Pair records by 0-based record number (shp and dbf share the same order).
  const len = Math.min(shp.shapes.length, dbf.records.length);
  const features: Feature[] = [];
  for (let i = 0; i < len; i++) {
    const props: Properties = { ...dbf.records[i] };
    features.push({ type: 'Feature', geometry: shp.shapes[i], properties: props });
  }
  // If dbf is missing, attach a sequential id so callers can still distinguish.
  if (dbf.records.length === 0) {
    for (let i = 0; i < shp.shapes.length; i++) {
      features.push({ type: 'Feature', geometry: shp.shapes[i], properties: { _id: i } });
    }
  }

  const result: ParseResult = {
    name,
    features,
    bbox: shp.bbox,
    meta: {
      source: 'shapefile',
      shapeType: shp.shapeType,
      shapeTypeName: shapeTypeName(shp.shapeType),
      recordCount: features.length,
      encoding: dbf.encoding,
    },
  };
  if (prj) result.crs = wktToCRS(prj);
  return result;
}

function stripExt(p: string): string {
  return p.replace(/\.(shp|dbf|prj|cpg|shx)$/i, '');
}

function shapeTypeName(t: number): string {
  switch (t) {
    case SHAPE_NULL: return 'Null';
    case SHAPE_POINT: return 'Point';
    case SHAPE_POLYLINE: return 'PolyLine';
    case SHAPE_POLYGON: return 'Polygon';
    case SHAPE_MULTIPOINT: return 'MultiPoint';
    case SHAPE_POINT_M: return 'PointM';
    case SHAPE_POLYLINE_M: return 'PolyLineM';
    case SHAPE_POLYGON_M: return 'PolygonM';
    case SHAPE_POINT_Z: return 'PointZ';
    case SHAPE_POLYLINE_Z: return 'PolyLineZ';
    case SHAPE_POLYGON_Z: return 'PolygonZ';
    case SHAPE_MULTIPOINT_M: return 'MultiPointM';
    case SHAPE_MULTIPOINT_Z: return 'MultiPointZ';
    default: return `Unknown(${t})`;
  }
}

// --- SHP reader ---------------------------------------------------------

interface ShpRead {
  shapes: (Geometry | null)[];
  bbox: BBox;
  shapeType: number;
}

function readShpGeometry(shpPath: string): ShpRead {
  const buf = fs.readFileSync(shpPath);
  // Header: 100 bytes. Big fields: file length (24..27, big-endian 16-bit words).
  if (buf.length < 100) throw new Error('Shapefile too small');
  if (buf.readUInt32BE(0) !== 9994) throw new Error('Bad shapefile magic');

  const fileLengthWords = buf.readInt32BE(24);
  const fileLength = fileLengthWords * 2;

  const bbox: BBox = [
    buf.readDoubleLE(36), buf.readDoubleLE(44),
    buf.readDoubleLE(52), buf.readDoubleLE(60),
  ];

  const shapeType = buf.readInt32LE(32);

  const shapes: (Geometry | null)[] = [];
  let offset = 100;
  // Cap the loop to the declared file length; defensive against truncated files.
  const upper = Math.min(fileLength, buf.length);
  while (offset + 8 <= upper) {
    // Record header: big-endian record number (4), big-endian content length in 16-bit words (4).
    const recNum = buf.readInt32BE(offset);
    const contentLenWords = buf.readInt32BE(offset + 4);
    const contentLen = contentLenWords * 2;
    if (contentLen < 4 || offset + 8 + contentLen > upper) break;
    const recBuf = buf.subarray(offset + 8, offset + 8 + contentLen);
    const recType = recBuf.readInt32LE(0);
    shapes.push(parseShpRecord(recType, recBuf));
    offset += 8 + contentLen;
    void recNum;
  }

  return { shapes, bbox, shapeType };
}

function parseShpRecord(type: number, buf: Buffer): Geometry | null {
  if (type === SHAPE_NULL) return null;

  if (type === SHAPE_POINT) {
    return { type: 'Point', coordinates: [buf.readDoubleLE(0), buf.readDoubleLE(8)] };
  }
  if (type === SHAPE_POINT_M) {
    return { type: 'Point', coordinates: [buf.readDoubleLE(0), buf.readDoubleLE(8)] };
  }
  if (type === SHAPE_POINT_Z) {
    return {
      type: 'Point',
      coordinates: [buf.readDoubleLE(0), buf.readDoubleLE(8), buf.readDoubleLE(16)],
    };
  }

  if (type === SHAPE_MULTIPOINT || type === SHAPE_MULTIPOINT_M || type === SHAPE_MULTIPOINT_Z) {
    return parseMultiPoint(buf);
  }
  if (type === SHAPE_POLYLINE || type === SHAPE_POLYLINE_M || type === SHAPE_POLYLINE_Z || type === SHAPE_POLYGON || type === SHAPE_POLYGON_M || type === SHAPE_POLYGON_Z) {
    return parsePolylineOrPolygon(type, buf);
  }
  // MultiPatch (31): not fully supported — return GeometryCollection of rings.
  if (type === 31) {
    return { type: 'GeometryCollection', coordinates: [] };
  }
  return null;
}

function parseMultiPoint(buf: Buffer): Geometry {
  // Layout: 4 (type) + 32 (bbox) + 4 (numPoints) = 40, then 16*numPoints.
  const numPoints = buf.readInt32LE(36);
  const pts: number[][] = [];
  for (let i = 0; i < numPoints; i++) {
    pts.push([buf.readDoubleLE(40 + i * 16), buf.readDoubleLE(40 + i * 16 + 8)]);
  }
  if (numPoints === 1) return { type: 'Point', coordinates: pts[0] };
  return { type: 'MultiPoint', coordinates: pts };
}

function parsePolylineOrPolygon(type: number, buf: Buffer): Geometry {
  // Layout: 4 (type) + 32 (bbox) + 4 (numParts) + 4 (numPoints) = 44
  // followed by numParts * 4 (part index array), then numPoints * 16 (points).
  const isPolygon = type === SHAPE_POLYGON || type === SHAPE_POLYGON_M || type === SHAPE_POLYGON_Z;
  const numParts = buf.readInt32LE(36);
  const numPoints = buf.readInt32LE(40);

  // Part indices start at 44; each is 4 bytes.
  const parts: number[] = [];
  for (let i = 0; i < numParts; i++) parts.push(buf.readInt32LE(44 + i * 4));

  // Points start at 44 + numParts*4; each 16 bytes.
  const pointsStart = 44 + numParts * 4;
  const readPoint = (idx: number): number[] => {
    const off = pointsStart + idx * 16;
    return [buf.readDoubleLE(off), buf.readDoubleLE(off + 8)];
  };

  // Build parts.
  const allParts: number[][][] = [];
  for (let p = 0; p < numParts; p++) {
    const start = parts[p];
    const end = p + 1 < numParts ? parts[p + 1] : numPoints;
    const ring: number[][] = [];
    for (let j = start; j < end; j++) ring.push(readPoint(j));
    allParts.push(ring);
  }

  if (isPolygon) {
    return polygonFromRings(allParts);
  }
  if (numParts === 1) return { type: 'LineString', coordinates: allParts[0] };
  return { type: 'MultiLineString', coordinates: allParts };
}

/** Convert a list of rings into Polygon or MultiPolygon using ring closure + winding. */
function polygonFromRings(rings: number[][][]): Geometry {
  if (rings.length === 0) return { type: 'Polygon', coordinates: [] };

  // Compute signed area to determine winding (clockwise = outer, counter-clockwise = hole,
  // in geographic coords; but we follow GeoJSON spec: outer rings CCW, holes CW).
  const area = signedArea(rings[0]);
  const outerCW = area < 0; // positive area means CCW in standard right-hand coords.

  const outers: number[][][] = [];
  const holes: number[][][] = [];
  for (const r of rings) {
    const a = signedArea(r);
    if (a === 0) continue;
    // Outer rings have opposite winding to holes.
    if ((a < 0) === outerCW) outers.push(r);
    else holes.push(r);
  }

  if (outers.length === 1) {
    return { type: 'Polygon', coordinates: [outers[0], ...holes] };
  }
  // For multi-polygons we don't try to associate holes to specific outers;
  // emit each outer with all holes as a flat list.
  return {
    type: 'MultiPolygon',
    coordinates: outers.map((o) => [o, ...holes]),
  };
}

function signedArea(ring: number[][]): number {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

// --- DBF reader ---------------------------------------------------------

/**
 * Read a dBASE III / IV .dbf file.
 *
 * Encoding is resolved in this order:
 *   1. `.cpg` file (when `cpgPath` is given) — explicit CPG label wins.
 *   2. Heuristic probe of the .dbf buffer (sample of first 4 KB) — distinguishes
 *      UTF-8 / GBK / GB18030 / Big5 / Latin1 reliably for CJK content.
 *   3. The `.dbf`'s own language-driver byte (offset 29) is read but is
 *      very unreliable across GIS tools, so it's only used as a fallback
 *      hint when the probe is inconclusive.
 */
function readDbf(
  dbfPath: string,
  cpgPath?: string,
): { records: Properties[]; fields: DbfField[]; encoding: string } {
  const buf = fs.readFileSync(dbfPath);

  let encoding: string | null = readCPG(cpgPath);
  let source: 'cpg' | 'detected' | 'driver' = 'cpg';
  if (!encoding) {
    // Probe the first 4 KB of the data section (skip the 32-byte header and
    // field descriptors) so we don't get biased by binary header bytes.
    const headerLen = buf.length >= 10 ? buf.readUInt16LE(8) : 32;
    const sampleStart = Math.min(buf.length, headerLen);
    const sampleEnd = Math.min(buf.length, sampleStart + 4096);
    encoding = detectEncoding(buf.subarray(sampleStart, sampleEnd));
    source = 'detected';
  }
  if (!encoding) {
    const driver = buf.length > 29 ? buf[29] : 0;
    encoding = driverToEncoding(driver) ?? 'gb18030';
    source = 'driver';
  }

  const result = readDbfRecords(buf, encoding);
  return { ...result, encoding: `${encoding} (${source})` };
}

function readDbfRecords(buf: Buffer, encoding: string): { records: Properties[]; fields: DbfField[] } {
  if (buf.length < 32) return { records: [], fields: [] };

  // Header.
  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  // Field descriptors: 32 bytes each, starting at byte 32; terminated by 0x0D.
  const fields: DbfField[] = [];
  let off = 32;
  while (off < headerLen - 1) {
    if (buf[off] === 0x0d) break;
    const name = readDbfFieldName(buf, off);
    const type = String.fromCharCode(buf[off + 11]);
    const size = buf[off + 16];
    const decimals = buf[off + 17];
    fields.push({ name, type, size, decimals, offset: 0 });
    off += 32;
  }
  // Compute per-field offset within a record.
  let cursor = 1; // first byte is the deletion flag.
  for (const f of fields) {
    f.offset = cursor;
    cursor += f.size;
  }

  const dec = decoderFor(encoding);
  const records: Properties[] = [];
  let pos = headerLen;
  for (let r = 0; r < numRecords; r++) {
    if (pos + recordLen > buf.length) break;
    const deleted = buf[pos] === 0x2a; // '*'
    const rec: Properties = {};
    if (!deleted) {
      for (const f of fields) {
        const raw = buf.slice(pos + f.offset, pos + f.offset + f.size);
        rec[f.name] = decodeDbfField(raw, f, dec);
      }
    }
    records.push(rec);
    pos += recordLen;
  }
  return { records, fields };
}

function readDbfFieldName(buf: Buffer, off: number): string {
  // Field names are always ASCII (8-bit code page labels), but to be safe
  // decode via latin1 and trim at the first NUL.
  let s = '';
  for (let i = 0; i < 11; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function decodeDbfField(raw: Buffer, f: DbfField, dec: (b: Buffer) => string): unknown {
  const t = f.type.toUpperCase();
  if (t === 'N' || t === 'F') {
    const s = raw.toString('ascii').trim();
    if (s === '') return null;
    return Number(s);
  }
  if (t === 'L') {
    const s = raw.toString('ascii').trim().toUpperCase();
    return s === 'T' || s === 'Y' || s === '1';
  }
  if (t === 'D') {
    const s = raw.toString('ascii').trim();
    if (s.length !== 8) return s;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  // Character / memo / binary — use the configured decoder.
  return decodeStringField(raw, dec);
}

// --- .prj handling ------------------------------------------------------

/** Convert a WKT string to a GeoJSON CRS object (best-effort, name-based). */
function wktToCRS(wkt: string): CRS {
  // Find the first token (the CRS type) and any authority/code hints.
  const type = (wkt.match(/^\s*(\w+)/) ?? [])[1] ?? 'CRS';
  const auth = wkt.match(/AUTHORITY\["([^"]+)",\s*"([^"]+)"\]/);
  if (auth) {
    return { type: 'name', properties: { name: `urn:ogc:def:crs:${auth[1]}::${auth[2]}` } };
  }
  return { type: 'name', properties: { name: wkt.length > 0 ? type : '' } };
}
