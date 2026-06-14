/**
 * Cesium quantized-mesh terrain tile generator.
 *
 * Converts DEM (GeoTIFF) to Cesium .terrain tiles (quantized-mesh format).
 * Pure TypeScript implementation, no GDAL dependency.
 *
 * Output: {z}/{x}/{y}.terrain directory structure (TMS scheme).
 * Tiling scheme: EPSG:4326 (GeographicTilingScheme, 2×1 tiles at level 0).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromFile } from 'geotiff';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
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

/**
 * Compute WGS84 bounding box for a tile in GeographicTilingScheme (EPSG:4326).
 * Level 0 has 2×1 tiles. At level z: nX = 2*2^z, nY = 2^z.
 * XYZ convention: y=0 at north pole.
 */
function tileBBoxWGS84(z: number, x: number, y: number): [number, number, number, number] {
  const nX = 2 * (1 << z);
  const nY = 1 << z;
  const lonMin = (x / nX) * 360 - 180;
  const lonMax = ((x + 1) / nX) * 360 - 180;
  const latMax = 90 - (y / nY) * 180;
  const latMin = 90 - ((y + 1) / nY) * 180;
  return [lonMin, latMin, lonMax, latMax];
}

/**
 * Compute tile range (XYZ convention) for a WGS84 bbox at a given zoom level.
 * Uses GeographicTilingScheme: level 0 has 2×1 tiles.
 */
function tileRangeForBBox(bbox: [number, number, number, number], z: number) {
  const nX = 2 * (1 << z);
  const nY = 1 << z;
  const minX = Math.max(0, Math.floor(((bbox[0] + 180) / 360) * nX));
  const maxX = Math.min(nX - 1, Math.floor(((bbox[2] + 180) / 360) * nX));
  const minY = Math.max(0, Math.floor(((90 - bbox[3]) / 180) * nY));
  const maxY = Math.min(nY - 1, Math.floor(((90 - bbox[1]) / 180) * nY));
  return { minX, maxX, minY, maxY };
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
  if (lon < dem.bbox[0] || lon > dem.bbox[2] || lat < dem.bbox[1] || lat > dem.bbox[3]) return 0;

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

function chooseMeshGridSize(heights: Float64Array, sourceGridSize: number, z: number): number {
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let row = 0; row < sourceGridSize; row++) {
    for (let col = 0; col < sourceGridSize; col++) {
      const idx = row * sourceGridSize + col;
      const h = heights[idx];
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  const relief = maxHeight - minHeight;
  const zoomCap = z <= 4 ? 9 : z <= 6 ? 17 : z <= 8 ? 25 : z <= 10 ? 33 : sourceGridSize;
  const reliefGrid = !isFinite(relief) || relief <= 2 ? 9 : relief <= 1_000 ? 17 : relief <= 2_500 ? 25 : relief <= 4_500 ? 33 : sourceGridSize;
  return Math.min(sourceGridSize, zoomCap, reliefGrid);
}

function downsampleHeights(heights: Float64Array, sourceGridSize: number, targetGridSize: number): Float64Array {
  if (sourceGridSize === targetGridSize) return heights;

  const sampled = new Float64Array(targetGridSize * targetGridSize);
  for (let row = 0; row < targetGridSize; row++) {
    const srcRow = Math.round((row / (targetGridSize - 1)) * (sourceGridSize - 1));
    for (let col = 0; col < targetGridSize; col++) {
      const srcCol = Math.round((col / (targetGridSize - 1)) * (sourceGridSize - 1));
      sampled[row * targetGridSize + col] = heights[srcRow * sourceGridSize + srcCol];
    }
  }
  return sampled;
}

function zigZagEncode16(value: number): number {
  return ((value << 1) ^ (value >> 31)) & 0xffff;
}

function deltaEncodeQuantized(values: Uint16Array): Uint16Array {
  const encoded = new Uint16Array(values.length);
  let last = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    encoded[i] = zigZagEncode16(value - last);
    last = value;
  }
  return encoded;
}

function highWaterMarkEncode(indices: number[]): Uint16Array {
  const encoded = new Uint16Array(indices.length);
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = highest - indices[i];
    encoded[i] = code;
    if (code === 0) highest++;
  }
  return encoded;
}

