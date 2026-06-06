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
import type { Feature, Geometry, ParseResult, Properties } from '../types.js';

interface MifColumn {
  name: string;
  type: string;
  width?: number;
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
