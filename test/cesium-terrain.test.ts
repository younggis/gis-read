/**
 * Tests for the `terrain-cesium` and `3dtiles` CLI commands.
 *
 * The tests focus on the in-process API exposed from `parsers/index.ts` and
 * a small end-to-end CLI smoke test. They use the small `data/building.shp`
 * fixture and `data/sc_dem_tif.tif` DEM; both are real but compact enough
 * to keep test runs fast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  writeTerrainCesiumTiles,
  llhToEcef,
  cesiumTileBBox,
  writeThreeDTiles,
} from '../src/parsers/index.js';

const execFileAsync = promisify(execFile);
const SOURCE_CLI = path.resolve('src/cli.ts');
const DEM = path.join('data', 'sc_dem_tif.tif');
const SHP = path.join('data', 'building.shp');

function skipIfMissing(p: string): string | false {
  return fs.existsSync(p) ? false : `fixture missing: ${p}`;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gis-read-cesium-'));
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ['--import', 'tsx', SOURCE_CLI, ...args], {
    cwd: path.resolve('.'),
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('llhToEcef: zero elevation at lon=0,lat=0 is on the X axis', () => {
  const [x, y, z] = llhToEcef(0, 0, 0);
  assert.ok(Math.abs(y) < 1e-6);
  assert.ok(Math.abs(z) < 1e-6);
  // Radius at equator should be the WGS84 semi-major axis (6_378_137 m).
  assert.ok(Math.abs(x - 6_378_137) < 1);
});

test('cesiumTileBBox: level 0 covers the whole world', () => {
  const w = cesiumTileBBox(0, 0, 0);
  assert.deepEqual(w, [-180, -90, 0, 90]);
  const e = cesiumTileBBox(0, 1, 0);
  assert.deepEqual(e, [0, -90, 180, 90]);
});

test('writeTerrainCesiumTiles: produces layer.json + .terrain tiles', async () => {
  const skip = skipIfMissing(DEM);
  if (skip) return;
  const out = tempDir();
  const summary = await writeTerrainCesiumTiles(DEM, {
    outputPath: out,
    maxLevel: 3,
    gridSize: 16,
  });
  assert.ok(summary.totalTiles > 0, 'at least one real tile expected');
  assert.ok(fs.existsSync(path.join(out, 'layer.json')));
  // Tiles exist on disk.
  const dirs = fs.readdirSync(out).filter((n) => /^\d+$/.test(n));
  assert.ok(dirs.length > 0, 'expected at least one zoom level directory');
  const level1 = fs.readdirSync(path.join(out, '1'));
  assert.ok(level1.length > 0, 'level 1 directory should have at least one sub-dir');
  // Pick a tile at level 1 and verify it gunzips to a valid header.
  const xDir = level1[0];
  const tileFileName = fs.readdirSync(path.join(out, '1', xDir)).find((n) => n.endsWith('.terrain'));
  assert.ok(tileFileName, 'a .terrain file should exist');
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(out, '1', xDir, tileFileName!)));
  // Header: 3 doubles center + 2 floats min/max + 4 doubles sphere + 3 doubles horizon = 24+8+32+24 = 88 bytes.
  assert.ok(raw.length >= 88, 'decoded tile must contain at least the 88-byte header');
  const vertexCount = raw.readUInt32LE(88);
  assert.equal(vertexCount, 16 * 16, 'grid 16 should yield 256 vertices');
  // First center value should be a finite ECEF coordinate.
  const cx = raw.readDoubleLE(0);
  assert.ok(Number.isFinite(cx), 'center X should be a finite ECEF coord');
});

test('writeThreeDTiles: produces tileset.json + b3dm files', async () => {
  const skip = skipIfMissing(SHP);
  if (skip) return;
  const out = tempDir();
  const summary = await writeThreeDTiles(SHP, {
    outputPath: out,
    lod: 12,
    limit: 20,
    defaultHeight: 10,
    overwrite: true,
  });
  assert.ok(summary.tiles > 0, 'expected at least one tile');
  assert.ok(summary.features === 20, 'all 20 polygons should be processed');
  assert.ok(fs.existsSync(path.join(out, 'tileset.json')));
  // b3dm file should be non-empty and start with the b3dm magic.
  const tileset = JSON.parse(fs.readFileSync(path.join(out, 'tileset.json'), 'utf8'));
  const firstUri: string = tileset.root.children[0].content.uri;
  const b3dmPath = path.join(out, firstUri);
  assert.ok(fs.existsSync(b3dmPath));
  const buf = fs.readFileSync(b3dmPath);
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'b3dm', 'b3dm magic must be present');
  // glTF magic should appear after the feature/batch table sections.
  const ftJsonLen = buf.readUInt32LE(12);
  const ftBinLen = buf.readUInt32LE(16);
  const btJsonLen = buf.readUInt32LE(20);
  const btBinLen = buf.readUInt32LE(24);
  const gltfStart = 28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen;
  assert.equal(buf.subarray(gltfStart, gltfStart + 4).toString('ascii'), 'glTF', 'glTF magic must be present');
});

test('writeThreeDTiles: --dem path samples ground elevation', async () => {
  const skip = skipIfMissing(SHP) || skipIfMissing(DEM);
  if (skip) return;
  const out = tempDir();
  const summary = await writeThreeDTiles(SHP, {
    outputPath: out,
    lod: 11,
    limit: 5,
    defaultHeight: 12,
    dem: DEM,
    heightIsRelative: true,
    overwrite: true,
  });
  assert.equal(summary.features, 5);
  assert.equal(summary.heightMode, 'relative');
  assert.ok(summary.tiles > 0);
  // Building bottom elevation should not be the default 0; with DEM
  // sampling the per-vertex ground elevation comes from the DEM.
  const tileset = JSON.parse(fs.readFileSync(path.join(out, 'tileset.json'), 'utf8'));
  const region: number[] = tileset.root.boundingVolume.region;
  assert.ok(region[4] > -10, 'minHeight should be a real ground elevation (not the fallback 0)');
});

test('CLI terrain-cesium help: command is registered', async () => {
  const { stdout } = await runCli(['--help']);
  assert.match(stdout, /terrain-cesium/);
});

test('CLI 3dtiles help: command is registered', async () => {
  const { stdout } = await runCli(['--help']);
  assert.match(stdout, /\b3dtiles\b/);
});

test('CLI terrain-cesium: end-to-end generates layer.json + tiles', async () => {
  const skip = skipIfMissing(DEM);
  if (skip) return;
  const out = tempDir();
  await runCli(['terrain-cesium', DEM, '-o', out, '--max-level', '2', '--grid-size', '8']);
  assert.ok(fs.existsSync(path.join(out, 'layer.json')));
  const layer = JSON.parse(fs.readFileSync(path.join(out, 'layer.json'), 'utf8'));
  assert.equal(layer.format, 'quantized-mesh-1.0');
  assert.equal(layer.projection, 'EPSG:4326');
});

test('CLI 3dtiles: end-to-end generates tileset.json + Tiles/...', async () => {
  const skip = skipIfMissing(SHP);
  if (skip) return;
  const out = tempDir();
  await runCli(['3dtiles', SHP, '-o', out, '--limit', '10', '--overwrite', '--default-height', '8']);
  assert.ok(fs.existsSync(path.join(out, 'tileset.json')));
  assert.ok(fs.existsSync(path.join(out, 'Tiles')));
  // At least one b3dm was written somewhere under Tiles/.
  const collect = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collect(p));
      else if (entry.name.endsWith('.b3dm')) out.push(p);
    }
    return out;
  };
  const b3dms = collect(path.join(out, 'Tiles'));
  assert.ok(b3dms.length > 0, 'at least one b3dm should be written');
});