function remapMeshIndices(
  uArr: Uint16Array,
  vArr: Uint16Array,
  hArr: Uint16Array,
  indices: number[],
  edges: number[][],
): { uArr: Uint16Array; vArr: Uint16Array; hArr: Uint16Array; indices: number[]; edges: number[][] } {
  const remap = new Map<number, number>();
  const oldOrder: number[] = [];
  const remapIndex = (oldIndex: number): number => {
    let next = remap.get(oldIndex);
    if (next === undefined) {
      next = oldOrder.length;
      remap.set(oldIndex, next);
      oldOrder.push(oldIndex);
    }
    return next;
  };

  const remappedIndices = indices.map(remapIndex);
  const remappedEdges = edges.map((edge) => edge.map(remapIndex));
  const remappedU = new Uint16Array(oldOrder.length);
  const remappedV = new Uint16Array(oldOrder.length);
  const remappedH = new Uint16Array(oldOrder.length);
  for (let i = 0; i < oldOrder.length; i++) {
    const oldIndex = oldOrder[i];
    remappedU[i] = uArr[oldIndex];
    remappedV[i] = vArr[oldIndex];
    remappedH[i] = hArr[oldIndex];
  }

  return {
    uArr: remappedU,
    vArr: remappedV,
    hArr: remappedH,
    indices: remappedIndices,
    edges: remappedEdges,
  };
}

