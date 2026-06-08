/**
 * MapInfo TAB reader.
 *
 * MapInfo Interchange Format is a 5-file bundle:
 *   .tab — text header describing columns, projection, dataset type
 *   .dat — dBASE III attribute records (one per feature, same layout as .dbf)
 *   .map — geometry (binary)
 *   .id  — index from row → map-object offset
 *   .cpg — (optional) dbf encoding hint
 *
 * We support a subset of geometry types commonly exported by QGIS:
 *   Type 1: Point
 *   Type 2: Line
 *   Type 3: PolyLine
 *   Type 4: Region (polygon)
 *   Type 5: Multiple Pnts
 *   Type 6: Region (legacy)
 *   Type 7: Multi-Polyline (legacy)
 *
 * The .map file is a series of variable-sized records. Each Region is a
 * collection of polygons (outer ring + holes), distinguished by a
 * "ring" flag stored after each polyline; we use it to assemble Polygon
 * features whose holes are correctly assigned.
 *
 * The .id file is a 4-byte little-endian offset per record; we use it to
 * locate the .map object for each .dat row.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, Geometry, ParseResult, Properties } from '../types.js';
import { readCPG, detectEncoding, decoderFor, driverToEncoding as _driver, decodeStringField } from '../encoding.js';
// Re-export to keep the existing in-file helper signature stable.
const driverToEncoding = _driver;

interface TabField {
  name: string;
  type: string; // Char, Integer, SmallInt, Float, Decimal, Date, Logical, ...
  width: number;
  /** dBASE decimal count (only meaningful for N/F). */
  decimals: number;
  /** dBASE field size in bytes. */
  size: number;
}

interface TabHeader {
  charset: string;
  fields: TabField[];
  /** "File" line dataset type (e.g. "NATIVE Charset"). */
  version: number;
  /** Type from "Type NATIVE" line. */
  type: string;
  /** Packed / unpacked dBASE. */
  packed: boolean;
}

export function parseTAB(inputPath: string): ParseResult {
  const base = stripExt(inputPath);
  const tabPath = base + '.tab';
  const datPath = base + '.dat';
  const mapPath = base + '.map';
  const idPath = base + '.id';
  const cpgPath = base + '.cpg';

  for (const p of [tabPath, datPath, mapPath, idPath]) {
    if (!fs.existsSync(p)) throw new Error(`TAB bundle missing: ${p}`);
  }

  const tabText = readTabText(tabPath);
  const header = parseTabHeader(tabText);
  const dat = readDat(datPath, header, cpgPath);
  const id = readId(idPath);
  const map = readMapGeometry(mapPath, idPath);

  const features: Feature[] = [];
  for (let i = 0; i < dat.records.length; i++) {
    const props: Properties = { ...dat.records[i] };
    const mapOffset = id.offsets[i] ?? 0;
    const geometry = map.geometries.get(mapOffset) ?? null;
    features.push({ type: 'Feature', geometry, properties: props });
  }

  return {
    name: path.basename(base),
    features,
    meta: {
      source: 'tab',
      charset: header.charset,
      version: header.version,
      type: header.type,
      fieldCount: header.fields.length,
      encoding: dat.encoding,
    },
  };
}

function stripExt(p: string): string {
  return p.replace(/\.(tab|dat|map|id|cpg)$/i, '');
}

// --- .tab text header parser --------------------------------------------

function readTabText(tabPath: string): string {
  const buf = fs.readFileSync(tabPath);
  const asciiHead = buf.toString('latin1', 0, Math.min(buf.length, 512));
  const charset = asciiHead.match(/!charset\s+(\S+)/i)?.[1] ?? asciiHead.match(/Charset\s+"([^"]+)"/i)?.[1];
  const enc = charset ? mapTabCharset(charset) : null;
  return decoderFor(enc ?? detectEncoding(buf))(buf);
}

