/**
 * Cesium quantized-mesh terrain tile generator.
 *
 * Converts DEM (GeoTIFF) to Cesium .terrain tiles (quantized-mesh format).
 * Pure TypeScript implementation, no GDAL dependency.
 *
 * Output: {z}/{x}/{y}.terrain directory structure (TMS scheme).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromFile } from 'geotiff';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEB_MERCATOR_MAX = 20037508.342789244;
const WEB_MERCATOR_SIZE = WEB_MERCATOR_MAX * 2;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const WGS84_A = 6378137.0; // semi-major axis
const WGS84_B = 6356752.314245; // semi-minor axis

// ---------------------------------------------------------------------------
// Coordinate math
// ---------------------------------------------------------------------------

function wgs84ToCartesian(lon: number, lat: number, height: number): [number, number, number] {
  const lonRad = lon * DEG_TO_RAD;
  const latRad = lat * DEG_TO_RAD;
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);
  const e2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const nu = WGS84_A / Math.sqrt(1 - e2 * sinLat * sinLat);
  const x = (nu + height) * cosLat * cosLon;
  const y = (nu + height) * cosLat * sinLon;
  const z = (nu * (1 - e2) + height) * sinLat;
  return [x, y, z];
}

function tileBBoxWGS84(z: number, x: number, y: number): [number, number, number, number] {
  const n = 1 << z;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latMin = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return [lonMin, latMin, lonMax, latMax];
}

function tileRangeForBBox(bbox: [number, number, number, number], z: number) {
  const n = 1 << z;
  const minX = Math.max(0, Math.floor(((bbox[0] + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n));
  const maxX = Math.min(n - 1, Math.floor(((bbox[2] + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n));
  const minY = Math.max(0, Math.floor(((WEB_MERCATOR_MAX - bbox[3]) / WEB_MERCATOR_SIZE) * n));
  const maxY = Math.min(n - 1, Math.floor(((WEB_MERCATOR_MAX - bbox[1]) / WEB_MERCATOR_SIZE) * n));
  return { minX, maxX, minY, maxY };
}

function wgs84ToWebMercator(lon: number, lat: number): [number, number] {
  const x = (lon / 180) * WEB_MERCATOR_MAX;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  return [x, (y / 180) * WEB_MERCATOR_MAX];
}

// ---------------------------------------------------------------------------
// DEM reader (same as terrain-tile.ts)
// ---------------------------------------------------------------------------

interface DEMData {
  width: number;
  height: number;
  bbox: [number, number, number, number];
  data: Float32Array | Int16Array;
  nodata: number;
}

async function readDEM(filePath: string): Promise<DEMData> {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox() as [number, number, number, number];
  const nodata = image.getGDALNoData() ?? -32768;
  const rasterData = await image.readRasters({ interleave: false });
  const data = rasterData[0] as Float32Array | Int16Array;
  return { width, height, bbox, data, nodata };
}

function sampleDEM(dem: DEMData, lon: number, lat: number): number {
  const px = ((lon - dem.bbox[0]) / (dem.bbox[2] - dem.bbox[0])) * (dem.width - 1);
  const py = ((dem.bbox[3] - lat) / (dem.bbox[3] - dem.bbox[1])) * (dem.height - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, dem.width - 1);
  const y1 = Math.min(y0 + 1, dem.height - 1);
  const cx0 = Math.max(0, Math.min(x0, dem.width - 1));
  const cy0 = Math.max(0, Math.min(y0, dem.height - 1));
  const fx = px - x0;
  const fy = py - y0;
  const v00 = getElevation(dem, cx0, cy0);
  const v10 = getElevation(dem, x1, cy0);
  const v01 = getElevation(dem, cx0, y1);
  const v11 = getElevation(dem, x1, y1);
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

function getElevation(dem: DEMData, x: number, y: number): number {
  if (x < 0 || x >= dem.width || y < 0 || y >= dem.height) return 0;
  const val = dem.data[y * dem.width + x];
  return val === dem.nodata ? 0 : val;
}

// ---------------------------------------------------------------------------
// Quantized-Mesh encoder
// ---------------------------------------------------------------------------

interface TerrainTile {
  z: number;
  x: number;
  y: number;
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
  heights: Float64Array; // per-vertex heights
  gridSize: number; // vertices per side (e.g. 65)
}

function encodeQuantizedMesh(tile: TerrainTile): Buffer {
  const gridSize = tile.gridSize;
  const vertexCount = gridSize * gridSize;
  const lonRange = tile.lonMax - tile.lonMin;
  const latRange = tile.latMax - tile.latMin;

  // Compute min/max heights
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const h = tile.heights[i];
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }
  if (!isFinite(minHeight)) { minHeight = 0; maxHeight = 0; }
  if (minHeight === maxHeight) maxHeight = minHeight + 1;

  // Compute center in Cartesian
  const centerLon = (tile.lonMin + tile.lonMax) / 2;
  const centerLat = (tile.latMin + tile.latMax) / 2;
  const centerHeight = (minHeight + maxHeight) / 2;
  const [centerX, centerY, centerZ] = wgs84ToCartesian(centerLon, centerLat, centerHeight);

  // Compute bounding sphere
  const corners = [
    wgs84ToCartesian(tile.lonMin, tile.latMin, minHeight),
    wgs84ToCartesian(tile.lonMax, tile.latMin, minHeight),
    wgs84ToCartesian(tile.lonMin, tile.latMax, minHeight),
    wgs84ToCartesian(tile.lonMax, tile.latMax, minHeight),
    wgs84ToCartesian(tile.lonMin, tile.latMin, maxHeight),
    wgs84ToCartesian(tile.lonMax, tile.latMin, maxHeight),
    wgs84ToCartesian(tile.lonMin, tile.latMax, maxHeight),
    wgs84ToCartesian(tile.lonMax, tile.latMax, maxHeight),
  ];
  let bsRadius = 0;
  for (const c of corners) {
    const dx = c[0] - centerX;
    const dy = c[1] - centerY;
    const dz = c[2] - centerZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > bsRadius) bsRadius = dist;
  }

  // Horizon occlusion point (approximate)
  const horizonX = centerX * 2;
  const horizonY = centerY * 2;
  const horizonZ = centerZ * 2;

  // Quantize vertices
  const uArr = new Uint16Array(vertexCount);
  const vArr = new Uint16Array(vertexCount);
  const hArr = new Uint16Array(vertexCount);

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const idx = row * gridSize + col;
      const lon = tile.lonMin + (col / (gridSize - 1)) * lonRange;
      const lat = tile.latMax - (row / (gridSize - 1)) * latRange;
      const h = tile.heights[idx];

      uArr[idx] = Math.round(((lon - tile.lonMin) / lonRange) * 65535);
      vArr[idx] = Math.round(((tile.latMax - lat) / latRange) * 65535);
      hArr[idx] = Math.round(((h - minHeight) / (maxHeight - minHeight)) * 65535);
    }
  }

  // Generate triangle indices
  const indices: number[] = [];
  for (let row = 0; row < gridSize - 1; row++) {
    for (let col = 0; col < gridSize - 1; col++) {
      const i00 = row * gridSize + col;
      const i10 = i00 + 1;
      const i01 = i00 + gridSize;
      const i11 = i01 + 1;
      indices.push(i00, i10, i01);
      indices.push(i10, i11, i01);
    }
  }

  // Generate edge indices
  const westIndices: number[] = [];
  const southIndices: number[] = [];
  const eastIndices: number[] = [];
  const northIndices: number[] = [];

  for (let i = 0; i < gridSize; i++) {
    westIndices.push(i * gridSize);
    southIndices.push((gridSize - 1) * gridSize + i);
    eastIndices.push(i * gridSize + gridSize - 1);
    northIndices.push(i);
  }

  // Encode indices with zigzag + delta encoding
  const encodedIndices = encodeIndices(indices);
  const encodedWest = encodeIndices(westIndices);
  const encodedSouth = encodeIndices(southIndices);
  const encodedEast = encodeIndices(eastIndices);
  const encodedNorth = encodeIndices(northIndices);

  // Build binary buffer
  const headerSize = 88;
  const vertexDataSize = 4 + vertexCount * 6; // count + u + v + h arrays
  const indexDataSize = 4 + encodedIndices.byteLength +
    4 + encodedWest.byteLength +
    4 + encodedSouth.byteLength +
    4 + encodedEast.byteLength +
    4 + encodedNorth.byteLength;

  const buf = Buffer.alloc(headerSize + vertexDataSize + indexDataSize);
  let off = 0;

  // Header
  buf.writeDoubleLE(centerX, off); off += 8;
  buf.writeDoubleLE(centerY, off); off += 8;
  buf.writeDoubleLE(centerZ, off); off += 8;
  buf.writeFloatLE(minHeight, off); off += 4;
  buf.writeFloatLE(maxHeight, off); off += 4;
  buf.writeDoubleLE(centerX, off); off += 8; // bounding sphere center
  buf.writeDoubleLE(centerY, off); off += 8;
  buf.writeDoubleLE(centerZ, off); off += 8;
  buf.writeDoubleLE(bsRadius, off); off += 8;
  buf.writeDoubleLE(horizonX, off); off += 8;
  buf.writeDoubleLE(horizonY, off); off += 8;
  buf.writeDoubleLE(horizonZ, off); off += 8;

  // Vertex data
  buf.writeUInt32LE(vertexCount, off); off += 4;
  for (let i = 0; i < vertexCount; i++) { buf.writeUInt16LE(uArr[i], off); off += 2; }
  for (let i = 0; i < vertexCount; i++) { buf.writeUInt16LE(vArr[i], off); off += 2; }
  for (let i = 0; i < vertexCount; i++) { buf.writeUInt16LE(hArr[i], off); off += 2; }

  // Index data
  buf.writeUInt32LE(encodedIndices.byteLength, off); off += 4;
  Buffer.from(encodedIndices).copy(buf, off); off += encodedIndices.byteLength;

  // Edge indices
  for (const edge of [encodedWest, encodedSouth, encodedEast, encodedNorth]) {
    buf.writeUInt32LE(edge.byteLength, off); off += 4;
    Buffer.from(edge).copy(buf, off); off += edge.byteLength;
  }

  return buf.subarray(0, off);
}

/** Encode indices using zigzag + delta encoding. */
function encodeIndices(indices: number[]): Uint32Array {
  const encoded = new Uint32Array(indices.length);
  let highWaterMark = 0;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const delta = index - highWaterMark;
    encoded[i] = zigZagEncode(delta);
    if (index > highWaterMark) highWaterMark = index;
  }
  return encoded;
}

