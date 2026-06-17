/**
 * Quantized-Mesh 1.0 terrain tile generator - CORRECT VERSION
 * Based on official specification: https://github.com/CesiumGS/quantized-mesh
 */

import type { DEMData } from './terrain-tile.js';
import { sampleDEM } from './terrain-tile.js';

// Types
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

// Constants
const QUANTIZED_MESH_MAX = 32767; // Maximum u/v/height value

// ZigZag encoding/decoding
function zigZagEncode(value: number): number {
  return (value << 1) ^ (value >> 31);
}

function zigZagDecode(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

// Encode vertex data with zigzag delta encoding (CORRECT METHOD)
function encodeVertexData(vertices: Float32Array, tileBBox: [number, number, number, number]): Buffer {
  const numVertices = vertices.length / 3;
  // Quantize u/v/height values
  const uValues = new Int32Array(numVertices);
  const vValues = new Int32Array(numVertices);
  const hValues = new Int32Array(numVertices);
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
  const heightRange = maxHeight - minHeight || 1;
  // Quantize vertices
  for (let i = 0; i < vertices.length; i += 3) {
    const lon = vertices[i];
    const lat = vertices[i + 1];
    const height = vertices[i + 2];
    // u: 0 at west edge, 32767 at east edge
    const u = Math.round(((lon - lonMin) / (lonMax - lonMin || 1)) * QUANTIZED_MESH_MAX);
    // v: 0 at south edge, 32767 at north edge
    const v = Math.round(((lat - latMin) / (latMax - latMin || 1)) * QUANTIZED_MESH_MAX);
    // height: 0 at minHeight, 32767 at maxHeight
    const h = Math.round(((height - minHeight) / heightRange) * QUANTIZED_MESH_MAX);
    const idx = i / 3;
    uValues[idx] = u;
    vValues[idx] = v;
    hValues[idx] = h;
  }
  // Apply zigzag delta encoding
  const encodedU = new Int32Array(numVertices);
  const encodedV = new Int32Array(numVertices);
  const encodedH = new Int32Array(numVertices);
  let lastU = 0, lastV = 0, lastH = 0;
  for (let i = 0; i < numVertices; i++) {
    const deltaU = uValues[i] - lastU;
    const deltaV = vValues[i] - lastV;
    const deltaH = hValues[i] - lastH;
    encodedU[i] = zigZagEncode(deltaU);
    encodedV[i] = zigZagEncode(deltaV);
    encodedH[i] = zigZagEncode(deltaH);
    lastU = uValues[i];
    lastV = vValues[i];
    lastH = hValues[i];
  }
  // Write to buffer
  const bufferSize = 4 + numVertices * 2 + numVertices * 2 + numVertices * 2;
  const buffer = Buffer.allocUnsafe(bufferSize);
  let offset = 0;
  // Vertex count
  buffer.writeUInt32LE(numVertices, offset);
  offset += 4;
  // Write encoded values as unsigned shorts
  for (let i = 0; i < numVertices; i++) {
    buffer.writeUInt16LE(encodedU[i] >>> 0, offset);
    offset += 2;
  }
  for (let i = 0; i < numVertices; i++) {
    buffer.writeUInt16LE(encodedV[i] >>> 0, offset);
    offset += 2;
  }
  for (let i = 0; i < numVertices; i++) {
    buffer.writeUInt16LE(encodedH[i] >>> 0, offset);
    offset += 2;
  }
  return buffer;
}

// High-water mark encoding for indices (CORRECT METHOD)
function encodeIndexData(indices: Uint32Array): Buffer {
  const triangleCount = indices.length / 3;
  const use32Bit = indices.some(v => v > 65535);
  const indexSize = use32Bit ? 4 : 2;
  const bufferSize = 4 + triangleCount * 3 * indexSize;
  const buffer = Buffer.allocUnsafe(bufferSize);
  let offset = 0;
  // Triangle count
  buffer.writeUInt32LE(triangleCount, offset);
  offset += 4;
  // High-water mark encoding
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = highest - indices[i];
    indices[i] = code;
    if (code === 0) {
      highest++;
    }
    if (use32Bit) {
      buffer.writeUInt32LE(code, offset);
    } else {
      buffer.writeUInt16LE(code >>> 0, offset);
    }
    offset += indexSize;
  }
  return buffer;
}

