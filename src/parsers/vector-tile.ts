import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import type { BBox, Feature, Geometry, ParseResult, Properties } from '../types.js';
import { transformGeometry } from '../crs.js';

const WEB_MERCATOR_MAX = 20037508.342789244;
const WEB_MERCATOR_SIZE = WEB_MERCATOR_MAX * 2;
const DEFAULT_EXTENT = 4096;

export interface TileOptions {
  outputPath: string;
  minZoom?: number;
  maxZoom?: number;
  threads?: number;
  fromCrs?: string;
  layerName?: string;
}

export interface TileSummary {
  generatedTiles: number;
  emptyTilesSkipped: number;
  featureCount: number;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
  outputPath: string;
}

export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface PreparedFeature {
  geometry: Geometry;
  properties: Properties;
  bbox: BBox;
}

interface TileFeature {
  type: 1 | 2 | 3;
  geometry: number[];
  properties: Properties;
}

interface TileTask {
  z: number;
  x: number;
  y: number;
  tileBBox: BBox;
  candidates: PreparedFeature[];
}

interface EncodedTile {
  z: number;
  x: number;
  y: number;
  bytes: Buffer;
}

export async function writeVectorTiles(result: ParseResult, opts: TileOptions): Promise<TileSummary> {
  const options = normalizeTileOptions(opts, result.name);
  const prepared = prepareFeatures(result.features, options.fromCrs);
  if (prepared.length === 0) throw new Error('No valid geometries to tile.');

  const bbox = mergeBBoxes(prepared.map((feature) => feature.bbox));
  fs.mkdirSync(options.outputPath, { recursive: true });

  const tasks: TileTask[] = [];
  let emptyTilesSkipped = 0;
  for (let z = options.minZoom; z <= options.maxZoom; z++) {
    const range = tileRangeForBBox(bbox, z);
    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        const tileBBox = tileBBoxWebMercator(z, x, y);
        const candidates = prepared.filter((feature) => bboxIntersects(feature.bbox, tileBBox));
        if (candidates.length === 0) {
          emptyTilesSkipped++;
          continue;
        }
        tasks.push({ z, x, y, tileBBox, candidates });
      }
    }
  }

  const encodedTiles = await encodeTileTasks(tasks, options.layerName, options.threads);
  for (const tile of encodedTiles) {
    const outDir = path.join(options.outputPath, String(tile.z), String(tile.x));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${tile.y}.pbf`), tile.bytes);
  }

  return {
    generatedTiles: encodedTiles.length,
    emptyTilesSkipped: emptyTilesSkipped + (tasks.length - encodedTiles.length),
    featureCount: prepared.length,
    bbox,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    outputPath: options.outputPath,
  };
}

async function encodeTileTasks(tasks: TileTask[], layerName: string, threads: number): Promise<EncodedTile[]> {
  if (tasks.length === 0) return [];
  if (threads <= 1 || tasks.length === 1) return encodeTileTaskBatch(tasks, layerName);
  const workerCount = Math.min(threads, tasks.length);
  const batches = splitBatches(tasks, workerCount);
  const results = await Promise.all(batches.map((batch) => runTileWorker(batch, layerName)));
  return results.flat().sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
}

function encodeTileTaskBatch(tasks: TileTask[], layerName: string): EncodedTile[] {
  const encoded: EncodedTile[] = [];
  for (const task of tasks) {
    const tileFeatures = task.candidates
      .map((feature) => toTileFeature(feature, task.tileBBox))
      .filter((feature): feature is TileFeature => feature !== null);
    if (tileFeatures.length === 0) continue;
    encoded.push({ z: task.z, x: task.x, y: task.y, bytes: encodeMVT(layerName, tileFeatures) });
  }
  return encoded;
}

function runTileWorker(tasks: TileTask[], layerName: string): Promise<EncodedTile[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { tasks, layerName },
    });
    worker.on('message', (tiles: Array<{ z: number; x: number; y: number; bytes: Uint8Array }>) => {
      resolve(tiles.map((tile) => ({ ...tile, bytes: Buffer.from(tile.bytes) })));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Vector tile worker exited with code ${code}`));
    });
  });
}