function encodeQuantizedMesh(tile: TerrainTile): Buffer {
  const gridSize = chooseMeshGridSize(tile.heights, tile.gridSize, tile.z);
  const heights = downsampleHeights(tile.heights, tile.gridSize, gridSize);
  const sourceVertexCount = gridSize * gridSize;
  const lonRange = tile.lonMax - tile.lonMin;
  const latRange = tile.latMax - tile.latMin;

  // Compute min/max heights
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < sourceVertexCount; i++) {
    const h = heights[i];
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

  // Horizon occlusion point expressed in ellipsoid-scaled space, matching Cesium's
  // QuantizedMeshTerrainData expectation.
  const horizonX = centerX / WGS84_A;
  const horizonY = centerY / WGS84_A;
  const horizonZ = centerZ / WGS84_B;

  // Quantize vertices — Cesium expects [0, 32767] (maxShort = 32767)
  const sourceU = new Uint16Array(sourceVertexCount);
  const sourceV = new Uint16Array(sourceVertexCount);
  const sourceH = new Uint16Array(sourceVertexCount);

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const idx = row * gridSize + col;
      const lon = tile.lonMin + (col / (gridSize - 1)) * lonRange;
      const lat = tile.latMax - (row / (gridSize - 1)) * latRange;
      const h = heights[idx];

      sourceU[idx] = Math.round(((lon - tile.lonMin) / lonRange) * 32767);
      sourceV[idx] = Math.round(((lat - tile.latMin) / latRange) * 32767);
      sourceH[idx] = Math.round(((h - minHeight) / (maxHeight - minHeight)) * 32767);
    }
  }

  // Generate triangle indices (high LOD)
  const indices: number[] = [];
  for (let row = 0; row < gridSize - 1; row++) {
    for (let col = 0; col < gridSize - 1; col++) {
      const i00 = row * gridSize + col;
      const i10 = i00 + 1;
      const i01 = i00 + gridSize;
      const i11 = i01 + 1;
      // Counter-clockwise winding: NW→SW→NE, NE→SW→SE
      indices.push(i00, i01, i10);
      indices.push(i10, i01, i11);
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

  const remapped = remapMeshIndices(sourceU, sourceV, sourceH, indices, [westIndices, southIndices, eastIndices, northIndices]);
  const vertexCount = remapped.uArr.length;
  const encodedU = deltaEncodeQuantized(remapped.uArr);
  const encodedV = deltaEncodeQuantized(remapped.vArr);
  const encodedH = deltaEncodeQuantized(remapped.hArr);
  const [remappedWest, remappedSouth, remappedEast, remappedNorth] = remapped.edges;

  const triCount = remapped.indices.length / 3;
  const encodedIndices = highWaterMarkEncode(remapped.indices);

  // Calculate total buffer size
  // Header: 88 bytes
  // Vertex data: 4 + vertexCount * 6
  // Triangle indices: 4 (count) + triCount * 3 * 2
  // Edge indices: 4 * 4 (counts) + (west + south + east + north) * 2 bytes each
  const headerSize = 88;
  const vertexDataSize = 4 + vertexCount * 6;
  const triangleSize = 4 + triCount * 3 * 2;
  const edgeSize = 4 + remappedWest.length * 2 + 4 + remappedSouth.length * 2 +
                   4 + remappedEast.length * 2 + 4 + remappedNorth.length * 2;

  const buf = Buffer.alloc(headerSize + vertexDataSize + triangleSize + edgeSize);
  let off = 0;

  // Header (88 bytes)
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
  for (let i = 0; i < vertexCount; i++) { buf.writeUInt16LE(encodedU[i], off); off += 2; }
  for (let i = 0; i < vertexCount; i++) { buf.writeUInt16LE(encodedV[i], off); off += 2; }
  for (let i = 0; i < vertexCount; i++) { buf.writeUInt16LE(encodedH[i], off); off += 2; }

  // High LOD: triangle count (uint32) + high-water-mark encoded indices
  buf.writeUInt32LE(triCount, off); off += 4;
  for (let i = 0; i < encodedIndices.length; i++) { buf.writeUInt16LE(encodedIndices[i], off); off += 2; }

  // Edge indices: count (uint32) + indices (uint16 per vertex index)
  for (const edgeIndices of [remappedWest, remappedSouth, remappedEast, remappedNorth]) {
    buf.writeUInt32LE(edgeIndices.length, off); off += 4;
    for (let i = 0; i < edgeIndices.length; i++) { buf.writeUInt16LE(edgeIndices[i], off); off += 2; }
  }

  return buf.subarray(0, off);
}

export const encodeQuantizedMeshForTest = encodeQuantizedMesh;

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

type AvailableRange = { startX: number; startY: number; endX: number; endY: number };

interface CesiumTerrainLayerJsonOptions {
  minZoom: number;
  maxZoom: number;
  bbox: [number, number, number, number];
  available: AvailableRange[][];
}

function buildCesiumTerrainLayerJson(options: CesiumTerrainLayerJsonOptions): Record<string, unknown> {
  return {
    tilejson: '1.0',
    name: 'terrain',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    projection: 'EPSG:4326',
    minzoom: options.minZoom,
    maxzoom: options.maxZoom,
    bounds: options.bbox,
    tiles: ['{z}/{x}/{y}.terrain'],
    available: options.available,
  };
}

export const buildCesiumTerrainLayerJsonForTest = buildCesiumTerrainLayerJson;

function buildAvailableRanges(tileKeys: Set<string>): AvailableRange[] {
  const byY = new Map<number, number[]>();
  for (const key of tileKeys) {
    const [xText, yText] = key.split(',');
    const x = Number(xText);
    const y = Number(yText);
    const xs = byY.get(y) ?? [];
    xs.push(x);
    byY.set(y, xs);
  }

  const ranges: AvailableRange[] = [];
  for (const [y, xs] of [...byY.entries()].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    let startX = xs[0];
    let endX = xs[0];
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i];
      if (x === endX + 1) {
        endX = x;
      } else {
        ranges.push({ startX, startY: y, endX, endY: y });
        startX = x;
        endX = x;
      }
    }
    ranges.push({ startX, startY: y, endX, endY: y });
  }
  return ranges;
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

  let totalTiles = 0;
  let emptyTilesSkipped = 0;
  // Track written tiles per zoom level for the `available` array.
  // Use a Map so we only include zoom levels that actually have tiles.
  const availableByZoom = new Map<number, AvailableRange[]>();
  let actualMaxZoom = minZoom;

  for (let z = minZoom; z <= maxZoom; z++) {
    const range = tileRangeForBBox(dem.bbox, z);
    const tileCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    log.info(`Zoom ${z}: ${range.minX}-${range.maxX} x ${range.minY}-${range.maxY} (${tileCount} tiles)`);

    const writtenTiles = new Set<string>();

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
        // GeographicTilingScheme: nY = 2^z
        const nY = 1 << z;
        const tmsY = nY - 1 - y;
        const tileDir = path.join(opts.outputPath, String(z), String(x));
        fs.mkdirSync(tileDir, { recursive: true });
        fs.writeFileSync(path.join(tileDir, `${tmsY}.terrain`), terrain);
        totalTiles++;

        writtenTiles.add(`${x},${tmsY}`);
      }
    }

    // Record available range for this zoom level (only if tiles were written)
    if (writtenTiles.size > 0) {
      availableByZoom.set(z, buildAvailableRanges(writtenTiles));
      actualMaxZoom = z;
    }
  }

  // Build compact `available` array: entries from zoom 0 to actualMaxZoom,
  // only including levels that have tiles (empty array for gaps).
  const available: AvailableRange[][] = [];
  for (let z = 0; z <= actualMaxZoom; z++) {
    available.push(availableByZoom.get(z) ?? []);
  }

  // Write layer.json metadata for Cesium
  const layerJson = buildCesiumTerrainLayerJson({
    minZoom,
    maxZoom: actualMaxZoom,
    bbox: dem.bbox,
    available,
  });
  fs.writeFileSync(path.join(opts.outputPath, 'layer.json'), JSON.stringify(layerJson, null, 2));

  return { totalTiles, emptyTilesSkipped, minZoom, maxZoom: actualMaxZoom, outputPath: opts.outputPath };
}
