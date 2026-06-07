import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BBox, Feature, Geometry, ParseResult, WriteOptions } from '../types.js';

const SHAPE_POINT = 1;
const SHAPE_POLYLINE = 3;
const SHAPE_POLYGON = 5;
const SHAPE_MULTIPOINT = 8;

interface DbfFieldWrite {
  sourceName: string;
  name: string;
  type: 'C' | 'N' | 'L';
  size: number;
  decimals: number;
}

interface ShapeRecord {
  content: Buffer;
  contentLengthWords: number;
}

export function writeShapefile(result: ParseResult, opts: WriteOptions = {}): void {
  if (!opts.outputPath) throw new Error('writeShapefile requires outputPath.');
  const features = result.features.filter((f) => f.geometry);
  const shapeType = inferShapeType(features);
  const base = stripExt(opts.outputPath);
  fs.mkdirSync(path.dirname(path.resolve(base)), { recursive: true });

  const records = features.map((f) => shapeRecord(f.geometry!, shapeType));
  const bbox = computeBBox(features);
  fs.writeFileSync(base + '.shp', buildShp(records, shapeType, bbox));
  fs.writeFileSync(base + '.shx', buildShx(records, shapeType, bbox));
  fs.writeFileSync(base + '.dbf', buildDbf(features));
  fs.writeFileSync(base + '.cpg', 'UTF-8\n', 'utf8');
}

function inferShapeType(features: Feature[]): number {
  const families = new Set(features.map((f) => geometryFamily(f.geometry)));
  families.delete('none');
  if (families.size === 0) return SHAPE_POINT;
  if (families.size > 1) {
    throw new Error('Shapefile output requires a single geometry family per bundle.');
  }
  const family = [...families][0];
  if (family === 'point') {
    return features.some((f) => f.geometry?.type === 'MultiPoint') ? SHAPE_MULTIPOINT : SHAPE_POINT;
  }
  if (family === 'line') return SHAPE_POLYLINE;
  if (family === 'polygon') return SHAPE_POLYGON;
  throw new Error(`Unsupported shapefile geometry family: ${family}`);
}

function geometryFamily(geometry: Geometry | null): 'point' | 'line' | 'polygon' | 'none' {
  if (!geometry) return 'none';
  if (geometry.type === 'Point' || geometry.type === 'MultiPoint') return 'point';
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') return 'line';
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') return 'polygon';
  return 'none';
}

function shapeRecord(geometry: Geometry, shapeType: number): ShapeRecord {
  if (shapeType === SHAPE_POINT) {
    const point = firstPoint(geometry);
    const content = Buffer.alloc(20);
    content.writeInt32LE(SHAPE_POINT, 0);
    content.writeDoubleLE(point[0], 4);
    content.writeDoubleLE(point[1], 12);
    return { content, contentLengthWords: content.length / 2 };
  }
  if (shapeType === SHAPE_MULTIPOINT) {
    const points = pointParts(geometry);
    const content = Buffer.alloc(40 + points.length * 16);
    content.writeInt32LE(SHAPE_MULTIPOINT, 0);
    writeBBox(content, bboxFromPoints(points), 4);
    content.writeInt32LE(points.length, 36);
    let cursor = 40;
    for (const point of points) {
      content.writeDoubleLE(point[0], cursor);
      content.writeDoubleLE(point[1], cursor + 8);
      cursor += 16;
    }
    return { content, contentLengthWords: content.length / 2 };
  }

  const parts = shapeType === SHAPE_POLYLINE ? lineParts(geometry) : polygonParts(geometry);
  const points = parts.flat();
  const content = Buffer.alloc(44 + parts.length * 4 + points.length * 16);
  content.writeInt32LE(shapeType, 0);
  writeBBox(content, bboxFromPoints(points), 4);
  content.writeInt32LE(parts.length, 36);
  content.writeInt32LE(points.length, 40);
  let cursor = 44;
  let start = 0;
  for (const part of parts) {
    content.writeInt32LE(start, cursor);
    cursor += 4;
    start += part.length;
  }
  for (const point of points) {
    content.writeDoubleLE(point[0], cursor);
    content.writeDoubleLE(point[1], cursor + 8);
    cursor += 16;
  }
  return { content, contentLengthWords: content.length / 2 };
}

function firstPoint(geometry: Geometry): number[] {
  if (geometry.type === 'Point') return geometry.coordinates as number[];
  if (geometry.type === 'MultiPoint') return (geometry.coordinates as number[][])[0] ?? [0, 0];
  throw new Error(`Unsupported point shapefile geometry: ${geometry.type}`);
}

function pointParts(geometry: Geometry): number[][] {
  if (geometry.type === 'Point') return [geometry.coordinates as number[]];
  if (geometry.type === 'MultiPoint') return geometry.coordinates as number[][];
  throw new Error(`Unsupported point shapefile geometry: ${geometry.type}`);
}

