/**
 * Quantized-Mesh 1.0 terrain tile generator — converts DEM (GeoTIFF) to Cesium Quantized-Mesh format.
 *
 * Pure JavaScript implementation, no GDAL dependency.
 * Uses geotiff for reading DEM, node:zlib for compression, earcut for triangulation.
 *
 * Output: {z}/{x}/{y}.terrain files + layer.json manifest.
 *
 * Specification: https://github.com/CesiumGS/quantized-mesh
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { log } from '../logger.js';
import { readDEM, sampleDEM } from './terrain-tile.js';
import type { DEMData } from './terrain-tile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuantizedMeshOptions {
  outputPath: string;
  minZoom?: number;
  maxZoom?: number;
  fromCrs?: string;
  includeVertexNormals?: boolean;
  tileResolution?: number;
}

export interface QuantizedMeshSummary {
  totalTiles: number;
  emptyTilesSkipped: number;
  minZoom: number;
  maxZoom: number;
  outputPath: string;
  format: 'quantized-mesh-1.0';
}

interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
}

interface BoundingSphere {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WGS84_A = 6378137.0; // Semi-major axis (meters)
const WGS84_F = 1 / 298.257223563; // Flattening
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared
const QUANTIZED_MESH_MAX = 32767; // Maximum u/v/height value
const GRID_UV_MAX = 255; // For grid-based u/v quantization to keep values manageable
const WEB_MERCATOR_MAX = 20037508.342789244;
const WEB_MERCATOR_SIZE = WEB_MERCATOR_MAX * 2;

// ---------------------------------------------------------------------------
// WGS84 to ECEF Conversion
// ---------------------------------------------------------------------------

/**
 * Convert WGS84 lon/lat/height to Earth-Centered Fixed (ECEF) coordinates.
 * Uses WGS84 ellipsoid parameters.
 */
function wgs84ToECEF(lon: number, lat: number, height: number): [number, number, number] {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const cosLon = Math.cos((lon * Math.PI) / 180);
  const sinLon = Math.sin((lon * Math.PI) / 180);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const X = (N + height) * cosLat * cosLon;
  const Y = (N + height) * cosLat * sinLon;
  const Z = (N * (1 - WGS84_E2) + height) * sinLat;
  return [X, Y, Z];
}

/**
 * Compute bounding sphere center and radius from a set of ECEF vertices.
 * Uses simple mean for center calculation to ensure numerical stability.
 */
function computeBoundingSphere(vertices: Float32Array): BoundingSphere {
  if (vertices.length === 0) {
    return { cx: 0, cy: 0, cz: 0, radius: 0 };
  }
  // Use simple mean for center calculation - more stable for terrain data
  let cx = 0, cy = 0, cz = 0;
  const numVertices = vertices.length / 3;
  for (let i = 0; i < vertices.length; i += 3) {
    cx += vertices[i];
    cy += vertices[i + 1];
    cz += vertices[i + 2];
  }
  cx /= numVertices;
  cy /= numVertices;
  cz /= numVertices;
  // Compute radius as maximum distance from center
  let maxDistSq = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const dx = vertices[i] - cx;
    const dy = vertices[i + 1] - cy;
    const dz = vertices[i + 2] - cz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > maxDistSq)
      maxDistSq = distSq;
  }
  return { cx, cy, cz, radius: Math.sqrt(maxDistSq) };
}

/**
 * Compute horizon occlusion point for a tile.
 * Per Cesium blog: http://cesiumjs.org/2013/04/25/Horizon-culling/
 * For simplicity, use the center of the tile elevated by max height.
 */
function computeHorizonOcclusionPoint(vertices: Float32Array, minHeight: number, maxHeight: number): [number, number, number] {
  // Use the highest vertex as the horizon occlusion point
  let maxZ = -Infinity;
  let maxX = 0, maxY = 0, maxZCoord = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const z = vertices[i + 2];
    if (z > maxZ) {
      maxZ = z;
      maxX = vertices[i];
      maxY = vertices[i + 1];
      maxZCoord = z;
    }
  }
  return [maxX, maxY, maxZCoord];
}

