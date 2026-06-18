/**
 * terrain-cesium.ts — DEM GeoTIFF → Cesium quantized-mesh-1.0 terrain tiles.
 *
 * TypeScript port of `src/dem_to_terrain.py`.
 *
 * Output structure:
 *   output_dir/
 *   ├── layer.json
 *   └── {z}/{x}/{y}.terrain   (gzip compressed)
 *
 * Reuses the project's existing `geotiff` reader and `proj4` for the rare
 * case that a source DEM is in a non-WGS84 CRS. The on-disk tile format
 * matches the Cesium GeographicTilingScheme + quantized-mesh-1.0 spec.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import proj4 from 'proj4';
import { fromFile } from 'geotiff';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Quantized-mesh vertex coordinate range. */
const MAX_Q = 32767;

/** WGS84 ellipsoid parameters (meters). */
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

/** Fallback elevation used in place of nodata / out-of-range values. */
const NODATA_FILL = 0.0;

/** Out-of-range elevations are treated as nodata. */
const MIN_VALID_ELEVATION = -500;
const MAX_VALID_ELEVATION = 9000;

// ---------------------------------------------------------------------------
// Coordinate transforms
// ---------------------------------------------------------------------------

/** Geodetic lon/lat/height (degrees, meters) → ECEF (meters). */
export function llhToEcef(lonDeg: number, latDeg: number, h: number = 0.0): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const x = (N + h) * cosLat * Math.cos(lon);
  const y = (N + h) * cosLat * Math.sin(lon);
  const z = (N * (1 - WGS84_E2) + h) * sinLat;
  return [x, y, z];
}

/**
 * Conservative bounding sphere from the eight corners of a tile bbox,
 * sampled at min/max elevations.
 */
function computeBoundingSphere(
  west: number, south: number, east: number, north: number, minH: number, maxH: number,
): { center: [number, number, number]; radius: number } {
  const corners: Array<[number, number, number]> = [
    [west, south, minH], [east, south, minH],
    [west, north, minH], [east, north, minH],
    [west, south, maxH], [east, south, maxH],
    [west, north, maxH], [east, north, maxH],
  ];
  const ecefCorners = corners.map((c) => llhToEcef(c[0], c[1], c[2]));
  const center: [number, number, number] = [
    ecefCorners.reduce((s, c) => s + c[0], 0) / ecefCorners.length,
    ecefCorners.reduce((s, c) => s + c[1], 0) / ecefCorners.length,
    ecefCorners.reduce((s, c) => s + c[2], 0) / ecefCorners.length,
  ];
  let radius = 0;
  for (const c of ecefCorners) {
    const dx = c[0] - center[0];
    const dy = c[1] - center[1];
    const dz = c[2] - center[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > radius) radius = d;
  }
  return { center, radius };
}

/**
 * Horizon occlusion point: tile center at max elevation, scaled slightly
 * outward so the renderer can still cull occluded geometry.
 */
function computeHorizonOcclusion(
  west: number, south: number, east: number, north: number, maxH: number,
): [number, number, number] {
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const [x, y, z] = llhToEcef(cx, cy, maxH);
  const scale = 1.01;
  return [x * scale, y * scale, z * scale];
}

// ---------------------------------------------------------------------------
// Geographic tiling scheme
// ---------------------------------------------------------------------------

/** Returns the geographic bbox of a (z,x,y) tile in the Cesium scheme. */
export function tileBBox(z: number, x: number, y: number): [number, number, number, number] {
  const nCols = 2 << z; // 2 * 2^z
  const nRows = 1 << z; // 2^z
  const tileW = 360.0 / nCols;
  const tileH = 180.0 / nRows;
  const west = -180.0 + x * tileW;
  const south = -90.0 + y * tileH;
  const east = west + tileW;
  const north = south + tileH;
  return [west, south, east, north];
}

