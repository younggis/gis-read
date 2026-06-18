/**
 * three-d-tiles.ts — Shapefile → Cesium 3D Tiles (b3dm white models).
 *
 * TypeScript port of `src/shp_to_3dtiles_dem.py`.
 *
 * Pipeline:
 *   1. Read the .shp (Polygon/PolygonZ/PolygonM) and .dbf (attributes).
 *   2. Optionally sample the ground elevation from a DEM (GeoTIFF/.asc/.hgt).
 *   3. Extrude each polygon footprint upward by the configured building
 *      height and emit per-tile b3dm blobs into `Tiles/{z}/{x}/{y}.b3dm`.
 *   4. Write a `tileset.json` manifest at the output root.
 *
 * Note: input is assumed to be in WGS84 (EPSG:4326). For projected
 * coordinates, pass `--from-crs` and the project will be re-projected
 * through proj4 before tiling.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import proj4 from 'proj4';
import { fromFile } from 'geotiff';
import { parseShapefile } from './shapefile.js';
import { getCRS, transformGeometry } from '../crs.js';
import { log } from '../logger.js';
import type { Feature, Geometry, Properties } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = WGS84_F * (2.0 - WGS84_F);
const WEB_MERCATOR_MAX_LAT = 85.05112878;

const GL_ARRAY_BUFFER = 34962;
const GL_FLOAT = 5126;
const GL_TRIANGLES = 4;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type Vec2 = [number, number];
type Vec3 = [number, number, number];

interface Ring { points: Vec2[]; }

function cleanRing(points: Vec2[]): Vec2[] {
  const eps = 1e-12;
  const out: Vec2[] = [];
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) <= eps && Math.abs(last[1] - y) <= eps) continue;
    out.push([x, y]);
  }
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) <= eps && Math.abs(first[1] - last[1]) <= eps) {
      out.pop();
    }
  }
  return out;
}

function signedArea2D(ring: Vec2[]): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

function ringCentroid(ring: Vec2[]): Vec2 {
  const a = signedArea2D(ring);
  if (Math.abs(a) < 1e-20) {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return [xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length];
  }
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const factor = 1.0 / (6.0 * a);
  return [cx * factor, cy * factor];
}

function featureCentroid(rings: Vec2[][]): Vec2 {
  let weightedX = 0;
  let weightedY = 0;
  let totalArea = 0;
  for (const ring of rings) {
    const a = Math.abs(signedArea2D(ring));
    const [cx, cy] = ringCentroid(ring);
    weightedX += cx * a;
    weightedY += cy * a;
    totalArea += a;
  }
  if (totalArea > 1e-20) return [weightedX / totalArea, weightedY / totalArea];
  // Fallback: simple mean of all vertex coordinates (no .flat() to avoid
  // building a single large array; loops scale linearly).
  let total = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    for (let j = 0; j < ring.length; j++) {
      sumX += ring[j][0];
      sumY += ring[j][1];
      total += 1;
    }
  }
  return total > 0 ? [sumX / total, sumY / total] : [0, 0];
}

function chooseExteriorRings(rings: Ring[], mode: 'auto' | 'cw' | 'ccw' | 'all' = 'auto'): Ring[] {
  const valid = rings.filter((r) => r.points.length >= 3 && Math.abs(signedArea2D(r.points)) > 1e-20);
  if (valid.length === 0) return [];
  if (mode === 'all') return valid;
  if (mode === 'cw') {
    const chosen = valid.filter((r) => signedArea2D(r.points) < 0);
    return chosen.length > 0 ? chosen : [valid.reduce((best, r) => Math.abs(signedArea2D(r.points)) > Math.abs(signedArea2D(best.points)) ? r : best)];
  }
  if (mode === 'ccw') {
    const chosen = valid.filter((r) => signedArea2D(r.points) > 0);
    return chosen.length > 0 ? chosen : [valid.reduce((best, r) => Math.abs(signedArea2D(r.points)) > Math.abs(signedArea2D(best.points)) ? r : best)];
  }
  const pos = valid.filter((r) => signedArea2D(r.points) > 0);
  const neg = valid.filter((r) => signedArea2D(r.points) < 0);
  if (pos.length === 0) return neg;
  if (neg.length === 0) return pos;
  const posArea = pos.reduce((s, r) => s + Math.abs(signedArea2D(r.points)), 0);
  const negArea = neg.reduce((s, r) => s + Math.abs(signedArea2D(r.points)), 0);
  return posArea >= negArea ? pos : neg;
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const eps = 1e-18;
  return cross2(a, b, p) >= -eps && cross2(b, c, p) >= -eps && cross2(c, a, p) >= -eps;
}

/** Simple ear-clipping triangulation for a simple CCW polygon. */
function triangulateEarClip(ring: Vec2[]): Array<[number, number, number]> {
  const n = ring.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const indices = Array.from({ length: n }, (_, i) => i);
  const triangles: Array<[number, number, number]> = [];
  let guard = 0;
  const maxGuard = n * n;
  while (indices.length > 3 && guard < maxGuard) {
    guard += 1;
    let earFound = false;
    const m = indices.length;
    for (let i = 0; i < m; i++) {
      const iPrev = indices[(i - 1 + m) % m];
      const iCurr = indices[i];
      const iNext = indices[(i + 1) % m];
      const a = ring[iPrev];
      const b = ring[iCurr];
      const c = ring[iNext];
      if (cross2(a, b, c) <= 1e-18) continue;
      let hasInside = false;
      for (const idx of indices) {
        if (idx === iPrev || idx === iCurr || idx === iNext) continue;
        if (pointInTriangle(ring[idx], a, b, c)) {
          hasInside = true;
          break;
        }
      }
      if (hasInside) continue;
      triangles.push([iPrev, iCurr, iNext]);
      indices.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break;
  }
  if (indices.length === 3) {
    triangles.push([indices[0], indices[1], indices[2]]);
    return triangles;
  }
  // Fan fallback.
  return Array.from({ length: n - 2 }, (_, i) => [0, i + 1, i + 2] as [number, number, number]);
}

function vSub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vCross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vNormalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len <= 1e-20) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}
function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return vNormalize(vCross(vSub(b, a), vSub(c, a)));
}
/**
 * Cesium / 3D Tiles uses a z-up world; glTF stores geometry in y-up.
 * The Cesium runtime applies a +90° X rotation to convert. To make a
 * glTF `desired` (x, y, z) end up at the requested world position after
 * the rotation, we need to encode `(x, z, -y)`.
 */