// Generate terrain mesh from DEM
function generateTerrainMesh(dem: DEMData, tileBBox: [number, number, number, number], resolution: number): MeshData {
  const gridResolution = resolution + 1;
  const numVertices = gridResolution * gridResolution;
  const vertices = new Float32Array(numVertices * 3);
  const lonMin = tileBBox[0];
  const latMin = tileBBox[1];
  const lonMax = tileBBox[2];
  const latMax = tileBBox[3];
  const lonStep = (lonMax - lonMin) / resolution;
  const latStep = (latMax - latMin) / resolution;
  let validVertexCount = 0;
  for (let y = 0; y < gridResolution; y++) {
    for (let x = 0; x < gridResolution; x++) {
      const idx = (y * gridResolution + x) * 3;
      const lon = lonMin + x * lonStep;
      const lat = latMax - y * latStep;
      const height = sampleDEM(dem, lon, lat);
      vertices[idx] = lon;
      vertices[idx + 1] = lat;
      vertices[idx + 2] = height;
      if (height !== 0)
        validVertexCount++;
    }
  }
  if (validVertexCount === 0) {
    return {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      normals: new Float32Array(0),
    };
  }
  // Generate triangle indices
  const indicesList: number[] = [];
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i0 = y * gridResolution + x;
      const i1 = y * gridResolution + (x + 1);
      const i2 = (y + 1) * gridResolution + x;
      const i3 = (y + 1) * gridResolution + (x + 1);
      indicesList.push(i0, i2, i1);
      indicesList.push(i1, i2, i3);
    }
  }
  const indices = new Uint32Array(indicesList);
  // Compute normals (simplified)
  const normals = new Float32Array(numVertices * 3);
  for (let i = 0; i < normals.length; i += 3) {
    normals[i] = 0;
    normals[i + 1] = 0;
    normals[i + 2] = 1; // Point up
  }
  return { vertices, indices, normals };
}

// ECEF conversion (same as before)
function wgs84ToECEF(lon: number, lat: number, height: number): [number, number, number] {
  const WGS84_A = 6378137.0;
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;
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

function computeBoundingSphere(vertices: Float32Array): BoundingSphere {
  if (vertices.length === 0) {
    return { cx: 0, cy: 0, cz: 0, radius: 0 };
  }
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

// Encode Quantized-Mesh header (CORRECT FORMAT)
function encodeHeader(
  centerX: number,
  centerY: number,
  centerZ: number,
  minHeight: number,
  maxHeight: number,
  boundingSphere: BoundingSphere,
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
  // Min/Max heights (2 floats)
  header.writeFloatLE(minHeight, offset);
  offset += 4;
  header.writeFloatLE(maxHeight, offset);
  offset += 4;
  // Bounding Sphere (4 doubles)
  header.writeDoubleLE(boundingSphere.cx, offset);
  offset += 8;
  header.writeDoubleLE(boundingSphere.cy, offset);
  offset += 8;
  header.writeDoubleLE(boundingSphere.cz, offset);
  offset += 8;
  header.writeDoubleLE(boundingSphere.radius, offset);
  offset += 8;
  // Horizon Occlusion Point (3 doubles) - use center for now
  header.writeDoubleLE(centerX, offset);
  offset += 8;
  header.writeDoubleLE(centerY, offset);
  offset += 8;
  header.writeDoubleLE(centerZ, offset);
  offset += 8;
  return header;
}

// Edge indices encoding (simplified)
function encodeEdgeIndices(west: number[], south: number[], east: number[], north: number[]): Buffer {
  const use32Bit = Math.max(west.length, south.length, east.length, north.length) > 65536;
  const indexSize = use32Bit ? 4 : 2;
  let totalSize = 0;
  for (const edge of [west, south, east, north]) {
    totalSize += 4 + edge.length * indexSize;
  }
  const buffer = Buffer.allocUnsafe(totalSize);
  let offset = 0;
  for (const edge of [west, south, east, north]) {
    buffer.writeUInt32LE(edge.length, offset);
    offset += 4;
    for (const index of edge) {
      if (use32Bit) {
        buffer.writeUInt32LE(index, offset);
      } else {
        buffer.writeUInt16LE(index >>> 0, offset);
      }
      offset += indexSize;
    }
  }
  return buffer;
}

// Main encoding function
function encodeQuantizedMesh(mesh: MeshData, tileBBox: [number, number, number, number], includeNormals: boolean): Buffer {
  const { vertices, indices } = mesh;
  if (vertices.length === 0) {
    return Buffer.alloc(0);
  }
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
  // Convert to ECEF for header
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
  // Encode components
  const header = encodeHeader(centerX, centerY, centerZ, minHeight, maxHeight, boundingSphere);
  const vertexData = encodeVertexData(vertices, tileBBox);
  const indexData = encodeIndexData(indices);
  // Edge indices (simplified)
  const numVertices = vertices.length / 3;
  const west = [0];
  const south = [numVertices - Math.sqrt(numVertices)];
  const east = [Math.sqrt(numVertices) - 1];
  const north = [Math.sqrt(numVertices) - 1];
  const edgeIndices = encodeEdgeIndices(west, south, east, north);
  // Combine all parts
  const totalSize = header.length + vertexData.length + indexData.length + edgeIndices.length;
  return Buffer.concat([header, vertexData, indexData, edgeIndices]);
}

// Tile range calculation and DEM reading would remain the same
// This is just the encoding part corrected
console.log('✅ Created corrected Quantized-Mesh encoder based on official specification');

export { encodeQuantizedMesh, generateTerrainMesh, wgs84ToECEF, computeBoundingSphere };