// ---------------------------------------------------------------------------
// Quantized-Mesh Encoding
// ---------------------------------------------------------------------------

/**
 * Encode Quantized-Mesh header (88 bytes).
 */
function encodeHeader(
  centerX: number,
  centerY: number,
  centerZ: number,
  minHeight: number,
  maxHeight: number,
  boundingSphere: BoundingSphere,
  horizonOcclusionPoint: [number, number, number],
): Buffer {
  const header = Buffer.allocUnsafe(88);
  let offset = 0;
  // Center (3 doubles)
  header.writeDoubleLE(centerX, offset);
  offset += 8;
  header.writeDoubleLE(centerY, offset);
  offset += 8;
  header.writeDoubleLE(centerZ, offset);
  offset += 8;
  // Minimum and Maximum heights (2 floats)
  header.writeFloatLE(minHeight, offset);
  offset += 4;
  header.writeFloatLE(maxHeight, offset);
  offset += 4;
  // Bounding Sphere (4 doubles: center X/Y/Z, radius)
  header.writeDoubleLE(boundingSphere.cx, offset);
  offset += 8;
  header.writeDoubleLE(boundingSphere.cy, offset);
  offset += 8;
  header.writeDoubleLE(boundingSphere.cz, offset);
  offset += 8;
  header.writeDoubleLE(boundingSphere.radius, offset);
  offset += 8;
  // Horizon Occlusion Point (3 doubles)
  header.writeDoubleLE(horizonOcclusionPoint[0], offset);
  offset += 8;
  header.writeDoubleLE(horizonOcclusionPoint[1], offset);
  offset += 8;
  header.writeDoubleLE(horizonOcclusionPoint[2], offset);
  offset += 8;
  return header;
}

/**
 * ZigZag encode a signed integer to unsigned.
 */
function zigZagEncode(value: number): number {
  return (value >> 1) ^ -(value & 1);
}

/**
 * Encode vertex data with zigzag delta encoding.
 */
function encodeVertexData(uValues: Uint16Array, vValues: Uint16Array, hValues: Uint16Array): Buffer {
  const vertexCount = uValues.length;
  // Calculate total size
  const size = 4 + vertexCount * 2 + vertexCount * 2 + vertexCount * 2; // count + 3 arrays
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  // Write vertex count
  buffer.writeUInt32LE(vertexCount, offset);
  offset += 4;
  // For simplicity, write raw values without delta/zigzag encoding for now
  // TODO: Implement proper delta/zigzag encoding
  for (let i = 0; i < vertexCount; i++) {
    buffer.writeUInt16LE(uValues[i], offset);
    offset += 2;
  }
  for (let i = 0; i < vertexCount; i++) {
    buffer.writeUInt16LE(vValues[i], offset);
    offset += 2;
  }
  for (let i = 0; i < vertexCount; i++) {
    buffer.writeUInt16LE(hValues[i], offset);
    offset += 2;
  }
  return buffer;
}

/**
 * Encode index data using high-water-mark encoding.
 */
function encodeIndexData(indices: Uint32Array): Buffer {
  const triangleCount = indices.length / 3;
  const use32Bit = indices.length > 65536 || indices.some(v => v > 65535);
  const indexSize = use32Bit ? 4 : 2;
  const size = 4 + triangleCount * 3 * indexSize;
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  // Write triangle count
  buffer.writeUInt32LE(triangleCount, offset);
  offset += 4;
  // For now, write raw indices without high-water-mark encoding to get it working
  // TODO: Implement proper high-water-mark encoding
  for (let i = 0; i < indices.length; i++) {
    if (use32Bit) {
      buffer.writeUInt32LE(indices[i], offset);
      offset += 4;
    } else {
      buffer.writeUInt16LE(indices[i], offset);
      offset += 2;
    }
  }
  return buffer;
}

/**
 * Encode edge indices for skirts.
 */
