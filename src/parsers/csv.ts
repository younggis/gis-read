/**
 * CSV with WKT geometry column.
 *
 * A common tabular GIS interchange format: a CSV file where one column
 * holds a Well-Known Text representation of the geometry (WKT). We
 * parse the WKT and produce a GeoJSON FeatureCollection.
 *
 * Common geometry column names: `wkt`, `WKT`, `geometry`, `geom`, `the_geom`.
 * The lat/lon columns (`lat`, `lon` / `lng`, `y`, `x`) are recognized as
 * a fallback when no WKT column is present.
 *
 * WKT grammar supported:
 *   POINT (x y)
 *   LINESTRING (x1 y1, x2 y2, ...)
 *   POLYGON ((x1 y1, x2 y2, ...), (x1 y1, ...), ...)
 *   MULTIPOINT ((x y), (x y), ...)   or  (x y, x y, ...)
 *   MULTILINESTRING ((x1 y1, x2 y2), ...)
 *   MULTIPOLYGON (((x1 y1, ...)), ((x2 y2, ...)))
 *   GEOMETRYCOLLECTION (POINT(...), LINESTRING(...), ...)
 */
import * as fs from 'node:fs';
import type { Feature, Geometry, ParseResult, Properties } from '../types.js';

const WKT_COLUMNS = ['wkt', 'WKT', 'geometry', 'geom', 'the_geom', 'shape', 'SHAPE'];
const LAT_COLUMNS = ['lat', 'latitude', 'y', 'LAT', 'Latitude', 'Y'];
const LON_COLUMNS = ['lon', 'lng', 'longitude', 'x', 'LON', 'LNG', 'Longitude', 'X'];

export function parseCSV(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const rows = parseCSVText(text);
  if (rows.length < 1) return { name: undefined, features: [], meta: { source: 'csv' } };
  const headers = rows[0].map((h) => h.trim());
  const wktCol = headers.findIndex((h) => WKT_COLUMNS.includes(h));
  const latCol = headers.findIndex((h) => LAT_COLUMNS.includes(h));
  const lonCol = headers.findIndex((h) => LON_COLUMNS.includes(h));

  const features: Feature[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => c === '')) continue;
    const properties: Properties = {};
    for (let c = 0; c < headers.length; c++) {
      const val = (row[c] ?? '').trim();
      if (val === '' || val === 'NULL' || val === 'null') continue;
      // Coerce numbers / booleans.
      properties[headers[c]] = coerceValue(val);
    }

    let geometry: Geometry | null = null;
    if (wktCol >= 0) {
      const wkt = (row[wktCol] ?? '').trim();
      if (wkt) geometry = parseWKT(wkt);
    } else if (latCol >= 0 && lonCol >= 0) {
      const lat = Number(row[latCol]);
      const lng = Number(row[lonCol]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) geometry = { type: 'Point', coordinates: [lng, lat] };
    }

    features.push({ type: 'Feature', geometry, properties });
  }
  return { name: undefined, features, meta: { source: 'csv', columnCount: headers.length, wktColumn: wktCol >= 0 ? headers[wktCol] : null } };
}

function coerceValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    return n;
  }
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

export function parseWKT(wkt: string): Geometry | null {
  const m = wkt.match(/^\s*([A-Z]+)\s*(.*)$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  // The body may be wrapped in parens; strip them once.
  const body = stripParens(m[2].trim());
  try {
    switch (type) {
      case 'POINT':
        return { type: 'Point', coordinates: parsePointTuple(body) };
      case 'LINESTRING':
        return { type: 'LineString', coordinates: parsePointList(body) };
      case 'POLYGON':
        return { type: 'Polygon', coordinates: parsePolygonRings(body) };
      case 'MULTIPOINT':
        return { type: 'MultiPoint', coordinates: parseMultiPointBody(body) };
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: parseMulti(body, 1) };
      case 'MULTIPOLYGON':
        return { type: 'MultiPolygon', coordinates: parseMultiPolygon(body) };
      case 'GEOMETRYCOLLECTION':
        return { type: 'GeometryCollection', geometries: parseCollection(body) } as any;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function stripParens(s: string): string {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(start, i);
    }
  }
  return s;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(last, i).trim());
      last = i + 1;
    }
  }
  out.push(s.slice(last).trim());
  return out.filter((x) => x.length > 0);
}

function parsePointTuple(s: string): number[] {
  const nums = s.trim().split(/[\s,]+/).map(Number);
  return nums;
}

function parsePointList(s: string): number[][] {
  return splitTopLevel(s, ',').map((p) => parsePointTuple(stripParens(p)));
}

function parsePolygonRings(s: string): number[][][] {
  // A polygon has form: ((x y, x y), (x y, x y))
  // splitTopLevel on ',' at depth 0 already respects the outer ring's parens
  // (it walks up to depth 1 and treats anything at depth 0 as a top-level
  // separator). Each returned piece is "(x y, x y, ...)" — strip its
  // surrounding parens, then split the points.
  return splitTopLevel(s, ',').map((ring) => parsePointList(stripParens(ring)));
}

function parseMultiPointBody(s: string): number[][] {
  // WKT MULTIPOINT can be written as (1 2, 3 4) or ((1 2), (3 4)). We
  // handle both: if the first character is '(' treat as paren-wrapped, else
  // as a flat comma-separated list.
  if (s.startsWith('(')) {
    return splitTopLevel(s, ',').map((p) => parsePointTuple(stripParens(p)));
  }
  return parsePointList(s);
}

function parseMulti(s: string, ringDepth: number): number[][][] {
  return splitTopLevel(s, ',').map((p) => parsePointList(stripParens(p)));
}

function parseMultiPolygon(s: string): number[][][][] {
  return splitTopLevel(s, ',').map((p) => parsePolygonRings(stripParens(p)));
}

function parseCollection(s: string): Geometry[] {
  // Walk the body, finding each "TYPE (...)" sub-geometry at depth 0.
  const out: Geometry[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const tStart = i;
    while (i < s.length && /[A-Z]/i.test(s[i])) i++;
    const type = s.slice(tStart, i);
    while (i < s.length && s[i] !== '(') i++;
    if (i >= s.length) break;
    let depth = 0;
    const pStart = i;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const body = s.slice(pStart, i);
    const sub = parseWKT(`${type} ${body}`);
    if (sub) out.push(sub);
    while (i < s.length && s[i] === ',') i++;
  }
  return out;
}

// --- CSV text parser ----------------------------------------------------

function parseCSVText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.length > 0 && !(row.length === 1 && row[0] === '')) rows.push(row);
        row = [];
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return rows;
}

export function convertCSV(inputPath: string, outputPath?: string): ParseResult {
  const result = parseCSV(fs.readFileSync(inputPath));
  if (outputPath) {
    const text = JSON.stringify({ type: 'FeatureCollection', features: result.features }, null, 2);
    fs.writeFileSync(outputPath, text, 'utf8');
  }
  return result;
}