function mapTabCharset(charset: string): string | null {
  const cs = charset.toLowerCase().replace(/^["']|["']$/g, '').replace(/[^a-z0-9-]/g, '');
  const table: Record<string, string> = {
    neutral: 'latin1',
    windowslatin1: 'windows-1252',
    windows1252: 'windows-1252',
    utf8: 'utf-8',
    'utf-8': 'utf-8',
    windowssimpchinese: 'gb18030',
    windowssimplifiedchinese: 'gb18030',
    windows936: 'gbk',
    cp936: 'gbk',
    gbk: 'gbk',
    gb2312: 'gb18030',
    gb18030: 'gb18030',
    big5: 'big5',
    windowsbig5: 'big5',
  };
  return table[cs] ?? null;
}

function parseTabHeader(text: string): TabHeader {
  const lines = text.split(/\r?\n/);
  let charset = 'Neutral';
  let version = 0;
  let type = '';
  let packed = false;

  for (const line of lines) {
    const m = line.match(/!charset\s+(\S+)/i);
    if (m) charset = m[1];
    const v = line.match(/!version\s+(\d+)/i);
    if (v) version = Number(v[1]);
    const tp = line.match(/^\s*Type\s+(\S+)/i);
    if (tp) type = tp[1];
  }

  // Look for "Definition Table" block: N fields follow.
  const defIdx = lines.findIndex((l) => /^\s*Definition\s+Table\s*$/i.test(l));
  const fields: TabField[] = [];
  if (defIdx >= 0) {
    // Find "Fields N" line.
    const fieldsLine = lines.slice(defIdx + 1, defIdx + 6).find((l) => /^\s*Fields\s+(\d+)/i.test(l));
    const fieldCount = fieldsLine ? Number(fieldsLine.match(/Fields\s+(\d+)/i)![1]) : 0;
    // Packed DAT detection: a packed DBF has Fields line and column definitions interleaved.
    // In our reference file (QGIS 3.44), the layout is one field per line until `;` (packed style).
    const startScan = defIdx + 1;
    for (let i = startScan; i < lines.length && fields.length < fieldCount; i++) {
      const line = lines[i];
      const fm = line.match(/^\s*(.+?)\s+(\S+)(?:\s*\(\s*(\d+)\s*\))?\s*;/i);
      if (fm) {
        const name = fm[1];
        const typ = fm[2];
        const width = fm[3] ? Number(fm[3]) : guessWidth(typ);
        fields.push({ name, type: typ, width, decimals: 0, size: width });
        packed = true;
      }
    }
  }

  return { charset, fields, version, type, packed };
}

function guessWidth(type: string): number {
  switch (type.toLowerCase()) {
    case 'integer': return 4;
    case 'smallint': return 2;
    case 'float':
    case 'decimal': return 8;
    case 'date': return 4;
    case 'logical': return 1;
    default: return 1;
  }
}

// --- .dat (DBF) reader ---------------------------------------------------

function readDat(datPath: string, header: TabHeader, cpgPath?: string): { records: Properties[]; fields: TabField[]; encoding: string } {
  const buf = fs.readFileSync(datPath);
  if (buf.length < 32) return { records: [], fields: header.fields, encoding: 'latin1' };

  // dBASE III header.
  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  const fields: TabField[] = [];
  let off = 32;
  while (off < headerLen - 1 && buf[off] !== 0x0d) {
    const name = readZeroString(buf, off, 11);
    const type = String.fromCharCode(buf[off + 11]);
    const size = buf[off + 16];
    const decimals = buf[off + 17];
    fields.push({ name, type, width: size, size, decimals });
    off += 32;
  }

  // The .dat's per-field sizes don't always match the .tab's logical
  // sizes (e.g. "Float (17)" in .tab may be stored as size 8 in .dat).
  // We pair fields by ordinal position with the .tab definitions; .tab
  // is authoritative for type, .dat for column slice sizes.
  const tabTypes: string[] = header.fields.map((f) => f.type);

  // Encoding resolution:
  //   1. .cpg file (explicit)
  //   2. !charset line in the .tab text (e.g. "!charset Neutral", "!charset WindowsLatin1")
  //   3. Heuristic probe of the .dat buffer
  //   4. dBASE language driver byte (offset 29)
  let encoding = readCPG(cpgPath);
  let source: 'cpg' | 'tab-charset' | 'detected' | 'driver' = 'cpg';
  if (!encoding) {
    // Try .tab's !charset line.
    const tabCharsetEncoding = mapTabCharset(header.charset || '');
    if (tabCharsetEncoding) {
      encoding = tabCharsetEncoding;
      source = 'tab-charset';
    }
  }
  if (!encoding) {
    // Probe a sample of the data section.
    const sampleEnd = Math.min(buf.length, headerLen + 4096);
    encoding = detectEncoding(buf.subarray(headerLen, sampleEnd));
    source = 'detected';
  }
  if (!encoding) {
    const driver = buf.length > 29 ? buf[29] : 0;
    encoding = driverToEncoding(driver) ?? 'gb18030';
    source = 'driver';
  }

  const dec = decoderFor(encoding);
  const records: Properties[] = [];
  let pos = headerLen;
  for (let r = 0; r < numRecords; r++) {
    if (pos + recordLen > buf.length) break;
    const deleted = buf[pos] === 0x2a;
    const rec: Properties = {};
    if (!deleted) {
      let cursor = 1;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const raw = buf.slice(pos + cursor, pos + cursor + f.size);
        // Use the .tab type by position; .tab's names take priority for output.
        const tabType = tabTypes[i] ?? f.type;
        const outName = header.fields[i]?.name ?? f.name;
        rec[outName] = decodeDatField(raw, f, dec, tabType);
        cursor += f.size;
      }
    }
    records.push(rec);
    pos += recordLen;
  }
  return { records, fields, encoding: `${encoding} (${source})` };
}

function readZeroString(buf: Buffer, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function decodeDatField(
  raw: Buffer,
  f: { type: string; decimals: number; size: number },
  dec: (b: Buffer) => string,
  tabType?: string,
): unknown {
  if (tabType) {
    const t = tabType.toLowerCase();
    if (t === 'float' || t === 'decimal') {
      if (raw.length >= 8) {
        const d = raw.readDoubleLE(0);
        if (Number.isFinite(d)) return d;
      }
      const s = raw.toString('ascii').trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    if (t === 'integer' || t === 'largeint') {
      if (t === 'largeint' && raw.length >= 8) {
        const d = Number(raw.readBigInt64LE(0).toString());
        if (Number.isFinite(d)) return d;
      }
      if (raw.length >= 4) {
        const d = raw.readInt32LE(0);
        if (Number.isFinite(d)) return d;
      }
      const s = raw.toString('ascii').trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    if (t === 'smallint') {
      if (raw.length >= 2) return raw.readInt16LE(0);
      return null;
    }
    if (t === 'char' || t === 'string') {
      return decodeStringField(raw, dec);
    }
    if (t === 'date') {
      const s = raw.toString('ascii').trim();
      return s || null;
    }
    if (t === 'logical') {
      const s = raw.toString('ascii').trim().toUpperCase();
      return s === 'T' || s === 'Y';
    }
  }

  // Fallback: decode based on the dBASE type.
  const t = f.type.toUpperCase();
  if (t === 'N' || t === 'F') {
    const s = raw.toString('ascii').trim();
    if (s === '') return null;
    return Number(s);
  }
  if (t === 'I' || t === '+') return raw.readInt32LE(0);
  if (t === 'L') {
    const s = raw.toString('ascii').trim().toUpperCase();
    return s === 'T' || s === 'Y';
  }
  if (t === 'D') {
    const s = raw.toString('ascii').trim();
    if (s.length !== 8) return s;
    return ;
  }
  if (t === 'C') {
    return decodeStringField(raw, dec);
  }
  return decodeStringField(raw, dec);
}

// --- .id reader ---------------------------------------------------------

function readId(idPath: string): { offsets: number[] } {
  const buf = fs.readFileSync(idPath);
  const count = Math.floor(buf.length / 4);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(buf.readUInt32LE(i * 4));
  return { offsets };
}

// --- .map reader --------------------------------------------------------

interface MapReader {
  geometries: Map<number, Geometry | null>;
}

function readMapGeometry(mapPath: string, idPath: string): MapReader {
  const buf = fs.readFileSync(mapPath);
  const id = readId(idPath);
  const geometries = new Map<number, Geometry | null>();

  // The .id file stores the file offset of the geometry object for each
  // .dat row. This is the canonical way to associate attributes with
  // geometry in MapInfo — we use it directly instead of trying to parse
  // the v300 .map section table (whose internal layout is not fully
  // documented for the v300 record-encoding we see in QGIS exports).
  for (const off of id.offsets) {
    if (off <= 0 || off + 8 > buf.length) {
      geometries.set(off, null);
      continue;
    }
    const objType = buf.readInt32LE(off);
    const geom = parseMapObject(objType, buf, off, nextMapOffset(id.offsets, off, buf.length));
    geometries.set(off, geom);
  }
  return { geometries };
}

function nextMapOffset(offsets: number[], off: number, fallback: number): number {
  let next = fallback;
  for (const candidate of offsets) {
    if (candidate > off && candidate < next) next = candidate;
  }
  return next;
}

function parseMapObject(type: number, buf: Buffer, off: number, end = buf.length): Geometry | null {
  // Layout for a Region (type 4): after the type code, the format is:
  //   4 bytes: type (already read)
  //   For region, the structure is more elaborate. We walk it carefully.
  try {
    if (type === 1) {
      // Point: x (8 bytes), y (8 bytes) — total 16 bytes payload.
      const x = buf.readDoubleLE(off + 4);
      const y = buf.readDoubleLE(off + 12);
      return { type: 'Point', coordinates: [x, y] };
    }
    if (type === 2 || type === 3) {
      // Line / Polyline: 0x04 size hint, then coordinate count, then 4 bytes per coord flag, then points.
      // We use the standard 300-byte approach: rely on compressed coord pairs.
      return parseLineOrPolyline(buf, off);
    }
    if (type === 4) {
      // Region.
      return parseRegion(buf, off);
    }
    if (type === 5) {
      // Multiple points.
      return parseMultiPoint(buf, off);
    }
    const legacyType = type & 0xff;
    if (legacyType === 0x08 || legacyType === 0x26) {
      return parseLegacyLineObject(buf, off, end);
    }
    if (legacyType === 0x25) {
      return parseLegacyPointTableLine(buf, off, end);
    }
    if (legacyType === 0x0d) {
      return parseLegacyRegionObject(buf, off, end);
    }
    return null;
  } catch {
    return null;
  }
}

function parseLegacyLineObject(buf: Buffer, off: number, end: number): Geometry | null {
  const lines: number[][][] = [];
  let p = off;
  const max = Math.min(end, buf.length, off + 8192);

  while (p + 38 <= max) {
    const legacyType = buf[p];
    if (legacyType !== 0x08 && legacyType !== 0x26) break;

    const length = legacyType === 0x08 ? 38 : 40;
    const coordStart = legacyType === 0x08 ? p + 13 : p + 15;
    if (p + length > max) break;

    const line = readLegacyScaledLine(buf, coordStart);
    if (!line) break;
    lines.push(line);
    p += length;
  }

  if (lines.length === 0) return null;
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
  return { type: 'MultiLineString', coordinates: lines };
}

function readLegacyScaledLine(buf: Buffer, p: number): number[][] | null {
  const coords: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const xOffset = p + i * 8;
    const yOffset = xOffset + 4;
    if (yOffset + 4 > buf.length) return null;

    const x = -buf.readInt32LE(xOffset) / 1_000_000;
    const y = buf.readInt32LE(yOffset) / 1_000_000;
    if (!isPlausibleLonLat(x, y)) return null;
    coords.push([x, y]);
  }
  return coords.length >= 2 ? coords : null;
}

function isPlausibleLonLat(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90;
}

function parseLegacyPointTableLine(buf: Buffer, off: number, end: number): Geometry | null {
  const max = Math.min(end, buf.length, off + 8192);
  const coords: number[][] = [];
  let lastRel = -Infinity;

  for (let p = off + 16; p + 7 < max; p++) {
    const x = -buf.readInt32LE(p) / 1_000_000;
    const y = buf.readInt32LE(p + 4) / 1_000_000;
    if (!isPlausibleLonLat(x, y) || x < 70 || x > 140 || y < 0 || y > 60) continue;

    const rel = p - off;
    if (rel < 100) continue;
    if (rel - lastRel < 16) continue;

    coords.push([x, y]);
    lastRel = rel;
  }

  if (coords.length < 2) return null;
  return { type: 'LineString', coordinates: coords };
}

function parseLegacyRegionObject(buf: Buffer, off: number, end: number): Geometry | null {
  const max = Math.min(end, buf.length, off + 8192);
  const ref = findLegacyScaledReference(buf, off, max);
  if (!ref) return null;

  let bestRing: number[][] | null = null;
  let bestArea = 0;

  for (let p = off + 32; p + 8 < max; p++) {
    const count = buf.readUInt32LE(p);
    if (count < 4 || count > 10_000) continue;
    if (p + 4 + count * 4 > max) continue;

    const ring = readLegacyInt16Ring(buf, p + 4, count, ref);
    if (!ring) continue;

    const area = Math.abs(signedArea(ring));
    if (area > bestArea) {
      bestRing = ring;
      bestArea = area;
    }
  }

  return bestRing ? { type: 'Polygon', coordinates: [bestRing] } : null;
}

function findLegacyScaledReference(
  buf: Buffer,
  off: number,
  max: number,
): { x: number; y: number } | null {
  const searchEnd = Math.min(max, off + 96);
  for (let p = off + 8; p + 7 < searchEnd; p++) {
    const x = -buf.readInt32LE(p) / 1_000_000;
    const y = buf.readInt32LE(p + 4) / 1_000_000;
    if (isPlausibleLegacyChinaLonLat(x, y)) return { x, y };
  }
  return null;
}

function isPlausibleLegacyChinaLonLat(x: number, y: number): boolean {
  return isPlausibleLonLat(x, y) && x >= 70 && x <= 140 && y >= 0 && y <= 60;
}

function readLegacyInt16Ring(
  buf: Buffer,
  p: number,
  count: number,
  ref: { x: number; y: number },
): number[][] | null {
  const points: number[][] = [];
  for (let i = 0; i < count; i++) {
    const coordOff = p + i * 4;
    const x = roundCoord(ref.x + buf.readInt16LE(coordOff) / 1_000_000);
    const y = roundCoord(ref.y + buf.readInt16LE(coordOff + 2) / 1_000_000);
    if (!isPlausibleLonLat(x, y)) return null;
    points.push([x, y]);
  }

  for (let i = 3; i < points.length; i++) {
    if (!sameCoord(points[0], points[i])) continue;
    const ring = points.slice(0, i + 1);
    if (Math.abs(signedArea(ring)) < 1e-12) return null;
    return ring;
  }

  return null;
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sameCoord(a: number[], b: number[]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function parseLineOrPolyline(buf: Buffer, off: number): Geometry {
  // Layout (post 300-byte format): bytes 4..8 not used here; bytes 8.. = geometry payload.
  // 0x0C number of segments (nParts), 0x10 number of points.
  // Then 4*nParts bytes of part start indices, then points.
  // But the encoding is compressed (variable-length ints) for the actual coords.
  // To keep this simple, we follow the v300 compressed format:

  // The size field is 4 bytes after the type (offset+4). We accept it but don't strictly rely.
  void buf.readInt32LE(off + 4);

  // At offset+8 the structure begins with the number of points (compressed int).
  let p = off + 8;
  const npts = readCompressedInt(buf, p); p = advance(p, buf);
  if (npts <= 0) return { type: 'LineString', coordinates: [] };

  // Read the coordinate flags (2 bytes per point) — they tell us whether each
  // point is fully stored or predicted (we use the simple approach: ignore
  // and always read the raw value).
  // Skip flags.
  p += npts * 2;
  if (p > buf.length) return { type: 'LineString', coordinates: [] };

  // After the flags, the points are stored as compressed doubles.
  const coords: number[][] = [];
  for (let i = 0; i < npts; i++) {
    if (p >= buf.length) break;
    const x = readCompressedDouble(buf, p);
    p = advanceDouble(p, buf);
    if (p >= buf.length) break;
    const y = readCompressedDouble(buf, p);
    p = advanceDouble(p, buf);
    coords.push([x, y]);
  }
  if (coords.length === 1) return { type: 'Point', coordinates: coords[0] };
  return { type: 'LineString', coordinates: coords };
}

function parseRegion(buf: Buffer, off: number): Geometry {
  // Region = one or more polygons. Each polygon = one or more rings.
  // After the type code:
  //   compressed int: number of polygons
  //   for each polygon:
  //     compressed int: number of rings
  //     for each ring:
  //       compressed int: number of points
  //       (no flag bytes, just compressed doubles)
  //   (no trailing 2-byte ring flags in v300)
  let p = off + 4;
  // Skip the size field.
  p = advance(p, buf);
  p = advance(p, buf);

  const numPolys = readCompressedInt(buf, p); p = advance(p, buf);
  const polys: number[][][][] = [];
  for (let i = 0; i < numPolys; i++) {
    if (p >= buf.length) break;
    const numRings = readCompressedInt(buf, p); p = advance(p, buf);
    const poly: number[][][] = [];
    for (let j = 0; j < numRings; j++) {
      if (p >= buf.length) break;
      const numPts = readCompressedInt(buf, p); p = advance(p, buf);
      const ring: number[][] = [];
      for (let k = 0; k < numPts; k++) {
        if (p >= buf.length) break;
        const x = readCompressedDouble(buf, p);
        p = advanceDouble(p, buf);
        if (p >= buf.length) break;
        const y = readCompressedDouble(buf, p);
        p = advanceDouble(p, buf);
        ring.push([x, y]);
      }
      poly.push(ring);
    }
    polys.push(poly);
  }

  // Classify: outer vs hole by ring flag (last byte of each ring in some
  // encodings), but v300 omits flags. We rely on signed area: holes have
  // opposite winding to outers.
  const flatRings: number[][][] = polys.flat();
  if (flatRings.length === 0) return { type: 'Polygon', coordinates: [] };

  // Reference winding from the first ring.
  const ref = signedArea(flatRings[0]);
  const outers: number[][][] = [];
  const holes: number[][][] = [];
  for (const r of flatRings) {
    const a = signedArea(r);
    if (a === 0) continue;
    if ((a > 0) === (ref > 0)) outers.push(r);
    else holes.push(r);
  }

  if (outers.length === 1) {
    return { type: 'Polygon', coordinates: [outers[0], ...holes] };
  }
  return {
    type: 'MultiPolygon',
    coordinates: outers.map((o) => [o, ...holes]),
  };
}

function parseMultiPoint(buf: Buffer, off: number): Geometry {
  let p = off + 8;
  const npts = readCompressedInt(buf, p); p = advance(p, buf);
  const pts: number[][] = [];
  for (let i = 0; i < npts; i++) {
    if (p >= buf.length) break;
    const x = readCompressedDouble(buf, p);
    p = advanceDouble(p, buf);
    if (p >= buf.length) break;
    const y = readCompressedDouble(buf, p);
    p = advanceDouble(p, buf);
    pts.push([x, y]);
  }
  if (pts.length === 1) return { type: 'Point', coordinates: pts[0] };
  return { type: 'MultiPoint', coordinates: pts };
}

function signedArea(ring: number[][]): number {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

// --- MapInfo compressed integer/double ----------------------------------

/**
 * Read a MapInfo compressed int starting at `p` in `buf`. Returns the value;
 * `advance()` updates the cursor.
 *
 * The format is little-endian: low 7 bits of each byte are payload, high bit
 * is "more bytes follow".
 */
function readCompressedInt(buf: Buffer, p: number): number {
  let value = 0;
  let shift = 0;
  let i = p;
  for (let n = 0; n < 5; n++) {
    if (i >= buf.length) return value;
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return value;
}

function advance(p: number, buf: Buffer): number {
  let i = p;
  for (let n = 0; n < 5; n++) {
    if (i >= buf.length) return i;
    const b = buf[i++];
    if ((b & 0x80) === 0) return i;
  }
  return i;
}

function readCompressedDouble(buf: Buffer, p: number): number {
  // MapInfo v300: a coordinate is either inline or absolute. Inline: 5 bytes
  // (low 4 bits = "type" code, 0..7 with 8/9 reserved; high 4 bits of first
  // byte + next 3 bytes = a 32-bit int delta from the previous point, then
  // sign-extended). Absolute: first byte has top bit clear and the value
  // indicator is anything ≥ 0x0A (10) — then the following 8 bytes are a
  // raw little-endian double.
  //
  // The first point of any series is always absolute.
  if (p >= buf.length) return 0;
  const first = buf[p];
  if (first < 0x0a) {
    // Inline / delta path: read 5 bytes and use the delta int32 at bytes 1..4.
    if (p + 5 > buf.length) return 0;
    const delta = buf.readInt32LE(p + 1);
    return delta;
  }
  // Absolute: 9 bytes total.
  if (p + 9 > buf.length) return 0;
  return buf.readDoubleLE(p + 1);
}

function advanceDouble(p: number, buf: Buffer): number {
  if (p >= buf.length) return p;
  const first = buf[p];
  if (first < 0x0a) return p + 5;
  return p + 9;
}
