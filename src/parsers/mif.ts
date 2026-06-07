/**
 * MapInfo MIF/MID reader.
 *
 * MIF (MapInfo Interchange Format) is a text format that accompanies a
 * .mid file (DBASE with attributes). It's older than TAB but easier
 * to read.
 *
 * Format sketch:
 *   Version 300
 *   Charset "WindowsLatin1"
 *   Delimiter ","
 *   Columns 4
 *     ID Integer
 *     Name Char(50)
 *     ...
 *   Data
 *   Point -73.5 40.5
 *     ID 1
 *     Name "foo"
 *   Line 3
 *     -73.5 40.5
 *     -73.4 40.4
 *     -73.3 40.3
 *     ID 2
 *     Name "bar"
 *   ...
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, Geometry, ParseResult, Properties, WriteOptions } from '../types.js';

interface MifColumn {
  name: string;
  type: string;
  width?: number;
  sourceName?: string;
}

export function parseMIF(inputPath: string): ParseResult {
  const base = stripExt(inputPath);
  const mifPath = base + '.mif';
  const midPath = base + '.mid';
  if (!fs.existsSync(mifPath)) throw new Error(`MIF not found: ${mifPath}`);

  const text = fs.readFileSync(mifPath, 'utf8');
  const { columns, sections } = parseMIFSections(text);

  const records: Properties[] = [];
  if (fs.existsSync(midPath)) {
    // Each line in .mid is a record with values in the order of Columns.
    const midText = fs.readFileSync(midPath, 'utf8');
    const delim = '\n';
    for (const line of midText.split(delim)) {
      if (!line.trim()) continue;
      // Simple split on tab; MIF allows custom delimiter, but most use tab.
      const parts = splitMidRow(line, columns.length);
      const rec: Properties = {};
      for (let i = 0; i < columns.length; i++) {
        rec[columns[i].name] = parseMIDValue(parts[i] ?? '', columns[i].type);
      }
      records.push(rec);
    }
  }

  const features: Feature[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const props = records[i] ?? {};
    features.push({ type: 'Feature', geometry: sec.geometry, properties: props });
  }
  return { name: path.basename(base), features, meta: { source: 'mif' } };
}

interface MifSection {
  geometry: Geometry | null;
  raw: string[];
}

function parseMIFSections(text: string): { columns: MifColumn[]; sections: MifSection[] } {
  const lines = text.split(/\r?\n/);
  const columns: MifColumn[] = [];
  const sections: MifSection[] = [];
  let i = 0;
  let inData = false;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!inData) {
      if (/^Columns\s+\d+/i.test(line)) {
        // Already on Columns line; read N entries.
        const n = Number(line.split(/\s+/)[1]);
        i++;
        for (let k = 0; k < n && i < lines.length; k++) {
          const m = lines[i].match(/^\s*(\S+)\s+(\w+)(?:\s*\((\d+)\))?/);
          if (m) columns.push({ name: m[1], type: m[2], width: m[3] ? Number(m[3]) : undefined });
          i++;
        }
        continue;
      }
      if (/^Data\s*$/i.test(line)) {
        inData = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // Data section: read geometry block until blank line.
    if (line === '') {
      i++;
      continue;
    }
    const geomTokens = line.split(/\s+/);
    const geomType = geomTokens[0];
    let cur: MifSection = { geometry: null, raw: [] };
    switch (geomType?.toLowerCase()) {
      case 'point': {
        const x = Number(geomTokens[1]);
        const y = Number(geomTokens[2]);
        cur.geometry = { type: 'Point', coordinates: [x, y] };
        i++;
        break;
      }
      case 'line':
      case 'polyline': {
        const numPts = Number(geomTokens[1]);
        const pts: number[][] = [];
        i++;
        for (let k = 0; k < numPts && i < lines.length; k++, i++) {
          const [x, y] = lines[i].trim().split(/\s+/).map(Number);
          pts.push([x, y]);
        }
        cur.geometry = { type: 'LineString', coordinates: pts };
        break;
      }
      case 'pline': {
        if (geomTokens[1]?.toLowerCase() === 'multiple') {
          const numLines = Number(geomTokens[2]);
          const linesOut: number[][][] = [];
          i++;
          for (let lineIdx = 0; lineIdx < numLines && i < lines.length; lineIdx++) {
            const numPts = Number(lines[i].trim());
            i++;
            const pts: number[][] = [];
            for (let k = 0; k < numPts && i < lines.length; k++, i++) {
              const [x, y] = lines[i].trim().split(/\s+/).map(Number);
              pts.push([x, y]);
            }
            linesOut.push(pts);
          }
          cur.geometry = { type: 'MultiLineString', coordinates: linesOut };
          break;
        }
        const numPts = Number(geomTokens[1]);
        const pts: number[][] = [];
        i++;
        for (let k = 0; k < numPts && i < lines.length; k++, i++) {
          const [x, y] = lines[i].trim().split(/\s+/).map(Number);
          pts.push([x, y]);
        }
        cur.geometry = { type: 'LineString', coordinates: pts };
        break;
      }
      case 'multipoint': {
        const numPts = Number(geomTokens[1]);
        const pts: number[][] = [];
        i++;
        for (let k = 0; k < numPts && i < lines.length; k++, i++) {
          const [x, y] = lines[i].trim().split(/\s+/).map(Number);
          pts.push([x, y]);
        }
        cur.geometry = { type: 'MultiPoint', coordinates: pts };
        break;
      }
      case 'region':
      case 'polygon': {
        const numPolys = Number(geomTokens[1]);
        const polys: number[][][][] = [];
        i++;
        for (let p = 0; p < numPolys && i < lines.length; p++) {
          const numPts = Number(lines[i].trim());
          i++;
          const ring: number[][] = [];
          for (let k = 0; k < numPts && i < lines.length; k++, i++) {
            const [x, y] = lines[i].trim().split(/\s+/).map(Number);
            ring.push([x, y]);
          }
          polys.push([ring]);
        }
        cur.geometry = polys.length === 1
          ? { type: 'Polygon', coordinates: polys[0] }
          : { type: 'MultiPolygon', coordinates: polys };
        break;
      }
      case 'arc':
      case 'text':
      case 'none':
        // Not supported as geometry; skip the line and continue.
        i++;
        sections.push(cur);
        continue;
      default:
        i++;
        sections.push(cur);
        continue;
    }
    // After geometry, attribute block follows until blank line.
    while (i < lines.length && lines[i].trim() !== '') {
      cur.raw.push(lines[i]);
      i++;
    }
    sections.push(cur);
    if (i < lines.length && lines[i].trim() === '') i++;
  }
  return { columns, sections };
}

function splitMidRow(line: string, expected: number): string[] {
  // .mid rows are typically tab-delimited; quoted strings can contain
  // commas. Use a simple split — robust enough for round-tripping.
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === '\t' && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseMIDValue(s: string, type: string): unknown {
  const t = type.toLowerCase();
  if (t === 'integer' || t === 'smallint') return Number(s);
  if (t === 'float' || t === 'decimal' || t === 'numeric') return Number(s);
  if (t === 'logical') {
    return s.trim().toUpperCase() === 'T';
  }
  if (t === 'date') return s;
  return s.replace(/^"|"$/g, '');
}

function stripExt(p: string): string {
  return p.replace(/\.(mif|mid)$/i, '');
}

export function convertMIF(inputPath: string, outputPath?: string): ParseResult {
  const result = parseMIF(inputPath);
  if (outputPath) {
    const text = JSON.stringify({ type: 'FeatureCollection', name: result.name, features: result.features }, null, 2);
    fs.writeFileSync(outputPath, text, 'utf8');
  }
  return result;
}

export function writeMIF(result: ParseResult, opts: WriteOptions = {}): string {
  const precision = opts.precision ?? 6;
  const columns = inferMifColumns(result.features);
  const delimiter = '\t';
  const mifLines = [
    'Version 300',
    'Charset "UTF-8"',
    'Delimiter "\\t"',
    `Columns ${columns.length}`,
    ...columns.map((c) => `  ${c.name} ${c.type}${c.width ? `(${c.width})` : ''}`),
    'Data',
  ];
  const midLines: string[] = [];

  for (const feature of result.features) {
    mifLines.push(...formatMifGeometry(feature.geometry, precision), '');
    midLines.push(columns.map((c) => formatMidValue(feature.properties?.[c.sourceName ?? c.name], c)).join(delimiter));
  }

  const mifText = mifLines.join('\n') + '\n';
  const midText = midLines.join('\n') + '\n';
  if (opts.outputPath) {
    const base = stripExt(opts.outputPath);
    fs.mkdirSync(path.dirname(path.resolve(base)), { recursive: true });
    fs.writeFileSync(base + '.mif', mifText, 'utf8');
    fs.writeFileSync(base + '.mid', midText, 'utf8');
  }
  return mifText;
}

function inferMifColumns(features: Feature[]): MifColumn[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) {
      const safe = sanitizeMifName(key);
      if (!seen.has(safe)) {
        seen.add(safe);
        keys.push(key);
      }
    }
  }

  return keys.map((sourceName) => {
    const name = sanitizeMifName(sourceName);
    const sourceValues = features.map((f) => f.properties?.[sourceName]).filter((v) => v !== null && v !== undefined);
    if (sourceValues.length > 0 && sourceValues.every((v) => typeof v === 'boolean')) return { sourceName, name, type: 'Logical' };
    if (sourceValues.length > 0 && sourceValues.every((v) => typeof v === 'number' && Number.isInteger(v))) return { sourceName, name, type: 'Integer' };
    if (sourceValues.length > 0 && sourceValues.every((v) => typeof v === 'number')) return { sourceName, name, type: 'Float' };
    const width = Math.min(254, Math.max(16, ...sourceValues.map((v) => formatPropertyValue(v).length)));
    return { sourceName, name, type: 'Char', width };
  });
}

function sanitizeMifName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(safe) ? safe : `F_${safe}`;
}

function formatMifGeometry(geometry: Geometry | null, precision: number): string[] {
  if (!geometry) return ['None'];
  switch (geometry.type) {
    case 'Point': {
      const c = geometry.coordinates as number[];
      return [`Point ${fmt(c[0], precision)} ${fmt(c[1], precision)}`];
    }
    case 'MultiPoint': {
      const points = geometry.coordinates as number[][];
      if (points.length === 1) return [`Point ${fmt(points[0][0], precision)} ${fmt(points[0][1], precision)}`];
      return [`MultiPoint ${points.length}`, ...points.map((c) => `  ${fmt(c[0], precision)} ${fmt(c[1], precision)}`)];
    }
    case 'LineString':
      return formatMifLine(geometry.coordinates as number[][], precision);
    case 'MultiLineString': {
      const lines = geometry.coordinates as number[][][];
      if (lines.length === 1) return formatMifLine(lines[0], precision);
      return formatMifPolyline(lines, precision);
    }
    case 'Polygon':
      return formatMifRegion([geometry.coordinates as number[][][]], precision);
    case 'MultiPolygon':
      return formatMifRegion(geometry.coordinates as number[][][][], precision);
    default:
      return ['None'];
  }
}

function formatMifLine(coords: number[][], precision: number): string[] {
  return [`Line ${coords.length}`, ...coords.map((c) => `  ${fmt(c[0], precision)} ${fmt(c[1], precision)}`)];
}

function formatMifPolyline(lines: number[][][], precision: number): string[] {
  const out = [`Pline Multiple ${lines.length}`];
  for (const line of lines) {
    out.push(`  ${line.length}`);
    for (const c of line) out.push(`  ${fmt(c[0], precision)} ${fmt(c[1], precision)}`);
  }
  return out;
}

function formatMifRegion(polygons: number[][][][], precision: number): string[] {
  const rings = polygons.flat();
  const out = [`Region ${rings.length}`];
  for (const ring of rings) {
    out.push(`  ${ring.length}`);
    for (const c of ring) out.push(`    ${fmt(c[0], precision)} ${fmt(c[1], precision)}`);
  }
  return out;
}

function formatMidValue(value: unknown, column: MifColumn): string {
  if (value === null || value === undefined) return '';
  if (column.type.toLowerCase() === 'logical') return value ? 'T' : 'F';
  if (typeof value === 'number') return String(value);
  return `"${formatPropertyValue(value).replace(/"/g, '""')}"`;
}

function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function fmt(value: number, precision: number): string {
  return Number.isFinite(value) ? value.toFixed(precision) : '0';
}