function desiredToGltfYUp(v: Vec3): Vec3 { return [v[0], v[2], -v[1]]; }

// ---------------------------------------------------------------------------
// CRS / ECEF
// ---------------------------------------------------------------------------

/** Geodetic lon/lat/height (degrees, meters) → ECEF (meters). */
export function geodeticToEcef(lonDeg: number, latDeg: number, h: number = 0): Vec3 {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const x = (N + h) * cosLat * cosLon;
  const y = (N + h) * cosLat * sinLon;
  const z = (N * (1 - WGS84_E2) + h) * sinLat;
  return [x, y, z];
}

/** Web Mercator tile for a (lon, lat) point. */
function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const clampedLat = Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, lat));
  const n = 2 ** z;
  const x = Math.floor(((lon + 180.0) / 360.0) * n);
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.floor((1.0 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2.0 * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

function clamp(v: number, low: number, high: number): number { return Math.max(low, Math.min(high, v)); }

/** Iterative min over a numeric array. Avoids `Math.min(...arr)` which
 *  throws RangeError on inputs of ~10⁵+ elements. */
function arrayMin(arr: ArrayLike<number>): number {
  let n = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < n) n = v;
  }
  return n;
}

/** Iterative max over a numeric array. */
function arrayMax(arr: ArrayLike<number>): number {
  let n = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > n) n = v;
  }
  return n;
}