/** Yields (x, y) tile indices intersecting the given lon/lat bbox. */
function* tilesForLevel(
  z: number, demWest: number, demSouth: number, demEast: number, demNorth: number,
): Generator<[number, number]> {
  const nCols = 2 << z;
  const nRows = 1 << z;
  const tileW = 360.0 / nCols;
  const tileH = 180.0 / nRows;
  const xMin = Math.max(0, Math.floor((demWest + 180.0) / tileW));
  const xMax = Math.min(nCols - 1, Math.floor((demEast + 180.0 - 1e-9) / tileW));
  const yMin = Math.max(0, Math.floor((demSouth + 90.0) / tileH));
  const yMax = Math.min(nRows - 1, Math.floor((demNorth + 90.0 - 1e-9) / tileH));
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      yield [x, y];
    }
  }
}

// ---------------------------------------------------------------------------
// DEM sampling
// ---------------------------------------------------------------------------

/** Raw DEM pixel grid in WGS84 with optional reprojection metadata. */
interface DemGrid {
  data: Float64Array; // row-major, [row * width + col]
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
  nodata: number;
}

/**
 * Loads a GeoTIFF DEM. If the source CRS is not WGS84 the pixels are
 * reprojected on the fly using proj4 (no GDAL dependency).
 */
async function loadDemWgs84(tifPath: string): Promise<DemGrid> {
  const tiff = await fromFile(tifPath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox() as [number, number, number, number];
  const nodata = (image.getGDALNoData() ?? -9999) as number;

  // Determine source CRS: prefer GeoTIFF geographic/projected codes, else WGS84.
  const geoKeys = image.getGeoKeys();
  const srcEpsg = geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey ?? 4326;

  const srcWest = bbox[0];
  const srcSouth = bbox[1];
  const srcEast = bbox[2];
  const srcNorth = bbox[3];

  const rasters = await image.readRasters();
  const band0 = rasters[0];
  // Materialize into a Float64Array for safe math.
  const srcFlat: Float64Array = band0 instanceof Float64Array
    ? band0
    : Float64Array.from(band0 as ArrayLike<number>);

  if (srcEpsg === 4326) {
    return {
      data: srcFlat,
      width, height,
      west: srcWest, south: srcSouth, east: srcEast, north: srcNorth,
      nodata,
    };
  }

  // Reproject every pixel center to WGS84 and resample back onto a regular
  // WGS84 grid. For simplicity we use the same shape, snapped to a 0.001°
  // grid by default. This is the lightweight equivalent of rasterio's
  // `calculate_default_transform` + `reproject`.
  log.info(`[DEM] CRS: EPSG:${srcEpsg}, reprojecting to EPSG:4326`);
  const srcProj = `EPSG:${srcEpsg}`;
  const dstProj = 'EPSG:4326';
  const dstResolution = 0.001; // ~111 m at equator; good default for moderate DEMs.
  const dstWest = -180.0;
  const dstEast = 180.0;
  const dstSouth = -90.0;
  const dstNorth = 90.0;
  const dstWidth = Math.max(1, Math.floor((dstEast - dstWest) / dstResolution));
  const dstHeight = Math.max(1, Math.floor((dstNorth - dstSouth) / dstResolution));
  const dstData = new Float64Array(dstWidth * dstHeight);
  for (let i = 0; i < dstData.length; i++) dstData[i] = NaN;

  // Source coordinate of each src pixel center, in src CRS.
  const srcDx = (srcEast - srcWest) / width;
  const srcDy = (srcNorth - srcSouth) / height;
  // Build per-destination-pixel mapping: for each (row,col) in the dst
  // grid, compute the corresponding (col,row) in the source grid using
  // proj4, then bilinear-sample. This is O(N) and slow; for large DEMs
  // a chunked approach would be better, but we keep it simple.
  const project = proj4(srcProj, dstProj);
  const unproject = proj4(dstProj, srcProj);
  for (let row = 0; row < dstHeight; row++) {
    const lat = dstNorth - (row + 0.5) * (dstResolution);
    for (let col = 0; col < dstWidth; col++) {
      const lon = dstWest + (col + 0.5) * dstResolution;
      const [sx, sy] = unproject.forward([lon, lat]);
      const sfCol = (sx - srcWest) / srcDx - 0.5;
      const sfRow = (srcNorth - sy) / srcDy - 0.5;
      if (sfCol < 0 || sfCol > width - 1 || sfRow < 0 || sfRow > height - 1) continue;
      const c0 = Math.max(0, Math.min(width - 1, Math.floor(sfCol)));
      const r0 = Math.max(0, Math.min(height - 1, Math.floor(sfRow)));
      const c1 = Math.min(width - 1, c0 + 1);
      const r1 = Math.min(height - 1, r0 + 1);
      const tx = Math.max(0, Math.min(1, sfCol - c0));
      const ty = Math.max(0, Math.min(1, sfRow - r0));
      const v00 = srcFlat[r0 * width + c0];
      const v10 = srcFlat[r0 * width + c1];
      const v01 = srcFlat[r1 * width + c0];
      const v11 = srcFlat[r1 * width + c1];
      const v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
      dstData[row * dstWidth + col] = v;
    }
  }
  // Sanity check that proj4 round-trips.
  void project;

  // Constrain to DEM bbox intersection with WGS84 domain to keep tile counts sane.
  const finalWest = Math.max(dstWest, Math.min(srcWest, srcEast));
  const finalEast = Math.min(dstEast, Math.max(srcWest, srcEast));
  const finalSouth = Math.max(dstSouth, Math.min(srcSouth, srcNorth));
  const finalNorth = Math.min(dstNorth, Math.max(srcSouth, srcNorth));

  return {
    data: dstData,
    width: dstWidth, height: dstHeight,
    west: finalWest, south: finalSouth, east: finalEast, north: finalNorth,
    nodata,
  };
}

/**
 * Bilinear sample of the DEM at a (lon, lat) coordinate. Out-of-range
 * pixels and nodata values are coerced to NODATA_FILL.
 */
function makeSampler(dem: DemGrid) {
  const dx = (dem.east - dem.west) / dem.width;
  const dy = (dem.north - dem.south) / dem.height;

  // Pre-clean the DEM grid: replace nodata, NaN, and out-of-range values
  // with NODATA_FILL so sampling doesn't have to special-case them.
  for (let i = 0; i < dem.data.length; i++) {
    let v = dem.data[i];
    if (dem.nodata !== undefined && dem.nodata !== null && Math.abs(v - dem.nodata) < 1.0) {
      v = NODATA_FILL;
    }
    if (!Number.isFinite(v) || v <= MIN_VALID_ELEVATION || v >= MAX_VALID_ELEVATION) {
      v = NODATA_FILL;
    }
    dem.data[i] = v;
  }

  return (lon: number, lat: number): number => {
    const colF = (lon - dem.west) / dx - 0.5;
    const rowF = (dem.north - lat) / dy - 0.5;
    if (colF < 0 || colF > dem.width - 1 || rowF < 0 || rowF > dem.height - 1) {
      return NODATA_FILL;
    }
    const c0 = Math.max(0, Math.min(dem.width - 1, Math.floor(colF)));
    const r0 = Math.max(0, Math.min(dem.height - 1, Math.floor(rowF)));
    const c1 = Math.min(dem.width - 1, c0 + 1);
    const r1 = Math.min(dem.height - 1, r0 + 1);
    const tx = Math.max(0, Math.min(1, colF - c0));
    const ty = Math.max(0, Math.min(1, rowF - r0));
    const v00 = dem.data[r0 * dem.width + c0];
    const v10 = dem.data[r0 * dem.width + c1];
    const v01 = dem.data[r1 * dem.width + c0];
    const v11 = dem.data[r1 * dem.width + c1];
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  };
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/** ZigZag + delta encoding for vertex coordinates. */
function encodeDeltaZigZag(vals: number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const v of vals) {
    let delta = v - prev;
    // int16 wrap-around
    delta = ((delta + 32768) % 65536 + 65536) % 65536 - 32768;
    const enc = ((delta << 1) ^ (delta >> 15)) & 0xffff;
    out.push(enc);
    prev = v;
  }
  return out;
}

/** High-water-mark encoding for triangle index lists. */
function encodeHighWaterMark(indices: number[]): number[] {
  const out: number[] = [];
  let highest = 0;
  for (const idx of indices) {
    out.push(highest - idx);
    if (idx === highest) highest += 1;
  }
  return out;
}

/** Pre-compute the regular grid mesh topology (u, v, triangles, edges). */
function makeGridMesh(gridSize: number): {
  uList: number[];
  vList: number[];
  triangles: number[];
  westIdx: number[];
  southIdx: number[];
  eastIdx: number[];
  northIdx: number[];
} {
  const n = gridSize;
  const uList: number[] = [];
  const vList: number[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      uList.push(Math.round((c / (n - 1)) * MAX_Q));
      vList.push(Math.round((r / (n - 1)) * MAX_Q));
    }
  }
  const triangles: number[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const tl = r * n + c;
      const tr = r * n + c + 1;
      const bl = (r + 1) * n + c;
      const br = (r + 1) * n + c + 1;
      triangles.push(tl, tr, bl);
      triangles.push(tr, br, bl);
    }
  }
  const westIdx: number[] = [];
  const southIdx: number[] = [];
  const eastIdx: number[] = [];
  const northIdx: number[] = [];
  for (let r = 0; r < n; r++) westIdx.push(r * n);
  for (let c = 0; c < n; c++) southIdx.push(c);
  for (let r = 0; r < n; r++) eastIdx.push(r * n + (n - 1));
  for (let c = 0; c < n; c++) northIdx.push((n - 1) * n + c);
  return { uList, vList, triangles, westIdx, southIdx, eastIdx, northIdx };
}