function encodeEdgeIndices(west: number[], south: number[], east: number[], north: number[]): Buffer {
  const use32Bit = Math.max(west.length, south.length, east.length, north.length) > 65536;
  const indexSize = use32Bit ? 4 : 2;
  let totalSize = 0;
  for (const edge of [west, south, east, north]) {
    totalSize += 4 + edge.length * indexSize;
  }
  const buffer = Buffer.allocUnsafe(totalSize);
  let offset = 0;
  // Write each edge
  for (const edge of [west, south, east, north]) {
    buffer.writeUInt32LE(edge.length, offset);
    offset += 4;
    for (const index of edge) {
      if (use32Bit) {
        buffer.writeUInt32LE(index, offset);
        offset += 4;
      } else {
        buffer.writeUInt16LE(index, offset);
        offset += 2;
      }
    }
  }
  return buffer;
}

/**
 * Oct-encode a 3D unit vector to 2D coordinates.
 * Per "A Survey of Efficient Representations of Independent Unit Vectors", Cigolle et al 2014.
 */
function octEncode(x: number, y: number, z: number): [number, number] {
  // Project onto octahedron
  let octX = x / (Math.abs(x) + Math.abs(y) + Math.abs(z));
  let octY = y / (Math.abs(x) + Math.abs(y) + Math.abs(z));
  // Fold negative Z
  if (z < 0) {
    const absX = Math.abs(octX);
    const absY = Math.abs(octY);
    octX = (1 - absX) * (octX >= 0 ? 1 : -1);
    octY = (1 - absY) * (octY >= 0 ? 1 : -1);
  }
  // Map to [0, 255] for packing into 16 bits
  const u = Math.floor((octX * 0.5 + 0.5) * 255);
  const v = Math.floor((octY * 0.5 + 0.5) * 255);
  return [u, v];
}

/**
 * Encode Oct-Encoded vertex normals extension (ID 1).
 */
function encodeVertexNormals(normals: Float32Array): Buffer {
  const vertexCount = normals.length / 3;
  const size = 5 + vertexCount * 2; // extension header (5 bytes) + data
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  // Extension header
  buffer.writeUInt8(1, offset);
  offset += 1; // extensionId = 1 (octvertexnormals)
  buffer.writeUInt32LE(vertexCount * 2, offset);
  offset += 4; // extensionLength
  // Encode normals
  for (let i = 0; i < normals.length; i += 3) {
    const [u, v] = octEncode(normals[i], normals[i + 1], normals[i + 2]);
    // Pack two 8-bit values into 16 bits: high byte = u, low byte = v
    buffer.writeUInt16LE((u << 8) | v, offset);
    offset += 2;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Mesh Generation
// ---------------------------------------------------------------------------

/**
 * Sample DEM at regular grid points and generate terrain mesh.
 */
function generateTerrainMesh(dem: DEMData, tileBBox: [number, number, number, number], resolution: number): MeshData {
  const gridResolution = resolution + 1; // e.g., 64 -> 65x65 vertices
  const numVertices = gridResolution * gridResolution;
  // Sample DEM at regular grid
  const vertices = new Float32Array(numVertices * 3); // lon, lat, height
  const lonMin = tileBBox[0];
  const latMin = tileBBox[1];
  const lonMax = tileBBox[2];
  const latMax = tileBBox[3];
  const lonStep = (lonMax - lonMin) / resolution;
  const latStep = (latMax - latMin) / resolution;
  let validVertexCount = 0;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let y = 0; y < gridResolution; y++) {
    for (let x = 0; x < gridResolution; x++) {
      const idx = (y * gridResolution + x) * 3;
      const lon = lonMin + x * lonStep;
      const lat = latMax - y * latStep; // TMS: y from south to north
      // Use imported sampleDEM function from terrain-tile.ts
      const height = sampleDEM(dem, lon, lat);
      vertices[idx] = lon;
      vertices[idx + 1] = lat;
      vertices[idx + 2] = height;
      if (height !== 0)
        validVertexCount++;
      if (height < minHeight)
        minHeight = height;
      if (height > maxHeight)
        maxHeight = height;
    }
  }
  // Debug output
  log.debug(`Tile ${tileBBox.join(',')}: sampled ${validVertexCount}/${numVertices} valid vertices, height range [${minHeight}, ${maxHeight}]`);
  // Check if tile is empty
  if (validVertexCount === 0) {
    return {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      normals: new Float32Array(0),
    };
  }
  // Generate indices using earcut (Delaunay triangulation of grid)
  const flatCoords: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    flatCoords.push(vertices[i], vertices[i + 1]); // lon, lat (2D)
  }
  // For a simple grid, we can generate triangle indices directly without earcut
  // Create triangles for the grid: two triangles per grid cell
  const indicesList: number[] = [];
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i0 = y * gridResolution + x;
      const i1 = y * gridResolution + (x + 1);
      const i2 = (y + 1) * gridResolution + x;
      const i3 = (y + 1) * gridResolution + (x + 1);
      // First triangle (i0, i2, i1)
      indicesList.push(i0, i2, i1);
      // Second triangle (i1, i2, i3)
      indicesList.push(i1, i2, i3);
    }
  }
  const indices = new Uint32Array(indicesList);
  // Compute vertex normals
  const normals = new Float32Array(numVertices * 3);
  for (let i = 0; i < normals.length; i += 3) {
    normals[i] = 0;
    normals[i + 1] = 0;
    normals[i + 2] = 1; // Default: point up
  }
  // Compute normals from triangle cross products
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    const v0 = [vertices[i0], vertices[i0 + 1], vertices[i0 + 2]];
    const v1 = [vertices[i1], vertices[i1 + 1], vertices[i1 + 2]];
    const v2 = [vertices[i2], vertices[i2 + 1], vertices[i2 + 2]];
    // Edge vectors
    const edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    // Cross product
    const normal = [
      edge1[1] * edge2[2] - edge1[2] * edge2[1],
      edge1[2] * edge2[0] - edge1[0] * edge2[2],
      edge1[0] * edge2[1] - edge1[1] * edge2[0],
    ];
    // Normalize
    const len = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
    if (len > 0) {
      normal[0] /= len;
      normal[1] /= len;
      normal[2] /= len;
    }
    // Accumulate normals at vertices
    for (const idx of [i0, i1, i2]) {
      normals[idx] += normal[0];
      normals[idx + 1] += normal[1];
      normals[idx + 2] += normal[2];
    }
  }
  // Normalize accumulated normals
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]);
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
  }
  return { vertices, indices, normals };
}