function splitBatches<T>(items: T[], count: number): T[][] {
  const batches = Array.from({ length: count }, () => [] as T[]);
  items.forEach((item, index) => batches[index % count].push(item));
  return batches.filter((batch) => batch.length > 0);
}

export function computeWebMercatorBBox(features: Feature[], fromCrs: string = 'WGS84'): BBox {
  const prepared = prepareFeatures(features, fromCrs);
  if (prepared.length === 0) throw new Error('No valid geometries to compute bbox.');
  return mergeBBoxes(prepared.map((feature) => feature.bbox));
}

export function tileRangeForBBox(bbox: BBox, z: number): TileRange {
  const n = 2 ** z;
  const minTile = webMercatorToTile(bbox[0], bbox[3], z);
  const maxTile = webMercatorToTile(bbox[2], bbox[1], z);
  return {
    minX: clamp(Math.min(minTile.x, maxTile.x), 0, n - 1),
    maxX: clamp(Math.max(minTile.x, maxTile.x), 0, n - 1),
    minY: clamp(Math.min(minTile.y, maxTile.y), 0, n - 1),
    maxY: clamp(Math.max(minTile.y, maxTile.y), 0, n - 1),
  };
}

function normalizeTileOptions(opts: TileOptions, fallbackLayerName?: string) {
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = opts.maxZoom ?? 14;
  const threadsDefault = Math.max(1, os.cpus().length - 1);
  const threads = Math.floor(opts.threads ?? threadsDefault);
  if (!opts.outputPath) throw new Error('tile outputPath is required.');
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom)) throw new Error('min-zoom and max-zoom must be integers.');
  if (minZoom < 0 || maxZoom > 24) throw new Error('zoom levels must be between 0 and 24.');
  if (minZoom > maxZoom) throw new Error('min-zoom must be less than or equal to max-zoom.');
  if (!Number.isInteger(threads) || threads < 1) throw new Error('threads must be a positive integer.');
  return {
    outputPath: opts.outputPath,
    minZoom,
    maxZoom,
    threads,
    fromCrs: opts.fromCrs ?? 'WGS84',
    layerName: sanitizeLayerName(opts.layerName ?? fallbackLayerName ?? 'layer'),
  };
}

function prepareFeatures(features: Feature[], fromCrs: string): PreparedFeature[] {
  const prepared: PreparedFeature[] = [];
  for (const feature of features) {
    if (!feature.geometry) continue;
    const geometry = transformGeometry(feature.geometry, fromCrs, 'WebMercator');
    if (!geometry) continue;
    const bbox = geometryBBox(geometry);
    if (!bbox) continue;
    prepared.push({ geometry, properties: feature.properties ?? {}, bbox });
  }
  return prepared;
}

function geometryBBox(geometry: Geometry): BBox | null {
  const points = collectPoints(geometry);
  if (points.length === 0) return null;
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

function collectPoints(geometry: Geometry): number[][] {
  if (geometry.type === 'Point') return [geometry.coordinates as number[]];
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates as number[][];
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return (geometry.coordinates as number[][][]).flat();
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).flat(2);
  return [];
}