/**
 * Encode a quantized-mesh-1.0 tile. Optionally gzipped.
 */
function writeTerrainTile(
  west: number, south: number, east: number, north: number,
  uList: number[], vList: number[], hList: number[],
  triangles: number[],
  westIdx: number[], southIdx: number[], eastIdx: number[], northIdx: number[],
  compress: boolean,
): Buffer {
  const minH = Math.min(...hList);
  const maxH = Math.max(...hList);
  const hRange = maxH > minH ? maxH - minH : 1.0;
  const hQ = hList.map((h) => Math.round(((h - minH) / hRange) * MAX_Q));

  const vertexCount = uList.length;
  const triangleCount = triangles.length / 3;
  const use32Bit = vertexCount > 65536;
  const idxSize = use32Bit ? 4 : 2;

  // Header
  const [cx, cy, cz] = llhToEcef((west + east) / 2, (south + north) / 2, (minH + maxH) / 2);
  const { center: bsCenter, radius: bsRadius } = computeBoundingSphere(west, south, east, north, minH, maxH);
  const [hox, hoy, hoz] = computeHorizonOcclusion(west, south, east, north, maxH);

  const parts: Buffer[] = [];
  parts.push(Buffer.alloc(24));
  parts[0].writeDoubleLE(cx, 0);
  parts[0].writeDoubleLE(cy, 8);
  parts[0].writeDoubleLE(cz, 16);
  parts.push(Buffer.alloc(8));
  parts[1].writeFloatLE(minH, 0);
  parts[1].writeFloatLE(maxH, 4);
  parts.push(Buffer.alloc(32));
  parts[2].writeDoubleLE(bsCenter[0], 0);
  parts[2].writeDoubleLE(bsCenter[1], 8);
  parts[2].writeDoubleLE(bsCenter[2], 16);
  parts[2].writeDoubleLE(bsRadius, 24);
  parts.push(Buffer.alloc(24));
  parts[3].writeDoubleLE(hox, 0);
  parts[3].writeDoubleLE(hoy, 8);
  parts[3].writeDoubleLE(hoz, 16);

  // Vertex data
  parts.push(Buffer.alloc(4));
  parts[4].writeUInt32LE(vertexCount, 0);
  for (const arr of [uList, vList, hQ]) {
    for (const v of encodeDeltaZigZag(arr)) {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(v & 0xffff, 0);
      parts.push(buf);
    }
  }

  // 4-byte alignment for the index section when 32-bit indices are in use.
  let written = parts.reduce((s, b) => s + b.length, 0);
  if (use32Bit && written % 4 !== 0) {
    parts.push(Buffer.alloc(4 - (written % 4)));
    written += parts[parts.length - 1].length;
  }

  // Triangle indices (high-water mark encoded)
  parts.push(Buffer.alloc(4));
  parts[parts.length - 1].writeUInt32LE(triangleCount, 0);
  const hwm = encodeHighWaterMark(triangles);
  for (const v of hwm) {
    const buf = Buffer.alloc(idxSize);
    if (use32Bit) buf.writeUInt32LE(v >>> 0, 0);
    else buf.writeUInt16LE(v & 0xffff, 0);
    parts.push(buf);
  }

  // Edge indices
  for (const edge of [westIdx, southIdx, eastIdx, northIdx]) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(edge.length, 0);
    parts.push(lenBuf);
    for (const v of edge) {
      const buf = Buffer.alloc(idxSize);
      if (use32Bit) buf.writeUInt32LE(v >>> 0, 0);
      else buf.writeUInt16LE(v & 0xffff, 0);
      parts.push(buf);
    }
  }

  const raw = Buffer.concat(parts);
  return compress ? zlib.gzipSync(raw) : raw;
}