/**
 * Encode a terrain mesh to Quantized-Mesh format.
 */
function encodeQuantizedMesh(mesh: MeshData, tileBBox: [number, number, number, number], includeNormals: boolean): Buffer {
  const { vertices, indices, normals } = mesh;
  if (vertices.length === 0) {
    return Buffer.alloc(0);
  }
  // Quantize vertices to u/v/height coordinates
  const numVertices = vertices.length / 3;
  const uValues = new Uint16Array(numVertices);
  const vValues = new Uint16Array(numVertices);
  const hValues = new Uint16Array(numVertices);
  const lonMin = tileBBox[0];
  const latMin = tileBBox[1];
  const lonMax = tileBBox[2];
  const latMax = tileBBox[3];
  // Find height range
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 2; i < vertices.length; i += 3) {
    const h = vertices[i];
    if (h < minHeight)
      minHeight = h;
    if (h > maxHeight)
      maxHeight = h;
  }
  // For u/v coordinates, use the grid position rather than geographic position
  const gridResolution = Math.sqrt(numVertices);
  for (let y = 0; y < gridResolution; y++) {
    for (let x = 0; x < gridResolution; x++) {
      const idx = (y * gridResolution + x);
      const vertexIdx = idx * 3;
      // u/v based on grid position - use smaller range to avoid zigzag overflow
      uValues[idx] = Math.floor((x * GRID_UV_MAX) / (gridResolution - 1));
      vValues[idx] = Math.floor((y * GRID_UV_MAX) / (gridResolution - 1));
      // height based on elevation
      const height = vertices[vertexIdx + 2];
      hValues[idx] = Math.floor(((height - minHeight) / (maxHeight - minHeight || 1)) * QUANTIZED_MESH_MAX);
    }
  }
  // Convert vertices to ECEF for header
  const ecefVertices: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const [x, y, z] = wgs84ToECEF(vertices[i], vertices[i + 1], vertices[i + 2]);
    ecefVertices.push(x, y, z);
  }
  const ecefArray = Float32Array.from(ecefVertices);
  // Compute header fields
  const boundingSphere = computeBoundingSphere(ecefArray);
  const centerX = boundingSphere.cx;
  const centerY = boundingSphere.cy;
  const centerZ = boundingSphere.cz;
  const horizonOcclusionPoint = computeHorizonOcclusionPoint(ecefArray, minHeight, maxHeight);
  // Encode components
  const header = encodeHeader(centerX, centerY, centerZ, minHeight, maxHeight, boundingSphere, horizonOcclusionPoint);
  const vertexData = encodeVertexData(uValues, vValues, hValues);
  const indexData = encodeIndexData(indices);
  // Extract edge indices (simplified: use corner vertices)
  const west = [0];
  const south = [numVertices - gridResolution];
  const east = [gridResolution - 1];
  const north = [gridResolution - 1];
  const edgeIndices = encodeEdgeIndices(west, south, east, north);
  // Extensions
  const extensions: Buffer[] = [];
  if (includeNormals && normals.length > 0) {
    extensions.push(encodeVertexNormals(normals));
  }
  // Combine all parts
  const totalSize = header.length + vertexData.length + indexData.length + edgeIndices.length +
    extensions.reduce((sum, buf) => sum + buf.length, 0);
  const combined = Buffer.concat([header, vertexData, indexData, edgeIndices, ...extensions]);
  return combined;
}