/** Iterative min/max in a single pass. Returns [min, max]. */
function arrayMinMax(arr: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Push every numeric value from an iterable of [a, b] pairs into a typed array. */
function collectPairs(outer: ArrayLike<Vec2[]>, channel: 0 | 1): Float64Array {
  let total = 0;
  for (let i = 0; i < outer.length; i++) total += outer[i].length;
  const out = new Float64Array(total);
  let p = 0;
  for (let i = 0; i < outer.length; i++) {
    const ring = outer[i];
    for (let j = 0; j < ring.length; j++) out[p++] = ring[j][channel];
  }
  return out;
}

// ---------------------------------------------------------------------------
// DEM sampling (optional)
// ---------------------------------------------------------------------------

interface DemSampler {
  sampleLonLat(lon: number, lat: number): number | null;
}

interface AsciiDem {
  values: Float64Array;
  ncols: number;
  nrows: number;
  xFirst: number;
  yTop: number;
  cell: number;
  nodata: number;
}

function isValidDemValue(v: number, nodata: number): boolean {
  if (!Number.isFinite(v)) return false;
  if (Math.abs(v - nodata) <= 1e-6) return false;
  return true;
}

class GeoTiffDem implements DemSampler {
  private values: Float64Array;
  private ncols: number;
  private nrows: number;
  private west: number;
  private north: number;
  private dx: number;
  private dy: number;
  private nodata: number;
  constructor(t: { values: Float64Array; ncols: number; nrows: number; west: number; north: number; dx: number; dy: number; nodata: number }) {
    this.values = t.values; this.ncols = t.ncols; this.nrows = t.nrows;
    this.west = t.west; this.north = t.north; this.dx = t.dx; this.dy = t.dy; this.nodata = t.nodata;
  }
  private valueAt(r: number, c: number): number | null {
    if (r < 0 || r >= this.nrows || c < 0 || c >= this.ncols) return null;
    const v = this.values[r * this.ncols + c];
    return isValidDemValue(v, this.nodata) ? v : null;
  }
  sampleLonLat(lon: number, lat: number): number | null {
    const colF = (lon - this.west) / this.dx;
    const rowF = (this.north - lat) / this.dy;
    if (colF < -1e-9 || rowF < -1e-9 || colF > this.ncols - 1 + 1e-9 || rowF > this.nrows - 1 + 1e-9) return null;
    const c0 = clamp(Math.floor(colF), 0, this.ncols - 1);
    const r0 = clamp(Math.floor(rowF), 0, this.nrows - 1);
    const c1 = Math.min(this.ncols - 1, c0 + 1);
    const r1 = Math.min(this.nrows - 1, r0 + 1);
    const dx = clamp(colF - c0, 0, 1);
    const dy = clamp(rowF - r0, 0, 1);
    const candidates: Array<[number, number]> = [];
    const v00 = this.valueAt(r0, c0); if (v00 !== null) candidates.push([v00, (1 - dx) * (1 - dy)]);
    const v10 = this.valueAt(r0, c1); if (v10 !== null) candidates.push([v10, dx * (1 - dy)]);
    const v01 = this.valueAt(r1, c0); if (v01 !== null) candidates.push([v01, (1 - dx) * dy]);
    const v11 = this.valueAt(r1, c1); if (v11 !== null) candidates.push([v11, dx * dy]);
    const valid = candidates.filter(([, w]) => w > 0);
    if (valid.length > 0) {
      const wSum = valid.reduce((s, [, w]) => s + w, 0);
      if (wSum > 0) return valid.reduce((s, [v, w]) => s + v * w, 0) / wSum;
    }
    return null;
  }
}

async function loadGeoTiffDem(filePath: string): Promise<GeoTiffDem> {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const bbox = image.getBoundingBox() as [number, number, number, number];
  const nodata = (image.getGDALNoData() ?? -9999) as number;
  const rasters = await image.readRasters();
  const band0 = rasters[0];
  const values: Float64Array = band0 instanceof Float64Array
    ? band0
    : Float64Array.from(band0 as ArrayLike<number>);
  const nrows = image.getHeight();
  const ncols = image.getWidth();
  const dx = (bbox[2] - bbox[0]) / ncols;
  const dy = (bbox[3] - bbox[1]) / nrows;
  return new GeoTiffDem({ values, ncols, nrows, west: bbox[0], north: bbox[3], dx, dy, nodata });
}

function loadAsciiDem(filePath: string): AsciiDem {
  const text = fs.readFileSync(filePath, 'utf8');
  const meta: Record<string, number> = {};
  let i = 0;
  const lines = text.split(/\r?\n/);
  for (; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length >= 2 && ['ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter', 'cellsize', 'nodata_value'].includes(parts[0].toLowerCase())) {
      meta[parts[0].toLowerCase()] = Number(parts[1]);
    } else if (parts.length > 0) {
      break;
    }
  }
  const ncols = Math.round(meta.ncols);
  const nrows = Math.round(meta.nrows);
  const cell = meta.cellsize;
  let xFirst: number;
  let yFirst: number;
  if ('xllcenter' in meta) xFirst = meta.xllcenter;
  else xFirst = meta.xllcorner + cell * 0.5;
  if ('yllcenter' in meta) yFirst = meta.yllcenter;
  else yFirst = meta.yllcorner + cell * 0.5;
  const yTop = yFirst + (nrows - 1) * cell;
  const nodata = meta.nodata_value ?? -9999;
  const values: number[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    for (const tok of line.split(/\s+/)) values.push(Number(tok));
  }
  if (values.length !== ncols * nrows) {
    throw new Error(`ASCII DEM size mismatch: ${values.length} values for ${ncols}x${nrows} grid`);
  }
  return { values: Float64Array.from(values), ncols, nrows, xFirst, yTop, cell, nodata };
}

class AsciiDemSampler extends GeoTiffDem {
  constructor(a: AsciiDem) {
    super({ values: a.values, ncols: a.ncols, nrows: a.nrows, west: a.xFirst, north: a.yTop, dx: a.cell, dy: a.cell, nodata: a.nodata });
  }
}

async function loadDemSampler(demPath: string | undefined): Promise<DemSampler | null> {
  if (!demPath) return null;
  if (!fs.existsSync(demPath)) throw new Error(`DEM file not found: ${demPath}`);
  const ext = path.extname(demPath).toLowerCase();
  if (ext === '.tif' || ext === '.tiff') return await loadGeoTiffDem(demPath);
  if (ext === '.asc' || ext === '.grd' || ext === '.txt') return new AsciiDemSampler(loadAsciiDem(demPath));
  // Try GeoTIFF as a last resort.
  return await loadGeoTiffDem(demPath);
}

// ---------------------------------------------------------------------------
// Feature model
// ---------------------------------------------------------------------------

interface BuildingFeature {
  rings: Vec2[][]; // exterior rings in WGS84 lon/lat
  height: number;  // absolute top elevation
  baseHeight: number;
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
  buildingHeight: number;
  absoluteTopHeight: number | null;
  vertexBaseHeights: number[][] | null;
}

interface TileBucket {
  z: number;
  x: number;
  y: number;
  features: BuildingFeature[];
  west: number;
  south: number;
  east: number;
  north: number;
  minH: number;
  maxH: number;
  addFeature(f: BuildingFeature): void;
}

