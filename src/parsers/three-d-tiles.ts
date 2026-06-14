/**
 * 3D Tiles (b3dm) generator.
 *
 * Converts building footprints (Polygon/MultiPolygon) with a height field
 * into 3D Tiles (.b3dm) with optional DEM elevation support.
 *
 * Pure TypeScript implementation — hand-rolled GLB and B3DM encoders,
 * uses earcut for polygon triangulation.
 *
 * Output: tileset.json + {outputPath}/tiles/*.b3dm
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import earcut from 'earcut';
import { fromFile, type GeoTIFFImage } from 'geotiff';
import type { BBox, Feature, Geometry, ParseResult, Properties } from '../types.js';
import { transformCoord } from '../crs.js';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245;
const DEG_TO_RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreeDTilesOptions {
  outputPath: string;
  heightField: string;
  color?: [number, number, number, number];
  fromCrs?: string;
  demPath?: string;
  maxZoom?: number;
  maxFeaturesPerTile?: number;
}

export interface ThreeDTilesSummary {
  totalBuildings: number;
  totalTiles: number;
  demUsed: boolean;
  bbox: BBox;
  outputPath: string;
}

interface BuildingModel {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  properties: Properties;
  bbox3d: [number, number, number, number, number, number]; // minX,minY,minZ,maxX,maxY,maxZ
}

interface TileNode {
  bbox: BBox;
  buildings: BuildingModel[];
  children?: TileNode[];
  geometricError: number;
}

interface DEMData {
  width: number;
  height: number;
  bbox: [number, number, number, number];
  data: Float32Array | Int16Array;
  nodata: number;
}

// ---------------------------------------------------------------------------
// WGS84 <-> ECEF
// ---------------------------------------------------------------------------

function wgs84ToEcef(lon: number, lat: number, h: number): [number, number, number] {
  const lonRad = lon * DEG_TO_RAD;
  const latRad = lat * DEG_TO_RAD;
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);
  const e2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const nu = WGS84_A / Math.sqrt(1 - e2 * sinLat * sinLat);
  return [
    (nu + h) * cosLat * cosLon,
    (nu + h) * cosLat * sinLon,
    (nu * (1 - e2) + h) * sinLat,
  ];
}

// ---------------------------------------------------------------------------
// DEM reader
// ---------------------------------------------------------------------------

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
// Polygon extrusion
// ---------------------------------------------------------------------------

function extrudePolygon(
  rings: number[][][],
  height: number,
  groundHeight: number,
  centerEcef: [number, number, number],
): BuildingModel | null {
  // rings[0] = outer ring, rings[1..] = holes
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;
  if (height <= 0) return null;

  // earcut input: flat coords + hole indices
  const coords: number[] = [];
  const holeIndices: number[] = [];
  for (const ring of rings) {
    if (coords.length > 0 && ring === rings[rings.indexOf(ring)]) {
      // skip first ring (outer)
    }
    for (const pt of ring) {
      coords.push(pt[0], pt[1]);
    }
  }
  // Rebuild properly: flat array with hole indices
  const flatCoords: number[] = [];
  const holes: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    if (i > 0) holes.push(flatCoords.length / 2);
    for (const pt of rings[i]) {
      flatCoords.push(pt[0], pt[1]);
    }
  }

  const triIndices = earcut(flatCoords, holes.length > 0 ? holes : undefined, 2);
  if (triIndices.length === 0) return null;

  const ringLen = rings[0].length;
  const baseZ = groundHeight;
  const topZ = groundHeight + height;

  // Collect all vertices: bottom + top
  const vertexCount = ringLen * 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);

  // Bottom ring (z = baseZ)
  for (let i = 0; i < ringLen; i++) {
    const [lon, lat] = rings[0][i];
    const [ex, ey, ez] = wgs84ToEcef(lon, lat, baseZ);
    positions[i * 3] = ex - centerEcef[0];
    positions[i * 3 + 1] = ey - centerEcef[1];
    positions[i * 3 + 2] = ez - centerEcef[2];
    normals[i * 3] = 0;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = -1;
  }
  // Top ring (z = topZ)
  for (let i = 0; i < ringLen; i++) {
    const [lon, lat] = rings[0][i];
    const [ex, ey, ez] = wgs84ToEcef(lon, lat, topZ);
    positions[(ringLen + i) * 3] = ex - centerEcef[0];
    positions[(ringLen + i) * 3 + 1] = ey - centerEcef[1];
    positions[(ringLen + i) * 3 + 2] = ez - centerEcef[2];
    normals[(ringLen + i) * 3] = 0;
    normals[(ringLen + i) * 3 + 1] = 0;
    normals[(ringLen + i) * 3 + 2] = 1;
  }

  // Build index buffer: bottom cap + top cap + sides
  const allIndices: number[] = [];

  // Bottom cap (reverse winding)
  for (let i = 0; i < triIndices.length; i += 3) {
    allIndices.push(triIndices[i], triIndices[i + 2], triIndices[i + 1]);
  }
  // Top cap
  for (let i = 0; i < triIndices.length; i += 3) {
    allIndices.push(triIndices[i] + ringLen, triIndices[i + 1] + ringLen, triIndices[i + 2] + ringLen);
  }
  // Side walls
  for (let i = 0; i < ringLen; i++) {
    const next = (i + 1) % ringLen;
    const b0 = i, b1 = next;
    const t0 = ringLen + i, t1 = ringLen + next;
    // Two triangles per wall segment
    allIndices.push(b0, b1, t1);
    allIndices.push(b0, t1, t0);
    // Compute face normal
    const p0 = [positions[b0 * 3], positions[b0 * 3 + 1], positions[b0 * 3 + 2]];
    const p1 = [positions[b1 * 3], positions[b1 * 3 + 1], positions[b1 * 3 + 2]];
    const p2 = [positions[t1 * 3], positions[t1 * 3 + 1], positions[t1 * 3 + 2]];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    // Assign same normal to all 4 wall vertices
    for (const vi of [b0, b1, t0, t1]) {
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
    }
  }

  // Compute 3D bbox
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    minX = Math.min(minX, positions[i * 3]);
    minY = Math.min(minY, positions[i * 3 + 1]);
    minZ = Math.min(minZ, positions[i * 3 + 2]);
    maxX = Math.max(maxX, positions[i * 3]);
    maxY = Math.max(maxY, positions[i * 3 + 1]);
    maxZ = Math.max(maxZ, positions[i * 3 + 2]);
  }

  return {
    positions,
    normals,
    indices: new Uint32Array(allIndices),
    properties: {},
    bbox3d: [minX, minY, minZ, maxX, maxY, maxZ],
  };
}

// ---------------------------------------------------------------------------
// Merge multiple buildings into one mesh
// ---------------------------------------------------------------------------

function mergeBuildings(buildings: BuildingModel[]): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
} {
  let totalVerts = 0;
  let totalIdx = 0;
  for (const b of buildings) {
    totalVerts += b.positions.length / 3;
    totalIdx += b.indices.length;
  }
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIdx);
  let vOff = 0;
  let iOff = 0;
  let vBase = 0;
  for (const b of buildings) {
    positions.set(b.positions, vOff * 3);
    normals.set(b.normals, vOff * 3);
    for (let i = 0; i < b.indices.length; i++) {
      indices[iOff + i] = b.indices[i] + vBase;
    }
    vOff += b.positions.length / 3;
    vBase += b.positions.length / 3;
    iOff += b.indices.length;
  }
  return { positions, normals, indices };
}

// ---------------------------------------------------------------------------
// GLB encoder (hand-rolled, zero dependency)
// ---------------------------------------------------------------------------

function encodeGLB(mesh: {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}, color?: [number, number, number, number]): Buffer {
  const { positions, normals, indices } = mesh;
  const posBytes = positions.buffer.slice(
    positions.byteOffset,
    positions.byteOffset + positions.byteLength,
  ) as ArrayBuffer;
  const normBytes = normals.buffer.slice(
    normals.byteOffset,
    normals.byteOffset + normals.byteLength,
  ) as ArrayBuffer;
  const idxBytes = indices.buffer.slice(
    indices.byteOffset,
    indices.byteOffset + indices.byteLength,
  ) as ArrayBuffer;

  const posBuf = Buffer.from(posBytes);
  const normBuf = Buffer.from(normBytes);
  const idxBuf = Buffer.from(idxBytes);

  // Buffer layout: positions | normals | indices (each 4-byte aligned)
  const posOffset = 0;
  const normOffset = posBuf.length;
  const idxOffset = normOffset + normBuf.length;
  const binTotal = idxOffset + idxBuf.length;
  // Pad binary to 4-byte alignment
  const binPadded = binTotal + (4 - (binTotal % 4)) % 4;

  const vertexCount = positions.length / 3;
  const indexCount = indices.length;

  // Compute bounds for position accessor
  let pMinX = Infinity, pMinY = Infinity, pMinZ = Infinity;
  let pMaxX = -Infinity, pMaxY = -Infinity, pMaxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    pMinX = Math.min(pMinX, positions[i * 3]);
    pMinY = Math.min(pMinY, positions[i * 3 + 1]);
    pMinZ = Math.min(pMinZ, positions[i * 3 + 2]);
    pMaxX = Math.max(pMaxX, positions[i * 3]);
    pMaxY = Math.max(pMaxY, positions[i * 3 + 1]);
    pMaxZ = Math.max(pMaxZ, positions[i * 3 + 2]);
  }

  const gltfJson: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: color ?? [1, 1, 1, 1],
        metallicFactor: 0.0,
        roughnessFactor: 1.0,
      },
    }],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: 'VEC3',
        max: [pMaxX, pMaxY, pMaxZ],
        min: [pMinX, pMinY, pMinZ],
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        byteOffset: 0,
        componentType: 5125, // UNSIGNED_INT
        count: indexCount,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: normOffset, byteLength: normBuf.length, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBuf.length, target: 34963 },
    ],
    buffers: [{ byteLength: binPadded }],
  };

  const jsonStr = JSON.stringify(gltfJson);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  // Pad JSON to 4-byte alignment with spaces
  const jsonPadded = jsonBuf.length + (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.alloc(jsonPadded, 0x20); // fill with space
  jsonBuf.copy(jsonChunk);

  // Build binary chunk (padded with zeros)
  const binChunk = Buffer.alloc(binPadded, 0);
  posBuf.copy(binChunk, posOffset);
  normBuf.copy(binChunk, normOffset);
  idxBuf.copy(binChunk, idxOffset);

  // GLB: header(12) + jsonChunkHeader(8) + jsonChunk + binChunkHeader(8) + binChunk
  const glbLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(glbLength);
  let off = 0;
  // GLB header
  glb.writeUInt32LE(0x46546C67, off); off += 4; // magic "glTF"
  glb.writeUInt32LE(2, off); off += 4;           // version 2
  glb.writeUInt32LE(glbLength, off); off += 4;
  // JSON chunk
  glb.writeUInt32LE(jsonChunk.length, off); off += 4;
  glb.writeUInt32LE(0x4E4F534A, off); off += 4; // "JSON"
  jsonChunk.copy(glb, off); off += jsonChunk.length;
  // BIN chunk
  glb.writeUInt32LE(binChunk.length, off); off += 4;
  glb.writeUInt32LE(0x004E4942, off); off += 4; // "BIN\0"
  binChunk.copy(glb, off);

  return glb;
}

// ---------------------------------------------------------------------------
// B3DM encoder (hand-rolled)
// ---------------------------------------------------------------------------

function encodeB3DM(
  glbData: Buffer,
  batchLength: number,
  batchTable?: Record<string, unknown[]>,
): Buffer {
  // Feature table JSON
  const featureTableJson = JSON.stringify({ BATCH_LENGTH: batchLength });
  const ftJsonBuf = Buffer.from(featureTableJson, 'utf8');
  const ftJsonPadded = ftJsonBuf.length + (4 - (ftJsonBuf.length % 4)) % 4;
  const ftJson = Buffer.alloc(ftJsonPadded, 0x20);
  ftBuf_copy(ftJson, ftJsonBuf, 0);

  // Feature table binary (empty)
  const ftBinLen = 0;

  // Batch table JSON
  let btJson: Buffer;
  if (batchTable && Object.keys(batchTable).length > 0) {
    const btStr = JSON.stringify(batchTable);
    const btBuf = Buffer.from(btStr, 'utf8');
    const btPadded = btBuf.length + (4 - (btBuf.length % 4)) % 4;
    btJson = Buffer.alloc(btPadded, 0x20);
    btBuf.copy(btJson);
  } else {
    btJson = Buffer.alloc(0);
  }
  const btBinLen = 0;

  // Total length
  const headerLen = 28;
  const totalLen = headerLen + ftJson.length + ftBinLen + btJson.length + btBinLen + glbData.length;

  const b3dm = Buffer.alloc(totalLen);
  let off = 0;
  // Header
  b3dm.write('b3dm', off); off += 4;
  b3dm.writeUInt32LE(1, off); off += 4; // version
  b3dm.writeUInt32LE(totalLen, off); off += 4;
  b3dm.writeUInt32LE(ftJson.length, off); off += 4;
  b3dm.writeUInt32LE(ftBinLen, off); off += 4;
  b3dm.writeUInt32LE(btJson.length, off); off += 4;
  b3dm.writeUInt32LE(btBinLen, off); off += 4;
  // Feature table JSON
  ftJson.copy(b3dm, off); off += ftJson.length;
  // Batch table JSON
  btJson.copy(b3dm, off); off += btJson.length;
  // GLB
  glbData.copy(b3dm, off);

  return b3dm;
}

function ftBuf_copy(target: Buffer, source: Buffer, offset: number): void {
  source.copy(target, offset);
}

// ---------------------------------------------------------------------------
// tileset.json generator
// ---------------------------------------------------------------------------

function computeBBox(buildings: BuildingModel[]): BBox {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of buildings) {
    minX = Math.min(minX, b.bbox3d[0]);
    minY = Math.min(minY, b.bbox3d[1]);
    minZ = Math.min(minZ, b.bbox3d[2]);
    maxX = Math.max(maxX, b.bbox3d[3]);
    maxY = Math.max(maxY, b.bbox3d[4]);
    maxZ = Math.max(maxZ, b.bbox3d[5]);
  }
  return [minX, minY, minZ, maxX, maxY, maxZ] as unknown as BBox;
}

function bboxToBoxVolume(bbox: [number, number, number, number, number, number]): number[] {
  // 3D Tiles boundingVolume.box: center(3) + xHalf(3) + yHalf(3) + zHalf(3)
  const cx = (bbox[0] + bbox[3]) / 2;
  const cy = (bbox[1] + bbox[4]) / 2;
  const cz = (bbox[2] + bbox[5]) / 2;
  const hx = (bbox[3] - bbox[0]) / 2;
  const hy = (bbox[4] - bbox[1]) / 2;
  const hz = (bbox[5] - bbox[2]) / 2;
  return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz];
}

// ---------------------------------------------------------------------------
// Spatial tiling (quadtree, index-based to avoid copying large arrays)
// ---------------------------------------------------------------------------

function buildQuadTree(
  buildings: BuildingModel[],
  bbox: BBox,
  depth: number,
  maxDepth: number,
  maxFeatures: number,
): TileNode {
  const geometricError = 200 / Math.pow(2, depth);
  const node: TileNode = { bbox, buildings: [], geometricError };

  if (buildings.length <= maxFeatures || depth >= maxDepth) {
    node.buildings = buildings;
    return node;
  }

  // Split into quadrants using index-based partitioning
  const midX = (bbox[0] + bbox[2]) / 2;
  const midY = (bbox[1] + bbox[3]) / 2;
  const quadrants: BBox[] = [
    [bbox[0], bbox[1], midX, midY],     // SW
    [midX, bbox[1], bbox[2], midY],     // SE
    [bbox[0], midY, midX, bbox[3]],     // NW
    [midX, midY, bbox[2], bbox[3]],     // NE
  ];

  // Pre-partition into quadrants by center point
  const buckets: BuildingModel[][] = [[], [], [], []];
  for (const b of buildings) {
    const bx = (b.bbox3d[0] + b.bbox3d[3]) / 2;
    const by = (b.bbox3d[1] + b.bbox3d[4]) / 2;
    const qi = (bx >= midX ? 1 : 0) + (by >= midY ? 2 : 0);
    buckets[qi].push(b);
  }

  node.children = [];
  for (let qi = 0; qi < 4; qi++) {
    if (buckets[qi].length > 0) {
      node.children.push(buildQuadTree(buckets[qi], quadrants[qi], depth + 1, maxDepth, maxFeatures));
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Write tileset
// ---------------------------------------------------------------------------

function writeTileset(
  node: TileNode,
  centerEcef: [number, number, number],
  outputPath: string,
  color?: [number, number, number, number],
): number {
  const tilesDir = path.join(outputPath, 'tiles');
  fs.mkdirSync(tilesDir, { recursive: true });

  let tileCount = 0;

  function walk(n: TileNode, tilePath: string): { tile: Record<string, unknown>; bbox: [number, number, number, number, number, number] } {
    const contentUri = `tiles/${tilePath}.b3dm`;

    // Merge and write b3dm
    if (n.buildings.length > 0) {
      const merged = mergeBuildings(n.buildings);
      const glb = encodeGLB(merged, color);
      const b3dm = encodeB3DM(glb, n.buildings.length);
      const outFile = path.join(tilesDir, `${tilePath}.b3dm`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, b3dm);
      tileCount++;
    }

    // Compute bounding volume from own buildings
    let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
    let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
    for (const b of n.buildings) {
      if (b.bbox3d[0] < bMinX) bMinX = b.bbox3d[0];
      if (b.bbox3d[1] < bMinY) bMinY = b.bbox3d[1];
      if (b.bbox3d[2] < bMinZ) bMinZ = b.bbox3d[2];
      if (b.bbox3d[3] > bMaxX) bMaxX = b.bbox3d[3];
      if (b.bbox3d[4] > bMaxY) bMaxY = b.bbox3d[4];
      if (b.bbox3d[5] > bMaxZ) bMaxZ = b.bbox3d[5];
    }

    const tile: Record<string, unknown> = {
      geometricError: n.geometricError,
      refine: 'ADD',
    };

    if (n.buildings.length > 0) {
      tile.content = { uri: contentUri };
    }

    // Walk children and merge their bboxes
    if (n.children && n.children.length > 0) {
      const childResults = n.children.map((child, i) => walk(child, `${tilePath}_${i}`));
      tile.children = childResults.map((r) => r.tile);
      for (const cb of childResults) {
        if (cb.bbox[0] < bMinX) bMinX = cb.bbox[0];
        if (cb.bbox[1] < bMinY) bMinY = cb.bbox[1];
        if (cb.bbox[2] < bMinZ) bMinZ = cb.bbox[2];
        if (cb.bbox[3] > bMaxX) bMaxX = cb.bbox[3];
        if (cb.bbox[4] > bMaxY) bMaxY = cb.bbox[4];
        if (cb.bbox[5] > bMaxZ) bMaxZ = cb.bbox[5];
      }
    }

    const mergedBbox: [number, number, number, number, number, number] =
      bMinX === Infinity ? [0, 0, 0, 0, 0, 0] : [bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ];
    tile.boundingVolume = { box: bboxToBoxVolume(mergedBbox) };

    return { tile, bbox: mergedBbox };
  }

  const rootResult = walk(node, '0');
  const rootJson = rootResult.tile;

  const tileset = {
    asset: { version: '1.0', gltfUpAxis: 'Z' },
    geometricError: node.geometricError,
    root: rootJson,
  };

  fs.writeFileSync(path.join(outputPath, 'tileset.json'), JSON.stringify(tileset, null, 2));
  return tileCount;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function write3DTiles(
  result: ParseResult,
  opts: ThreeDTilesOptions,
): Promise<ThreeDTilesSummary> {
  const fromCrs = opts.fromCrs ?? 'WGS84';
  const heightField = opts.heightField;
  if (!heightField) throw new Error('heightField is required.');
  if (!opts.outputPath) throw new Error('outputPath is required.');

  const maxZoom = opts.maxZoom ?? 3;
  const maxFeatures = opts.maxFeaturesPerTile ?? 500;
  const color = opts.color ?? [1, 1, 1, 1]; // default white

  // Load DEM if provided
  let dem: DEMData | null = null;
  if (opts.demPath) {
    log.info(`Loading DEM: ${opts.demPath}`);
    dem = await readDEM(opts.demPath);
    log.info(`DEM loaded: ${dem.width}x${dem.height}`);
  }

  // Filter polygon features
  const polygonFeatures: Feature[] = [];
  for (const f of result.features) {
    if (!f.geometry) continue;
    const t = f.geometry.type;
    if (t === 'Polygon' || t === 'MultiPolygon') {
      polygonFeatures.push(f);
    }
  }
  if (polygonFeatures.length === 0) {
    throw new Error('No Polygon/MultiPolygon features found in input.');
  }

  log.info(`Processing ${polygonFeatures.length} building features...`);

  // Step 1: Project all coordinates to WGS84, compute bbox iteratively (no spread)
  let minLon = Infinity, maxLon = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  for (const f of polygonFeatures) {
    const coords = f.geometry!.type === 'Polygon'
      ? (f.geometry!.coordinates as number[][][])[0]
      : (f.geometry!.coordinates as number[][][][])[0][0];
    for (const pt of coords) {
      const [lon, lat] = fromCrs === 'WGS84' ? [pt[0], pt[1]] : transformCoord(pt[0], pt[1], fromCrs, 'WGS84');
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const centerEcef = wgs84ToEcef(centerLon, centerLat, 0);

  // Step 2: Extrude each building
  const buildings: BuildingModel[] = [];
  const wgs84Bbox: BBox = [minLon, minLat, maxLon, maxLat];

  for (const f of polygonFeatures) {
    const rawHeight = f.properties[heightField];
    const h = typeof rawHeight === 'number' ? rawHeight : Number(rawHeight);
    if (!h || h <= 0 || !isFinite(h)) continue;

    // Get ground height from DEM
    let groundH = 0;
    if (dem) {
      const coords0 = f.geometry!.type === 'Polygon'
        ? (f.geometry!.coordinates as number[][][])[0]
        : (f.geometry!.coordinates as number[][][][])[0][0];
      // Use centroid for DEM sampling
      let sumLon = 0, sumLat = 0;
      for (const pt of coords0) {
        const [lon, lat] = fromCrs === 'WGS84' ? [pt[0], pt[1]] : transformCoord(pt[0], pt[1], fromCrs, 'WGS84');
        sumLon += lon;
        sumLat += lat;
      }
      const cLon = sumLon / coords0.length;
      const cLat = sumLat / coords0.length;
      groundH = sampleDEM(dem, cLon, cLat);
      if (!isFinite(groundH)) groundH = 0;
    }

    // Project rings to WGS84
    const geomCoords = f.geometry!.type === 'Polygon'
      ? (f.geometry!.coordinates as number[][][])
      : (f.geometry!.coordinates as number[][][][])[0]; // use first polygon of MultiPolygon

    const wgs84Rings: number[][][] = [];
    for (const ring of geomCoords) {
      const projected: number[][] = [];
      for (const pt of ring) {
        const [lon, lat] = fromCrs === 'WGS84' ? [pt[0], pt[1]] : transformCoord(pt[0], pt[1], fromCrs, 'WGS84');
        projected.push([lon, lat]);
      }
      wgs84Rings.push(projected);
    }

    const model = extrudePolygon(wgs84Rings, h, groundH, centerEcef);
    if (model) {
      model.properties = f.properties;
      buildings.push(model);
    }
  }

  if (buildings.length === 0) {
    throw new Error('No valid buildings could be extruded. Check height field values.');
  }

  log.info(`Extruded ${buildings.length} buildings${dem ? ' (with DEM elevation)' : ''}.`);

  // Step 3: Build quadtree and write tiles
  const tree = buildQuadTree(buildings, wgs84Bbox, 0, maxZoom, maxFeatures);
  const totalTiles = writeTileset(tree, centerEcef, opts.outputPath, color);

  log.info(`Generated ${totalTiles} b3dm tiles.`);

  return {
    totalBuildings: buildings.length,
    totalTiles,
    demUsed: dem !== null,
    bbox: wgs84Bbox,
    outputPath: opts.outputPath,
  };
}