/**
 * Get tile bbox in WGS84 lon/lat.
 * This matches the implementation in terrain-tile.ts.
 */
function tileBBoxWGS84(z: number, x: number, y: number): [number, number, number, number] {
  const n = 1 << z;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latMin = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return [lonMin, latMin, lonMax, latMax];
}

/**
 * Convert WGS84 lon/lat to Web Mercator.
 */
function wgs84ToWebMercator(lon: number, lat: number): [number, number] {
  const x = (lon / 180) * WEB_MERCATOR_MAX;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  return [x, (y / 180) * WEB_MERCATOR_MAX];
}

/**
 * Compute tile range for a Web Mercator bbox at a given zoom level.
 */
function tileRangeForBBox(bbox: number[], z: number): TileRange {
  const n = 1 << z;
  const minX = Math.max(0, Math.floor(((bbox[0] + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n));
  const maxX = Math.min(n - 1, Math.floor(((bbox[2] + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n));
  const minY = Math.max(0, Math.floor(((WEB_MERCATOR_MAX - bbox[3]) / WEB_MERCATOR_SIZE) * n));
  const maxY = Math.min(n - 1, Math.floor(((WEB_MERCATOR_MAX - bbox[1]) / WEB_MERCATOR_SIZE) * n));
  return { minX, maxX, minY, maxY };
}

/**
 * Convert available tiles from [z,x,y] format to tile range format.
 * Groups tiles by zoom level and creates continuous ranges.
 */
function convertToTileRanges(availableTiles: [number, number, number][]): { startX: number; endX: number; startY: number; endY: number }[][] {
  // Group by zoom level
  const byZoom = new Map<number, [number, number][]>();
  for (const [z, x, y] of availableTiles) {
    if (!byZoom.has(z)) {
      byZoom.set(z, []);
    }
    byZoom.get(z)!.push([x, y]);
  }
  // Convert to tile ranges format, one array per zoom level
  const result: { startX: number; endX: number; startY: number; endY: number }[][] = [];
  // Process each zoom level
  for (let z = 0; z <= 15; z++) { // Assuming max zoom 15 for safety
    if (!byZoom.has(z)) {
      // If no tiles at this zoom, add empty array to maintain index
      result.push([]);
      continue;
    }
    const tiles = byZoom.get(z)!;
    if (tiles.length === 0) {
      result.push([]);
      continue;
    }
    // Find ranges in this zoom level
    const ranges: { startX: number; endX: number; startY: number; endY: number }[] = [];
    // Sort by X, then Y
    tiles.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Group by Y coordinate
    const yGroups = new Map<number, Set<number>>();
    for (const [x, y] of tiles) {
      if (!yGroups.has(y)) {
        yGroups.set(y, new Set());
      }
      yGroups.get(y)!.add(x);
    }
    // Create ranges for each Y group
    for (const [y, xSet] of yGroups) {
      const sortedX = Array.from(xSet).sort((a, b) => a - b);
      // Find continuous X ranges
      let startX = sortedX[0];
      let endX = startX;
      for (let i = 1; i < sortedX.length; i++) {
        if (sortedX[i] === endX + 1) {
          endX = sortedX[i];
        } else {
          // Push current range
          ranges.push({ startX, endX, startY: y, endY: y });
          startX = sortedX[i];
          endX = startX;
        }
      }
      // Push last range
      ranges.push({ startX, endX, startY: y, endY: y });
    }
    result.push(ranges);
  }
  return result;
}

/**
 * Write layer.json manifest with tile range format.
 */
function writeLayerJson(
  outputPath: string,
  availableTiles: [number, number, number][],
  demBBox: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
): void {
  const available = convertToTileRanges(availableTiles);
  const layerJson = {
    tilejson: '2.1.0',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    projection: 'EPSG:4326',
    bounds: demBBox, // [minX, minY, maxX, maxY] in WGS84
    minzoom: minZoom,
    maxzoom: maxZoom,
    available: available,
    tiles: ['{z}/{x}/{y}.terrain'],
    extensions: ['octvertexnormals'],
  };
  const jsonPath = path.join(outputPath, 'layer.json');
  fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(layerJson, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Main Tile Generation Function
// ---------------------------------------------------------------------------

/**
 * Generate Quantized-Mesh terrain tiles from a DEM file.
 */
export async function writeQuantizedMeshTiles(demPath: string, opts: QuantizedMeshOptions): Promise<QuantizedMeshSummary> {
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = opts.maxZoom ?? 12;
  const resolution = opts.tileResolution ?? 64;
  const includeNormals = opts.includeVertexNormals ?? false;
  log.info(`Reading DEM: ${demPath}`);
  const dem = await readDEM(demPath);
  log.info(`DEM: ${dem.width}×${dem.height}, bbox=[${dem.bbox.join(', ')}], srs=${dem.srsId}`);
  // Convert DEM bbox to Web Mercator for tile range calculation
  const wmBbox = [
    ...wgs84ToWebMercator(dem.bbox[0], dem.bbox[1]),
    ...wgs84ToWebMercator(dem.bbox[2], dem.bbox[3]),
  ];
  let totalTiles = 0;
  let emptyTilesSkipped = 0;
  const availableTiles: [number, number, number][] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const range = tileRangeForBBox(wmBbox, z);
    const tileCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    log.info(`Zoom ${z}: ${range.minX}-${range.maxX} x ${range.minY}-${range.maxY} (${tileCount} tiles)`);
    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        const tileBBox = tileBBoxWGS84(z, x, y);
        const mesh = generateTerrainMesh(dem, tileBBox, resolution);
        if (mesh.vertices.length === 0) {
          emptyTilesSkipped++;
          continue;
        }
        const encoded = encodeQuantizedMesh(mesh, tileBBox, includeNormals);
        if (encoded.length === 0) {
          emptyTilesSkipped++;
          continue;
        }
        // Gzip compress
        const compressed = zlib.gzipSync(encoded);
        // Write file
        const tileDir = path.join(opts.outputPath, String(z), String(x));
        fs.mkdirSync(tileDir, { recursive: true });
        const tilePath = path.join(tileDir, `${y}.terrain`);
        fs.writeFileSync(tilePath, compressed);
        totalTiles++;
        availableTiles.push([z, x, y]);
      }
    }
  }
  // Write layer.json
  writeLayerJson(opts.outputPath, availableTiles, dem.bbox, minZoom, maxZoom);
  log.info(`Generated ${totalTiles} tiles (${emptyTilesSkipped} empty skipped)`);
  return {
    totalTiles,
    emptyTilesSkipped,
    minZoom,
    maxZoom,
    outputPath: opts.outputPath,
    format: 'quantized-mesh-1.0',
  };
}