function createTileBucket(z: number, x: number, y: number): TileBucket {
  const bucket: TileBucket = {
    z, x, y,
    features: [],
    west: 180, south: 90, east: -180, north: -90,
    minH: Infinity, maxH: -Infinity,
    addFeature(f: BuildingFeature) {
      this.features.push(f);
      this.west = Math.min(this.west, f.lonMin);
      this.south = Math.min(this.south, f.latMin);
      this.east = Math.max(this.east, f.lonMax);
      this.north = Math.max(this.north, f.latMax);
      this.minH = Math.min(this.minH, f.baseHeight);
      this.maxH = Math.max(this.maxH, f.height);
    },
  };
  return bucket;
}

// ---------------------------------------------------------------------------
// glTF / B3DM encoding
// ---------------------------------------------------------------------------

function makeGlb(positions: Vec3[], normals: Vec3[], color: [number, number, number, number]): Buffer {
  if (positions.length !== normals.length) throw new Error('positions/normals length mismatch');
  if (positions.length === 0) throw new Error('empty geometry, cannot build glb');

  const posYUp = positions.map(desiredToGltfYUp);
  const normYUp = normals.map(desiredToGltfYUp);

  // Bounding box: walk once per axis to avoid `Math.min(...arr)` which
  // throws RangeError on large position arrays.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posYUp.length; i++) {
    const p = posYUp[i];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const posMin: Vec3 = [minX, minY, minZ];
  const posMax: Vec3 = [maxX, maxY, maxZ];

  const posBytes = Buffer.alloc(posYUp.length * 12);
  for (let i = 0; i < posYUp.length; i++) {
    posBytes.writeFloatLE(posYUp[i][0], i * 12);
    posBytes.writeFloatLE(posYUp[i][1], i * 12 + 4);
    posBytes.writeFloatLE(posYUp[i][2], i * 12 + 8);
  }
  const posPad = padLength(posBytes.length, 4);
  const normOffset = posBytes.length + posPad;
  const normBytes = Buffer.alloc(normYUp.length * 12);
  for (let i = 0; i < normYUp.length; i++) {
    normBytes.writeFloatLE(normYUp[i][0], i * 12);
    normBytes.writeFloatLE(normYUp[i][1], i * 12 + 4);
    normBytes.writeFloatLE(normYUp[i][2], i * 12 + 8);
  }
  const binBlob = Buffer.concat([posBytes, Buffer.alloc(posPad), normBytes]);
  const binPad = padLength(binBlob.length, 4);
  const binBlobPadded = binPad > 0 ? Buffer.concat([binBlob, Buffer.alloc(binPad)]) : binBlob;

  const gltf = {
    asset: { version: '2.0', generator: 'gis-read 3dtiles' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        material: 0,
        mode: GL_TRIANGLES,
      }],
    }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [
          Math.round(color[0] * 1e6) / 1e6,
          Math.round(color[1] * 1e6) / 1e6,
          Math.round(color[2] * 1e6) / 1e6,
          Math.round(color[3] * 1e6) / 1e6,
        ],
        metallicFactor: 0.0,
        roughnessFactor: 1.0,
      },
      doubleSided: false,
    }],
    buffers: [{ byteLength: binBlobPadded.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, byteStride: 12, target: GL_ARRAY_BUFFER },
      { buffer: 0, byteOffset: normOffset, byteLength: normBytes.length, byteStride: 12, target: GL_ARRAY_BUFFER },
    ],
    accessors: [
      {
        bufferView: 0, componentType: GL_FLOAT, count: posYUp.length, type: 'VEC3',
        min: posMin.map((v) => Math.round(v * 1e6) / 1e6),
        max: posMax.map((v) => Math.round(v * 1e6) / 1e6),
      },
      {
        bufferView: 1, componentType: GL_FLOAT, count: normYUp.length, type: 'VEC3',
      },
    ],
  };

  const jsonStr = JSON.stringify(gltf);
  let jsonBytes = Buffer.from(jsonStr, 'utf8');
  const jsonPad = padLength(jsonBytes.length, 4);
  if (jsonPad > 0) jsonBytes = Buffer.concat([jsonBytes, Buffer.from(' '.repeat(jsonPad), 'utf8')]);

  const totalLen = 12 + 8 + jsonBytes.length + 8 + binBlobPadded.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLen, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBlobPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBlobPadded]);
}

function padLength(n: number, alignment: number): number {
  const r = n % alignment;
  return r === 0 ? 0 : alignment - r;
}

function makeB3dm(glb: Buffer, rtcCenter: Vec3): Buffer {
  const ft = { BATCH_LENGTH: 0, RTC_CENTER: rtcCenter.map((v) => Math.round(v * 1e6) / 1e6) };
  let ftJson = Buffer.from(JSON.stringify(ft), 'utf8');
  const ftPad = padLength(28 + ftJson.length, 8);
  if (ftPad > 0) ftJson = Buffer.concat([ftJson, Buffer.from(' '.repeat(ftPad), 'utf8')]);

  const batchJson = Buffer.alloc(0);
  const batchBin = Buffer.alloc(0);
  const ftBin = Buffer.alloc(0);

  const inner = buildB3dmBlob(ftJson, ftBin, batchJson, batchBin, glb);
  const endPad = padLength(inner.length, 8);
  if (endPad === 0) return inner;
  return buildB3dmBlob(ftJson, ftBin, batchJson, batchBin, Buffer.concat([glb, Buffer.alloc(endPad)]));
}