/**
 * Generate an all-zeros blank placeholder tile. Used at level 0 (Cesium
 * always requests both world tiles) and for levels where we want to fill
 * the entire pyramid with something parseable.
 */
function makeBlankTile(
  west: number, south: number, east: number, north: number, compress: boolean,
): Buffer {
  const n = 4;
  const { uList, vList, triangles, westIdx, southIdx, eastIdx, northIdx } = makeGridMesh(n);
  const heights = new Array<number>(n * n).fill(0.0);
  return writeTerrainTile(
    west, south, east, north, uList, vList, heights, triangles,
    westIdx, southIdx, eastIdx, northIdx, compress,
  );
}

// ---------------------------------------------------------------------------
// layer.json manifest
// ---------------------------------------------------------------------------

interface LayerJsonAvailable {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

function writeLayerJson(
  outputDir: string,
  demBounds: [number, number, number, number],
  maxLevel: number,
  availableTiles: Map<number, Set<string>>,
): void {
  const [west, south, east, north] = demBounds;
  const available: LayerJsonAvailable[][] = [];
  for (let z = 0; z <= maxLevel; z++) {
    if (z === 0) {
      // Cesium always probes level 0; advertise full world coverage.
      available.push([{ startX: 0, startY: 0, endX: 1, endY: 0 }]);
      continue;
    }
    const tiles = availableTiles.get(z);
    if (!tiles || tiles.size === 0) {
      available.push([]);
      continue;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    for (const k of tiles) {
      const [x, y] = k.split(',').map((s) => Number(s));
      xs.push(x);
      ys.push(y);
    }
    available.push([{
      startX: Math.min(...xs), startY: Math.min(...ys),
      endX: Math.max(...xs), endY: Math.max(...ys),
    }]);
  }
  const layer = {
    tilejson: '2.1.0',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    tiles: ['{z}/{x}/{y}.terrain'],
    projection: 'EPSG:4326',
    bounds: [west, south, east, north],
    available,
  };
  const filePath = path.join(outputDir, 'layer.json');
  fs.writeFileSync(filePath, JSON.stringify(layer, null, 2), 'utf8');
  log.info(`[write] ${filePath}`);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface TerrainCesiumOptions {
  outputPath: string;
  /** Maximum zoom level (default 8). */
  maxLevel?: number;
  /** Per-tile grid resolution. 16/32/64 typical (default 32). */
  gridSize?: number;
  /** Disable gzip compression (debug only). */
  noCompress?: boolean;
  /** Override source CRS auto-detection (e.g. "EPSG:4326"). */
  fromCrs?: string;
}

export interface TerrainCesiumSummary {
  totalTiles: number;
  blankTiles: number;
  maxLevel: number;
  outputPath: string;
  demBounds: [number, number, number, number];
}

function writeTile(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

export async function writeTerrainCesiumTiles(
  demPath: string,
  opts: TerrainCesiumOptions,
): Promise<TerrainCesiumSummary> {
  const maxLevel = opts.maxLevel ?? 8;
  const gridSize = opts.gridSize ?? 32;
  const compress = !opts.noCompress;

  if (!fs.existsSync(demPath)) {
    throw new Error(`DEM file not found: ${demPath}`);
  }
  fs.mkdirSync(opts.outputPath, { recursive: true });

  log.info(`[DEM] reading ${demPath}`);
  const dem = await loadDemWgs84(demPath);
  const sampler = makeSampler(dem);
  const { west: demWest, south: demSouth, east: demEast, north: demNorth } = dem;

  // Reduce the DEM bbox to a sane envelope so we don't generate the whole
  // world for a tiny raster. Clamp the WGS84 domain just in case.
  const clampedBounds: [number, number, number, number] = [
    Math.max(-180, Math.min(180, demWest)),
    Math.max(-90, Math.min(90, demSouth)),
    Math.max(-180, Math.min(180, demEast)),
    Math.max(-90, Math.min(90, demNorth)),
  ];

  log.info(
    `[DEM] bbox=(${clampedBounds[0].toFixed(4)}, ${clampedBounds[1].toFixed(4)}, `
      + `${clampedBounds[2].toFixed(4)}, ${clampedBounds[3].toFixed(4)})`,
  );

  // Pre-compute the shared grid topology.
  const { uList, vList, triangles, westIdx, southIdx, eastIdx, northIdx } = makeGridMesh(gridSize);
  const uNorm = Float64Array.from(uList, (v) => v / MAX_Q);
  const vNorm = Float64Array.from(vList, (v) => v / MAX_Q);

  const availableTiles = new Map<number, Set<string>>();
  let totalData = 0;
  let totalBlank = 0;
  const blankCache = new Map<number, Buffer>();

  function getBlank(z: number, x: number, y: number): Buffer {
    let b = blankCache.get(z);
    if (!b) {
      const [bw, bs, be, bn] = tileBBox(z, x, y);
      b = makeBlankTile(bw, bs, be, bn, compress);
      blankCache.set(z, b);
    }
    return b;
  }

  for (let z = 0; z <= maxLevel; z++) {
    const nCols = 2 << z;
    const nRows = 1 << z;
    const demTiles = new Set<string>();
    for (const [x, y] of tilesForLevel(z, clampedBounds[0], clampedBounds[1], clampedBounds[2], clampedBounds[3])) {
      demTiles.add(`${x},${y}`);
    }
    // Level 0 must contain both world tiles or Cesium refuses to render.
    const mustExist = new Set<string>();
    if (z === 0) {
      for (let x = 0; x < nCols; x++) {
        for (let y = 0; y < nRows; y++) {
          mustExist.add(`${x},${y}`);
        }
      }
    }
    const allTiles = new Set<string>([...demTiles, ...mustExist]);
    if (allTiles.size === 0) continue;

    availableTiles.set(z, new Set());
    let dataCount = 0;
    let blankCount = 0;

    const sortedKeys = Array.from(allTiles).sort();
    for (const key of sortedKeys) {
      const [xs, ys] = key.split(',');
      const x = Number(xs);
      const y = Number(ys);
      const tilePath = path.join(opts.outputPath, String(z), String(x), `${y}.terrain`);

      if (demTiles.has(key)) {
        const [west, south, east, north] = tileBBox(z, x, y);
        const lons = new Float64Array(uNorm.length);
        const lats = new Float64Array(vNorm.length);
        for (let i = 0; i < uNorm.length; i++) {
          lons[i] = west + uNorm[i] * (east - west);
          lats[i] = south + vNorm[i] * (north - south);
        }
        const heights = new Array<number>(lons.length);
        for (let i = 0; i < lons.length; i++) {
          heights[i] = sampler(lons[i], lats[i]);
        }
        const bytes = writeTerrainTile(
          west, south, east, north,
          uList, vList, heights, triangles,
          westIdx, southIdx, eastIdx, northIdx,
          compress,
        );
        writeTile(tilePath, bytes);
        availableTiles.get(z)!.add(key);
        dataCount += 1;
        totalData += 1;
      } else {
        writeTile(tilePath, getBlank(z, x, y));
        blankCount += 1;
        totalBlank += 1;
      }
    }
    let desc = `${dataCount} real`;
    if (blankCount > 0) desc += ` + ${blankCount} blank`;
    log.info(`[Level ${z.toString().padStart(2)}] ${desc}`);
  }

  writeLayerJson(opts.outputPath, clampedBounds, maxLevel, availableTiles);
  log.info(
    `\nDone: ${totalData} real tiles, ${totalBlank} blank placeholders -> ${path.resolve(opts.outputPath)}`,
  );
  return {
    totalTiles: totalData,
    blankTiles: totalBlank,
    maxLevel,
    outputPath: path.resolve(opts.outputPath),
    demBounds: clampedBounds,
  };
}