function zigZagEncode(n: number): number {
  return (n >> 31) ^ (n << 1);
}

// ---------------------------------------------------------------------------
// Tile generator
// ---------------------------------------------------------------------------

export interface CesiumTerrainOptions {
  outputPath: string;
  minZoom?: number;
  maxZoom?: number;
  gridSize?: number; // vertices per tile side (default 65)
}

export interface CesiumTerrainSummary {
  totalTiles: number;
  emptyTilesSkipped: number;
  minZoom: number;
  maxZoom: number;
  outputPath: string;
}

export async function writeCesiumTerrain(
  demPath: string,
  opts: CesiumTerrainOptions,
): Promise<CesiumTerrainSummary> {
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = opts.maxZoom ?? 12;
  const gridSize = opts.gridSize ?? 65;

  log.info(`Reading DEM: ${demPath}`);
  const dem = await readDEM(demPath);
  log.info(`DEM: ${dem.width}x${dem.height}, bbox=[${dem.bbox.join(', ')}]`);

  // Convert DEM bbox to Web Mercator for tile range calculation
  const wmBbox = [
    ...wgs84ToWebMercator(dem.bbox[0], dem.bbox[1]),
    ...wgs84ToWebMercator(dem.bbox[2], dem.bbox[3]),
  ] as [number, number, number, number];

  let totalTiles = 0;
  let emptyTilesSkipped = 0;

  for (let z = minZoom; z <= maxZoom; z++) {
    const range = tileRangeForBBox(wmBbox, z);
    const tileCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    log.info(`Zoom ${z}: ${range.minX}-${range.maxX} x ${range.minY}-${range.maxY} (${tileCount} tiles)`);

    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        const tileBBox = tileBBoxWGS84(z, x, y);

        // Sample DEM at grid points
        const heights = new Float64Array(gridSize * gridSize);
        let hasData = false;
        let tMinH = Infinity;
        let tMaxH = -Infinity;

        for (let row = 0; row < gridSize; row++) {
          for (let col = 0; col < gridSize; col++) {
            const lon = tileBBox[0] + (col / (gridSize - 1)) * (tileBBox[2] - tileBBox[0]);
            const lat = tileBBox[3] - (row / (gridSize - 1)) * (tileBBox[3] - tileBBox[1]);
            const h = sampleDEM(dem, lon, lat);
            heights[row * gridSize + col] = h;
            if (h !== 0) hasData = true;
            if (h < tMinH) tMinH = h;
            if (h > tMaxH) tMaxH = h;
          }
        }

        if (!hasData) { emptyTilesSkipped++; continue; }

        // Encode quantized-mesh
        const terrain = encodeQuantizedMesh({
          z, x, y,
          lonMin: tileBBox[0], latMin: tileBBox[1],
          lonMax: tileBBox[2], latMax: tileBBox[3],
          heights,
          gridSize,
        });

        // Write .terrain file (TMS scheme: y is flipped)
        const tmsY = (1 << z) - 1 - y;
        const tileDir = path.join(opts.outputPath, String(z), String(x));
        fs.mkdirSync(tileDir, { recursive: true });
        fs.writeFileSync(path.join(tileDir, `${tmsY}.terrain`), terrain);
        totalTiles++;
      }
    }
  }

  // Write layer.json metadata for Cesium
  const layerJson = {
    tilejson: '2.1.0',
    name: 'terrain',
    format: 'quantized-mesh',
    encoding: 'application/vnd.quantized-mesh',
    version: '1.0.0',
    scheme: 'tms',
    minzoom: minZoom,
    maxzoom: maxZoom,
    bounds: dem.bbox,
    tiles: ['{z}/{x}/{y}.terrain'],
    extensions: ['octvertexnormals', 'watermask'],
  };
  fs.writeFileSync(path.join(opts.outputPath, 'layer.json'), JSON.stringify(layerJson, null, 2));

  return { totalTiles, emptyTilesSkipped, minZoom, maxZoom, outputPath: opts.outputPath };
}