function buildB3dmBlob(ftJson: Buffer, ftBin: Buffer, batchJson: Buffer, batchBin: Buffer, glb: Buffer): Buffer {
  const byteLength = 28 + ftJson.length + ftBin.length + batchJson.length + batchBin.length + glb.length;
  const header = Buffer.alloc(28);
  header.write('b3dm', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(byteLength, 8);
  header.writeUInt32LE(ftJson.length, 12);
  header.writeUInt32LE(ftBin.length, 16);
  header.writeUInt32LE(batchJson.length, 20);
  header.writeUInt32LE(batchBin.length, 24);
  return Buffer.concat([header, ftJson, ftBin, batchJson, batchBin, glb]);
}

function regionRadians(west: number, south: number, east: number, north: number, minH: number, maxH: number): number[] {
  let e = east;
  let w = west;
  let n = north;
  let s = south;
  let maxHeight = maxH;
  if (Math.abs(e - w) < 1e-12) { e += 1e-9; w -= 1e-9; }
  if (Math.abs(n - s) < 1e-12) { n += 1e-9; s -= 1e-9; }
  if (maxHeight <= minH) maxHeight = minH + 1.0;
  return [(w * Math.PI) / 180, (s * Math.PI) / 180, (e * Math.PI) / 180, (n * Math.PI) / 180, minH, maxHeight];
}

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

function parseColor(value: string): [number, number, number, number] {
  let s = value.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  if (s.length !== 6 && s.length !== 8) {
    throw new Error('Color must be #RGB, #RRGGBB or #RRGGBBAA.');
  }
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1.0;
  return [r, g, b, a];
}

// ---------------------------------------------------------------------------
// Height field lookup
// ---------------------------------------------------------------------------

function getHeight(attrs: Properties, fieldLower: string | null | undefined, fallback: number): number {
  if (!fieldLower) return fallback;
  for (const k of Object.keys(attrs)) {
    if (k.toLowerCase() === fieldLower) {
      const v = attrs[k];
      if (v === null || v === undefined || v === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }
  }
  return fallback;
}

function clampRings(rings: Vec2[][]): Vec2[][] {
  return rings
    .map((r) => cleanRing(r.map(([x, y]) => [clamp(x, -180, 180), clamp(y, -89.999999, 89.999999)] as Vec2)))
    .filter((r) => r.length >= 3 && Math.abs(signedArea2D(r)) > 1e-20);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ThreeDTilesOptions {
  outputPath: string;
  /** Web Mercator tile LOD. 0–22, default 12. */
  lod?: number;
  /** Limit number of polygons processed (debug). */
  limit?: number;
  /** Building tint (#RGB / #RRGGBB / #RRGGBBAA). */
  color?: string;
  /** DBF field with per-feature height. */
  heightField?: string;
  /** DBF field with per-feature base height. */
  baseHeightField?: string;
  /** Default building height (m). */
  defaultHeight?: number;
  /** Default base height / ground offset (m). */
  baseHeight?: number;
  /** Optional DEM path for ground elevation sampling. */
  dem?: string;
  /** DEM CRS override (defaults to "EPSG:4326"). */
  demCrs?: string;
  /** Vertical offset added to sampled DEM height. */
  demOffset?: number;
  /** Default elevation when DEM is missing / out of range. */
  demDefaultHeight?: number;
  /** How to fold vertex DEM samples into a single base elevation. */
  demSample?: 'vertices' | 'centroid' | 'minimum' | 'average';
  /** Force the height field to be a relative building height. */
  heightIsRelative?: boolean;
  /** Force the height field to be an absolute top elevation. */
  heightAbsolute?: boolean;
  /** Clamp relative building height to a minimum. */
  minHeight?: number;
  /** Clamp relative building height to a maximum. */
  maxHeight?: number;
  /** Source CRS id (defaults to EPSG:4326). */
  inputCrs?: string;
  /** Outer-ring orientation hint. */
  outerOrientation?: 'auto' | 'cw' | 'ccw' | 'all';
  /** Tileset root geometricError. */
  rootGeometricError?: number;
  /** Overwrite an existing output directory. */
  overwrite?: boolean;
  /** Pretty-print tileset.json. */
  prettyJson?: boolean;
}

export interface ThreeDTilesSummary {
  outputPath: string;
  features: number;
  shapesRead: number;
  skipped: number;
  tiles: number;
  lod: number;
  dem?: string;
  heightMode: 'relative' | 'absolute';
}

function buildFeatureBaseHeights(
  ringsLL: Vec2[][],
  lonC: number,
  latC: number,
  baseOffset: number,
  dem: DemSampler | null,
  sampleMode: 'vertices' | 'centroid' | 'minimum' | 'average',
  demDefaultHeight: number,
): { minBase: number; maxBase: number; vertexBaseHeights: number[][] | null } {
  if (dem === null) {
    return { minBase: baseOffset, maxBase: baseOffset, vertexBaseHeights: null };
  }
  const sample = (lon: number, lat: number): number => {
    const v = dem.sampleLonLat(lon, lat);
    return v === null ? demDefaultHeight : v;
  };
  const vertexGround: number[][] = ringsLL.map((r) => r.map(([lon, lat]) => sample(lon, lat)));
  // Single-pass min/max/sum across the 2-D vertex array — avoids
  // `flat()` + `Math.min(...arr)` which throws RangeError on huge inputs.
  let totalSamples = 0;
  let minG = Infinity;
  let maxG = -Infinity;
  let sumG = 0;
  for (let i = 0; i < vertexGround.length; i++) {
    const ring = vertexGround[i];
    for (let j = 0; j < ring.length; j++) {
      const v = ring[j];
      totalSamples += 1;
      if (v < minG) minG = v;
      if (v > maxG) maxG = v;
      sumG += v;
    }
  }
  if (totalSamples === 0) {
    const g = sample(lonC, latC);
    return { minBase: g + baseOffset, maxBase: g + baseOffset, vertexBaseHeights: null };
  }
  if (sampleMode === 'vertices') {
    // Add baseOffset to every sampled elevation in place (no second
    // allocation, no extra pass to recompute min/max).
    const vertexBase: number[][] = new Array(vertexGround.length);
    for (let i = 0; i < vertexGround.length; i++) {
      const ring = vertexGround[i];
      const adjusted = new Array<number>(ring.length);
      for (let j = 0; j < ring.length; j++) adjusted[j] = ring[j] + baseOffset;
      vertexBase[i] = adjusted;
    }
    return { minBase: minG + baseOffset, maxBase: maxG + baseOffset, vertexBaseHeights: vertexBase };
  }
  let g: number;
  if (sampleMode === 'minimum') g = minG;
  else if (sampleMode === 'average') g = sumG / totalSamples;
  else g = sample(lonC, latC);
  return { minBase: g + baseOffset, maxBase: g + baseOffset, vertexBaseHeights: null };
}

function buildTileMesh(tile: TileBucket, rtcCenter: Vec3): { positions: Vec3[]; normals: Vec3[] } {
  const positions: Vec3[] = [];
  const normals: Vec3[] = [];

  const localEcef = (lon: number, lat: number, h: number): Vec3 => {
    const e = geodeticToEcef(lon, lat, h);
    return [e[0] - rtcCenter[0], e[1] - rtcCenter[1], e[2] - rtcCenter[2]];
  };
  const addTri = (a: Vec3, b: Vec3, c: Vec3) => {
    const n = triangleNormal(a, b, c);
    positions.push(a, b, c);
    normals.push(n, n, n);
  };

  for (const feature of tile.features) {
    for (let ringIndex = 0; ringIndex < feature.rings.length; ringIndex++) {
      const ring = feature.rings[ringIndex];
      if (ring.length < 3 || Math.abs(signedArea2D(ring)) <= 1e-20) continue;
      let vertexBases: number[] | null = null;
      if (feature.vertexBaseHeights && ringIndex < feature.vertexBaseHeights.length) {
        const candidate = feature.vertexBaseHeights[ringIndex];
        if (candidate.length === ring.length) vertexBases = [...candidate];
      }
      let ringCcw: Vec2[];
      if (signedArea2D(ring) < 0) {
        ringCcw = [...ring].reverse();
        if (vertexBases) vertexBases = [...vertexBases].reverse();
      } else {
        ringCcw = [...ring];
      }
      const tris = triangulateEarClip(ringCcw);
      if (tris.length === 0) continue;
      const baseHeights = vertexBases ?? ringCcw.map(() => feature.baseHeight);
      let topHeights: number[];
      if (feature.absoluteTopHeight === null) {
        topHeights = baseHeights.map((bh) => bh + feature.buildingHeight);
      } else {
        topHeights = baseHeights.map(() => feature.absoluteTopHeight!);
      }
      for (let i = 0; i < topHeights.length; i++) {
        if (topHeights[i] < baseHeights[i] + 0.01) topHeights[i] = baseHeights[i] + 0.01;
      }
      const bottom = ringCcw.map(([lon, lat], i) => localEcef(lon, lat, baseHeights[i]));
      const top = ringCcw.map(([lon, lat], i) => localEcef(lon, lat, topHeights[i]));
      for (const [i, j, k] of tris) addTri(top[i], top[j], top[k]);
      for (const [i, j, k] of tris) addTri(bottom[k], bottom[j], bottom[i]);
      const n = ringCcw.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        addTri(bottom[i], bottom[j], top[j]);
        addTri(bottom[i], top[j], top[i]);
      }
    }
  }
  return { positions, normals };
}

function extractRingsFromGeometry(geom: Geometry | null): Ring[] {
  if (!geom) return [];
  if (geom.type === 'Polygon') {
    return geom.coordinates.map((r: Vec2[]) => ({ points: r }));
  }
  if (geom.type === 'MultiPolygon') {
    const out: Ring[] = [];
    for (const poly of geom.coordinates) {
      for (const r of poly) out.push({ points: r as Vec2[] });
    }
    return out;
  }
  return [];
}

export async function writeThreeDTiles(shpPath: string, opts: ThreeDTilesOptions): Promise<ThreeDTilesSummary> {
  const lod = opts.lod ?? 12;
  const limit = opts.limit;
  const color = parseColor(opts.color ?? '#cccccc');
  const defaultHeight = opts.defaultHeight ?? 10.0;
  const baseHeight = opts.baseHeight ?? 0.0;
  const demSampler = await loadDemSampler(opts.dem);
  const demDefaultHeight = opts.demDefaultHeight ?? 0.0;
  const demSample = opts.demSample ?? 'vertices';
  const outerOrientation = opts.outerOrientation ?? 'auto';
  const heightIsRelative = opts.heightIsRelative ?? (demSampler !== null && !opts.heightAbsolute);
  const rootGeometricError = opts.rootGeometricError ?? 500.0;
  const inputCrs = opts.inputCrs ?? 'EPSG:4326';
  const prettyJson = opts.prettyJson ?? true;

  if (!fs.existsSync(shpPath)) throw new Error(`Shapefile not found: ${shpPath}`);
  if (path.extname(shpPath).toLowerCase() !== '.shp') {
    throw new Error('Input file must be a .shp file (companion .dbf is loaded automatically).');
  }

  // Prepare output directory.
  if (fs.existsSync(opts.outputPath) && fs.statSync(opts.outputPath).isDirectory()) {
    const entries = fs.readdirSync(opts.outputPath);
    if (entries.length > 0 && !opts.overwrite) {
      throw new Error(`Output directory is not empty: ${opts.outputPath}. Pass --overwrite to clear it.`);
    }
    if (opts.overwrite) {
      fs.rmSync(opts.outputPath, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(opts.outputPath, { recursive: true });
  const tilesRoot = path.join(opts.outputPath, 'Tiles');
  fs.mkdirSync(tilesRoot, { recursive: true });

  // Read source CRS for reprojection.
  if (inputCrs.toUpperCase() !== 'EPSG:4326') {
    try { getCRS(inputCrs); } catch { /* proj4 lookup will happen later */ }
  }

  // Read shapefile via the existing parser to reuse SHP+DBF handling.
  const parsed = parseShapefile(shpPath, { limit });
  const features: Feature[] = parsed.features;

  const heightField = opts.heightField ? opts.heightField.toLowerCase() : null;
  const baseHeightField = opts.baseHeightField ? opts.baseHeightField.toLowerCase() : null;

  const buckets = new Map<string, TileBucket>();
  let totalShapes = 0;
  let totalFeatures = 0;
  let skipped = 0;

  // Cached proj4 transformer for source → WGS84.
  const sourceToWgs84 = (inputCrs.toUpperCase() === 'EPSG:4326')
    ? null
    : proj4(inputCrs, 'EPSG:4326');

  for (const feature of features) {
    totalShapes += 1;
    const props: Properties = feature.properties ?? {};
    const rawRings = extractRingsFromGeometry(feature.geometry as Geometry);
    if (rawRings.length === 0) { skipped += 1; continue; }
    const exterior = chooseExteriorRings(rawRings, outerOrientation);
    if (exterior.length === 0) { skipped += 1; continue; }

    const llRings: Vec2[][] = [];
    for (const ring of exterior) {
      let pts = ring.points;
      if (sourceToWgs84) {
        pts = pts.map(([x, y]): Vec2 => {
          const out = sourceToWgs84.forward([x, y]);
          return [out[0], out[1]];
        });
      } else {
        // Still apply transformGeometry in case the user has registered a custom CRS.
        if (inputCrs.toUpperCase() !== 'EPSG:4326') {
          const transformed = transformGeometry({ type: 'LineString', coordinates: pts }, inputCrs, 'EPSG:4326');
          if (transformed && transformed.coordinates) {
            pts = (transformed.coordinates as Vec2[]).map((p) => [p[0], p[1]]);
          }
        }
      }
      pts = cleanRing(pts);
      const cleaned = pts
        .map(([x, y]) => [clamp(x, -180, 180), clamp(y, -89.999999, 89.999999)] as Vec2)
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (cleaned.length >= 3 && Math.abs(signedArea2D(cleaned)) > 1e-20) {
        llRings.push(cleaned);
      }
    }
    if (llRings.length === 0) { skipped += 1; continue; }

    // Single-pass lon/lat bounds — avoids `flat()` + spread that throws
    // RangeError on polygons with tens of thousands of vertices.
    let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
    for (let i = 0; i < llRings.length; i++) {
      const ring = llRings[i];
      for (let j = 0; j < ring.length; j++) {
        const p = ring[j];
        if (p[0] < lonMin) lonMin = p[0];
        if (p[0] > lonMax) lonMax = p[0];
        if (p[1] < latMin) latMin = p[1];
        if (p[1] > latMax) latMax = p[1];
      }
    }

    const [lonC, latC] = featureCentroid(llRings);

    let rawHeight = getHeight(props, heightField, defaultHeight);
    let baseOffsetVal = baseHeightField ? getHeight(props, baseHeightField, baseHeight) : baseHeight;
    if (!Number.isFinite(rawHeight)) rawHeight = defaultHeight;
    if (!Number.isFinite(baseOffsetVal)) baseOffsetVal = 0.0;

    const { minBase, maxBase, vertexBaseHeights } = buildFeatureBaseHeights(
      llRings, lonC, latC, baseOffsetVal, demSampler, demSample, demDefaultHeight,
    );

    let absoluteTopHeight: number | null = null;
    let buildingH: number;
    if (heightIsRelative) {
      buildingH = Math.max(rawHeight, 0);
    } else {
      absoluteTopHeight = rawHeight;
      buildingH = absoluteTopHeight - minBase;
    }
    if (buildingH <= 0.01) {
      buildingH = Math.max(defaultHeight, 1.0);
      absoluteTopHeight = null;
    }
    if (opts.minHeight !== undefined && buildingH < opts.minHeight) {
      buildingH = opts.minHeight;
      absoluteTopHeight = heightIsRelative ? null : minBase + buildingH;
    }
    if (opts.maxHeight !== undefined && buildingH > opts.maxHeight) {
      buildingH = opts.maxHeight;
      absoluteTopHeight = heightIsRelative ? null : minBase + buildingH;
    }
    const topH = absoluteTopHeight === null
      ? maxBase + buildingH
      : Math.max(absoluteTopHeight, maxBase + 0.01);

    const [tx, ty] = lonLatToTile(lonC, latC, lod);
    const key = `${lod},${tx},${ty}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createTileBucket(lod, tx, ty);
      buckets.set(key, bucket);
    }

    bucket.addFeature({
      rings: llRings,
      height: topH,
      baseHeight: minBase,
      lonMin, latMin, lonMax, latMax,
      buildingHeight: buildingH,
      absoluteTopHeight,
      vertexBaseHeights,
    });
    totalFeatures += 1;
  }

  if (buckets.size === 0) {
    throw new Error('No tiles generated. Check the SHP geometry, CRS, height field, or --limit.');
  }

  const children: any[] = [];
  let rootWest = 180, rootSouth = 90, rootEast = -180, rootNorth = -90;
  let rootMinH = Infinity, rootMaxH = -Infinity;

  for (const key of Array.from(buckets.keys()).sort()) {
    const tile = buckets.get(key)!;
    const rtcCenter = geodeticToEcef(
      (tile.west + tile.east) / 2,
      (tile.south + tile.north) / 2,
      (tile.minH + tile.maxH) / 2,
    );

    const { positions, normals } = buildTileMesh(tile, rtcCenter);
    if (positions.length === 0) continue;

    const glb = makeGlb(positions, normals, color);
    const b3dm = makeB3dm(glb, rtcCenter);

    const tileDir = path.join(tilesRoot, String(tile.z), String(tile.x));
    fs.mkdirSync(tileDir, { recursive: true });
    fs.writeFileSync(path.join(tileDir, `${tile.y}.b3dm`), b3dm);

    const relUri = `Tiles/${tile.z}/${tile.x}/${tile.y}.b3dm`;
    const region = regionRadians(tile.west, tile.south, tile.east, tile.north, tile.minH, tile.maxH);
    children.push({
      boundingVolume: { region },
      geometricError: 0,
      content: { uri: relUri },
    });

    rootWest = Math.min(rootWest, tile.west);
    rootSouth = Math.min(rootSouth, tile.south);
    rootEast = Math.max(rootEast, tile.east);
    rootNorth = Math.max(rootNorth, tile.north);
    rootMinH = Math.min(rootMinH, tile.minH);
    rootMaxH = Math.max(rootMaxH, tile.maxH);
  }

  if (children.length === 0) {
    throw new Error('Tile groups were created but all geometry was empty; no b3dm was written.');
  }

  const tileset = {
    asset: { version: '1.0', tilesetVersion: '1.0' },
    geometricError: rootGeometricError,
    root: {
      boundingVolume: { region: regionRadians(rootWest, rootSouth, rootEast, rootNorth, rootMinH, rootMaxH) },
      geometricError: rootGeometricError,
      refine: 'ADD',
      children,
    },
  };

  fs.writeFileSync(
    path.join(opts.outputPath, 'tileset.json'),
    JSON.stringify(tileset, null, prettyJson ? 2 : 0),
    'utf8',
  );

  log.info(`Done.`);
  log.info(`  input shp        : ${path.resolve(shpPath)}`);
  log.info(`  output           : ${path.resolve(opts.outputPath)}`);
  log.info(`  features written : ${totalFeatures}`);
  log.info(`  skipped          : ${skipped}`);
  log.info(`  tiles            : ${children.length}`);
  log.info(`  lod              : ${lod}`);
  if (opts.dem) {
    log.info(`  dem              : ${path.resolve(opts.dem)}`);
    log.info(`  dem sample       : ${demSample}`);
    log.info(`  height mode      : ${heightIsRelative ? 'relative' : 'absolute'}`);
  }

  return {
    outputPath: path.resolve(opts.outputPath),
    features: totalFeatures,
    shapesRead: totalShapes,
    skipped,
    tiles: children.length,
    lod,
    dem: opts.dem ? path.resolve(opts.dem) : undefined,
    heightMode: heightIsRelative ? 'relative' : 'absolute',
  };
}