function lineParts(geometry: Geometry): number[][][] {
  if (geometry.type === 'LineString') return [geometry.coordinates as number[][]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as number[][][];
  throw new Error(`Unsupported polyline shapefile geometry: ${geometry.type}`);
}

function polygonParts(geometry: Geometry): number[][][] {
  if (geometry.type === 'Polygon') return geometry.coordinates as number[][][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).flat();
  throw new Error(`Unsupported polygon shapefile geometry: ${geometry.type}`);
}

function buildShp(records: ShapeRecord[], shapeType: number, bbox: BBox): Buffer {
  const recordBytes = records.reduce((sum, record) => sum + 8 + record.content.length, 0);
  const out = Buffer.alloc(100 + recordBytes);
  writeMainHeader(out, shapeType, bbox, out.length / 2);
  let offset = 100;
  records.forEach((record, idx) => {
    out.writeInt32BE(idx + 1, offset);
    out.writeInt32BE(record.contentLengthWords, offset + 4);
    record.content.copy(out, offset + 8);
    offset += 8 + record.content.length;
  });
  return out;
}

function buildShx(records: ShapeRecord[], shapeType: number, bbox: BBox): Buffer {
  const out = Buffer.alloc(100 + records.length * 8);
  writeMainHeader(out, shapeType, bbox, out.length / 2);
  let shpOffsetWords = 50;
  let cursor = 100;
  for (const record of records) {
    out.writeInt32BE(shpOffsetWords, cursor);
    out.writeInt32BE(record.contentLengthWords, cursor + 4);
    shpOffsetWords += 4 + record.contentLengthWords;
    cursor += 8;
  }
  return out;
}

function writeMainHeader(out: Buffer, shapeType: number, bbox: BBox, fileLengthWords: number): void {
  out.writeInt32BE(9994, 0);
  out.writeInt32BE(fileLengthWords, 24);
  out.writeInt32LE(1000, 28);
  out.writeInt32LE(shapeType, 32);
  writeBBox(out, bbox, 36);
}

function writeBBox(out: Buffer, bbox: BBox, offset: number): void {
  out.writeDoubleLE(bbox[0] ?? 0, offset);
  out.writeDoubleLE(bbox[1] ?? 0, offset + 8);
  out.writeDoubleLE(bbox[2] ?? 0, offset + 16);
  out.writeDoubleLE(bbox[3] ?? 0, offset + 24);
}

function computeBBox(features: Feature[]): BBox {
  const points = features.flatMap((f) => collectPoints(f.geometry));
  return bboxFromPoints(points);
}

function bboxFromPoints(points: number[][]): BBox {
  if (points.length === 0) return [0, 0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  return [minX, minY, maxX, maxY];
}

function collectPoints(geometry: Geometry | null): number[][] {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates as number[]];
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates as number[][];
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return (geometry.coordinates as number[][][]).flat();
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).flat(2);
  return [];
}

function buildDbf(features: Feature[]): Buffer {
  const fields = inferDbfFields(features);
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((sum, field) => sum + field.size, 0);
  const out = Buffer.alloc(headerLen + features.length * recordLen + 1, 0x20);
  const now = new Date();
  out[0] = 0x03;
  out[1] = now.getFullYear() - 1900;
  out[2] = now.getMonth() + 1;
  out[3] = now.getDate();
  out.writeUInt32LE(features.length, 4);
  out.writeUInt16LE(headerLen, 8);
  out.writeUInt16LE(recordLen, 10);
  out[29] = 0x57;

  let descriptor = 32;
  for (const field of fields) {
    Buffer.from(field.name, 'ascii').copy(out, descriptor, 0, 11);
    out[descriptor + 11] = field.type.charCodeAt(0);
    out[descriptor + 16] = field.size;
    out[descriptor + 17] = field.decimals;
    descriptor += 32;
  }
  out[headerLen - 1] = 0x0d;

  let cursor = headerLen;
  for (const feature of features) {
    out[cursor] = 0x20;
    let cell = cursor + 1;
    for (const field of fields) {
      const value = formatDbfValue(feature.properties?.[field.sourceName], field);
      Buffer.from(value, 'utf8').copy(out, cell, 0, field.size);
      cell += field.size;
    }
    cursor += recordLen;
  }
  out[out.length - 1] = 0x1a;
  return out;
}

function inferDbfFields(features: Feature[]): DbfFieldWrite[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  const usedNames = new Set<string>();
  return keys.map((sourceName) => {
    const values = features.map((f) => f.properties?.[sourceName]).filter((v) => v !== null && v !== undefined);
    const name = uniqueDbfName(sourceName, usedNames);
    if (values.length > 0 && values.every((v) => typeof v === 'boolean')) {
      return { sourceName, name, type: 'L', size: 1, decimals: 0 };
    }
    if (values.length > 0 && values.every((v) => typeof v === 'number')) {
      const decimals = values.every((v) => Number.isInteger(v)) ? 0 : 6;
      return { sourceName, name, type: 'N', size: 18, decimals };
    }
    return { sourceName, name, type: 'C', size: 254, decimals: 0 };
  });
}

function uniqueDbfName(name: string, used: Set<string>): string {
  const base = (name.replace(/[^A-Za-z0-9_]/g, '_') || 'FIELD').slice(0, 10);
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) {
    const suffix = String(n++);
    candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function formatDbfValue(value: unknown, field: DbfFieldWrite): string {
  if (field.type === 'L') return value ? 'T' : 'F';
  if (field.type === 'N') {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const text = field.decimals > 0 ? n.toFixed(field.decimals) : String(Math.trunc(n));
    return text.padStart(field.size, ' ').slice(0, field.size);
  }
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  return Buffer.from(text, 'utf8').subarray(0, field.size).toString('utf8').padEnd(field.size, ' ');
}

function stripExt(filePath: string): string {
  return filePath.replace(/\.(shp|shx|dbf|prj|cpg)$/i, '');
}