function mergeBBoxes(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((bbox) => bbox[0])),
    Math.min(...boxes.map((bbox) => bbox[1])),
    Math.max(...boxes.map((bbox) => bbox[2])),
    Math.max(...boxes.map((bbox) => bbox[3])),
  ];
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function webMercatorToTile(x: number, y: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const tx = Math.floor(((x + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n);
  const ty = Math.floor(((WEB_MERCATOR_MAX - y) / WEB_MERCATOR_SIZE) * n);
  return { x: tx, y: ty };
}

function tileBBoxWebMercator(z: number, x: number, y: number): BBox {
  const n = 2 ** z;
  const minX = (x / n) * WEB_MERCATOR_SIZE - WEB_MERCATOR_MAX;
  const maxX = ((x + 1) / n) * WEB_MERCATOR_SIZE - WEB_MERCATOR_MAX;
  const maxY = WEB_MERCATOR_MAX - (y / n) * WEB_MERCATOR_SIZE;
  const minY = WEB_MERCATOR_MAX - ((y + 1) / n) * WEB_MERCATOR_SIZE;
  return [minX, minY, maxX, maxY];
}

function toTileFeature(feature: PreparedFeature, tileBBox: BBox): TileFeature | null {
  const encodePoint = ([x, y]: number[]) => [
    clamp(Math.round(((x - tileBBox[0]) / (tileBBox[2] - tileBBox[0])) * DEFAULT_EXTENT), 0, DEFAULT_EXTENT),
    clamp(Math.round(((tileBBox[3] - y) / (tileBBox[3] - tileBBox[1])) * DEFAULT_EXTENT), 0, DEFAULT_EXTENT),
  ];

  if (feature.geometry.type === 'Point') {
    return { type: 1, geometry: encodePointGeometry([encodePoint(feature.geometry.coordinates as number[])]), properties: feature.properties };
  }
  if (feature.geometry.type === 'MultiPoint') {
    return { type: 1, geometry: encodePointGeometry((feature.geometry.coordinates as number[][]).map(encodePoint)), properties: feature.properties };
  }
  if (feature.geometry.type === 'LineString') {
    return { type: 2, geometry: encodeLineGeometry([(feature.geometry.coordinates as number[][]).map(encodePoint)]), properties: feature.properties };
  }
  if (feature.geometry.type === 'MultiLineString') {
    return { type: 2, geometry: encodeLineGeometry((feature.geometry.coordinates as number[][][]).map((line) => line.map(encodePoint))), properties: feature.properties };
  }
  if (feature.geometry.type === 'Polygon') {
    return { type: 3, geometry: encodePolygonGeometry((feature.geometry.coordinates as number[][][]).map((ring) => ring.map(encodePoint))), properties: feature.properties };
  }
  if (feature.geometry.type === 'MultiPolygon') {
    return { type: 3, geometry: encodePolygonGeometry((feature.geometry.coordinates as number[][][][]).flat().map((ring) => ring.map(encodePoint))), properties: feature.properties };
  }
  return null;
}

function encodePointGeometry(points: number[][]): number[] {
  if (points.length === 0) return [];
  const out = [command(1, points.length)];
  let cursor = [0, 0];
  for (const point of points) {
    out.push(zigZag(point[0] - cursor[0]), zigZag(point[1] - cursor[1]));
    cursor = point;
  }
  return out;
}

function encodeLineGeometry(lines: number[][][]): number[] {
  const out: number[] = [];
  let cursor = [0, 0];
  for (const line of lines) {
    const clean = dedupePoints(line);
    if (clean.length < 2) continue;
    out.push(command(1, 1), zigZag(clean[0][0] - cursor[0]), zigZag(clean[0][1] - cursor[1]));
    cursor = clean[0];
    out.push(command(2, clean.length - 1));
    for (let i = 1; i < clean.length; i++) {
      out.push(zigZag(clean[i][0] - cursor[0]), zigZag(clean[i][1] - cursor[1]));
      cursor = clean[i];
    }
  }
  return out;
}

function encodePolygonGeometry(rings: number[][][]): number[] {
  const out: number[] = [];
  let cursor = [0, 0];
  for (const ring of rings) {
    const clean = dedupePoints(ring);
    if (clean.length < 3) continue;
    const open = pointsEqual(clean[0], clean[clean.length - 1]) ? clean.slice(0, -1) : clean;
    if (open.length < 3) continue;
    out.push(command(1, 1), zigZag(open[0][0] - cursor[0]), zigZag(open[0][1] - cursor[1]));
    cursor = open[0];
    out.push(command(2, open.length - 1));
    for (let i = 1; i < open.length; i++) {
      out.push(zigZag(open[i][0] - cursor[0]), zigZag(open[i][1] - cursor[1]));
      cursor = open[i];
    }
    out.push(command(7, 1));
  }
  return out;
}

function dedupePoints(points: number[][]): number[][] {
  const out: number[][] = [];
  for (const point of points) {
    if (out.length === 0 || !pointsEqual(out[out.length - 1], point)) out.push(point);
  }
  return out;
}

function pointsEqual(a: number[], b: number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function command(id: number, count: number): number {
  return (count << 3) | id;
}

function zigZag(n: number): number {
  return (n << 1) ^ (n >> 31);
}

function zigZagBigInt(n: bigint): bigint {
  return n >= 0n ? n << 1n : ((-n) << 1n) - 1n;
}

function encodeMVT(layerName: string, features: TileFeature[]): Buffer {
  const keys: string[] = [];
  const values: unknown[] = [];
  const keyIndex = new Map<string, number>();
  const valueIndex = new Map<string, number>();
  const encodedFeatures = features.map((feature) => {
    const tags: number[] = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      const normalized = normalizePropertyValue(value);
      if (normalized === undefined) continue;
      let ki = keyIndex.get(key);
      if (ki === undefined) {
        ki = keys.length;
        keys.push(key);
        keyIndex.set(key, ki);
      }
      const valueKey = `${typeof normalized}:${String(normalized)}`;
      let vi = valueIndex.get(valueKey);
      if (vi === undefined) {
        vi = values.length;
        values.push(normalized);
        valueIndex.set(valueKey, vi);
      }
      tags.push(ki, vi);
    }
    return { ...feature, tags };
  });

  const layer = new PbfWriter();
  layer.uint32(15, 2);
  layer.string(1, layerName);
  for (const feature of encodedFeatures) {
    const f = new PbfWriter();
    f.packedUInt32(2, feature.tags);
    f.uint32(3, feature.type);
    f.packedUInt32(4, feature.geometry);
    layer.bytes(2, f.finish());
  }
  for (const key of keys) layer.string(3, key);
  for (const value of values) layer.bytes(4, encodeValue(value));
  layer.uint32(5, DEFAULT_EXTENT);

  const tile = new PbfWriter();
  tile.bytes(3, layer.finish());
  return tile.finish();
}

function normalizePropertyValue(value: unknown): unknown {
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function encodeValue(value: unknown): Buffer {
  const writer = new PbfWriter();
  if (typeof value === 'string' || value === null) writer.string(1, value === null ? '' : value);
  else if (typeof value === 'boolean') writer.bool(7, value);
  else if (typeof value === 'number' && Number.isInteger(value)) writer.sint64(6, value);
  else if (typeof value === 'number') writer.double(3, value);
  return writer.finish();
}

function sanitizeLayerName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fff.-]+/g, '_') || 'layer';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

class PbfWriter {
  private chunks: Buffer[] = [];

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }

  uint32(field: number, value: number): void {
    this.tag(field, 0);
    this.varint(value);
  }

  sint64(field: number, value: number): void {
    this.tag(field, 0);
    this.varintBigInt(zigZagBigInt(BigInt(value)));
  }

  bool(field: number, value: boolean): void {
    this.uint32(field, value ? 1 : 0);
  }

  double(field: number, value: number): void {
    this.tag(field, 1);
    const buf = Buffer.allocUnsafe(8);
    buf.writeDoubleLE(value, 0);
    this.chunks.push(buf);
  }

  string(field: number, value: string): void {
    this.bytes(field, Buffer.from(value, 'utf8'));
  }

  bytes(field: number, value: Buffer): void {
    this.tag(field, 2);
    this.varint(value.length);
    this.chunks.push(value);
  }

  packedUInt32(field: number, values: number[]): void {
    const packed = new PbfWriter();
    for (const value of values) packed.varint(value);
    this.bytes(field, packed.finish());
  }

  private tag(field: number, type: number): void {
    this.varint((field << 3) | type);
  }

  private varint(value: number): void {
    let n = value >>> 0;
    const bytes: number[] = [];
    while (n > 0x7f) {
      bytes.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    bytes.push(n);
    this.chunks.push(Buffer.from(bytes));
  }

  private varintBigInt(value: bigint): void {
    let n = value;
    const bytes: number[] = [];
    while (n > 0x7fn) {
      bytes.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    bytes.push(Number(n));
    this.chunks.push(Buffer.from(bytes));
  }
}

if (!isMainThread && parentPort) {
  const data = workerData as { tasks: TileTask[]; layerName: string };
  parentPort.postMessage(encodeTileTaskBatch(data.tasks, data.layerName));
}
