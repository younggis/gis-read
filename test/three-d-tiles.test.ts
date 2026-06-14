/**
 * Tests for the 3D Tiles (b3dm) generator.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { write3DTiles } from '../src/parsers/three-d-tiles.js';
import type { ParseResult } from '../src/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), '3dtiles-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// A simple square building footprint (WGS84)
const sampleResult: ParseResult = {
  name: 'test',
  features: [
    {
      type: 'Feature',
      properties: { height: 20, name: 'Building A' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [105.0, 30.0],
          [105.001, 30.0],
          [105.001, 30.001],
          [105.0, 30.001],
          [105.0, 30.0],
        ]],
      },
    },
    {
      type: 'Feature',
      properties: { height: 10, name: 'Building B' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [105.002, 30.0],
          [105.003, 30.0],
          [105.003, 30.001],
          [105.002, 30.001],
          [105.002, 30.0],
        ]],
      },
    },
  ],
};

const multiPolygonResult: ParseResult = {
  name: 'test-multi',
  features: [
    {
      type: 'Feature',
      properties: { HEIGHT: 15 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[
          [105.0, 30.0],
          [105.001, 30.0],
          [105.001, 30.001],
          [105.0, 30.001],
          [105.0, 30.0],
        ]]],
      },
    },
  ],
};

describe('write3DTiles', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    cleanup(tmpDir);
  });

  it('generates tileset.json and b3dm files', async () => {
    const outDir = path.join(tmpDir, 'basic');
    const summary = await write3DTiles(sampleResult, {
      outputPath: outDir,
      heightField: 'height',
    });

    assert.equal(summary.totalBuildings, 2);
    assert.ok(summary.totalTiles >= 1);
    assert.equal(summary.demUsed, false);

    // tileset.json exists
    const tilesetPath = path.join(outDir, 'tileset.json');
    assert.ok(fs.existsSync(tilesetPath));
    const tileset = JSON.parse(fs.readFileSync(tilesetPath, 'utf8'));
    assert.equal(tileset.asset.version, '1.0');
    assert.equal(tileset.root.refine, 'ADD');
    assert.ok(tileset.root.boundingVolume.box);

    // b3dm files exist
    const tilesDir = path.join(outDir, 'tiles');
    assert.ok(fs.existsSync(tilesDir));
    const b3dmFiles = fs.readdirSync(tilesDir).filter((f) => f.endsWith('.b3dm'));
    assert.ok(b3dmFiles.length >= 1);
  });

  it('validates b3dm binary structure', async () => {
    const outDir = path.join(tmpDir, 'binary');
    await write3DTiles(sampleResult, {
      outputPath: outDir,
      heightField: 'height',
    });

    const tilesDir = path.join(outDir, 'tiles');
    const b3dmFile = fs.readdirSync(tilesDir).find((f) => f.endsWith('.b3dm'));
    assert.ok(b3dmFile);
    const buf = fs.readFileSync(path.join(tilesDir, b3dmFile));

    // b3dm header
    assert.equal(buf.toString('ascii', 0, 4), 'b3dm');
    assert.equal(buf.readUInt32LE(4), 1); // version
    assert.equal(buf.readUInt32LE(8), buf.length); // byteLength

    // GLB header
    const ftJsonLen = buf.readUInt32LE(12);
    const ftBinLen = buf.readUInt32LE(16);
    const btJsonLen = buf.readUInt32LE(20);
    const btBinLen = buf.readUInt32LE(24);
    const glbOff = 28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen;
    assert.equal(buf.toString('ascii', glbOff, glbOff + 4), 'glTF');
    assert.equal(buf.readUInt32LE(glbOff + 4), 2); // glTF version 2
  });

  it('validates GLB contains material with color', async () => {
    const outDir = path.join(tmpDir, 'color');
    await write3DTiles(sampleResult, {
      outputPath: outDir,
      heightField: 'height',
      color: [1, 0, 0, 1], // red
    });

    const tilesDir = path.join(outDir, 'tiles');
    const b3dmFile = fs.readdirSync(tilesDir).find((f) => f.endsWith('.b3dm'));
    assert.ok(b3dmFile);
    const buf = fs.readFileSync(path.join(tilesDir, b3dmFile));

    const ftJsonLen = buf.readUInt32LE(12);
    const ftBinLen = buf.readUInt32LE(16);
    const btJsonLen = buf.readUInt32LE(20);
    const btBinLen = buf.readUInt32LE(24);
    const glbOff = 28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen;

    const glbJsonLen = buf.readUInt32LE(glbOff + 12);
    const glbJsonStr = buf.toString('utf8', glbOff + 20, glbOff + 20 + glbJsonLen);
    const gltf = JSON.parse(glbJsonStr);

    assert.ok(gltf.materials);
    assert.equal(gltf.materials.length, 1);
    const color = gltf.materials[0].pbrMetallicRoughness.baseColorFactor;
    assert.equal(color[0], 1); // red
    assert.equal(color[1], 0);
    assert.equal(color[2], 0);
    assert.equal(color[3], 1);
  });

  it('handles MultiPolygon geometry', async () => {
    const outDir = path.join(tmpDir, 'multi');
    const summary = await write3DTiles(multiPolygonResult, {
      outputPath: outDir,
      heightField: 'HEIGHT',
    });

    assert.equal(summary.totalBuildings, 1);
    assert.ok(summary.totalTiles >= 1);
  });

  it('skips features with invalid height', async () => {
    const result: ParseResult = {
      name: 'test-invalid',
      features: [
        {
          type: 'Feature',
          properties: { height: 0 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[105, 30], [105.001, 30], [105.001, 30.001], [105, 30.001], [105, 30]]],
          },
        },
        {
          type: 'Feature',
          properties: { height: -5 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[105, 30], [105.001, 30], [105.001, 30.001], [105, 30.001], [105, 30]]],
          },
        },
        {
          type: 'Feature',
          properties: { height: 'abc' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[105, 30], [105.001, 30], [105.001, 30.001], [105, 30.001], [105, 30]]],
          },
        },
        {
          type: 'Feature',
          properties: { height: 10 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[105, 30], [105.001, 30], [105.001, 30.001], [105, 30.001], [105, 30]]],
          },
        },
      ],
    };

    const outDir = path.join(tmpDir, 'invalid');
    const summary = await write3DTiles(result, {
      outputPath: outDir,
      heightField: 'height',
    });

    // Only 1 valid building (height=10)
    assert.equal(summary.totalBuildings, 1);
  });

  it('throws on missing heightField', async () => {
    const outDir = path.join(tmpDir, 'no-field');
    await assert.rejects(
      () => write3DTiles(sampleResult, { outputPath: outDir, heightField: '' }),
      /heightField is required/,
    );
  });

  it('throws on no polygon features', async () => {
    const result: ParseResult = {
      name: 'points',
      features: [
        {
          type: 'Feature',
          properties: { height: 10 },
          geometry: { type: 'Point', coordinates: [105, 30] },
        },
      ],
    };
    const outDir = path.join(tmpDir, 'no-polygon');
    await assert.rejects(
      () => write3DTiles(result, { outputPath: outDir, heightField: 'height' }),
      /No Polygon\/MultiPolygon/,
    );
  });

  it('respects maxZoom and maxFeaturesPerTile for spatial tiling', async () => {
    const features = [];
    for (let i = 0; i < 20; i++) {
      const lon = 105 + (i % 5) * 0.01;
      const lat = 30 + Math.floor(i / 5) * 0.01;
      features.push({
        type: 'Feature' as const,
        properties: { height: 10 },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[
            [lon, lat], [lon + 0.005, lat],
            [lon + 0.005, lat + 0.005], [lon, lat + 0.005],
            [lon, lat],
          ]],
        },
      });
    }
    const result: ParseResult = { name: 'tiled', features };

    const outDir = path.join(tmpDir, 'tiled');
    const summary = await write3DTiles(result, {
      outputPath: outDir,
      heightField: 'height',
      maxZoom: 1,
      maxFeaturesPerTile: 5,
    });

    assert.equal(summary.totalBuildings, 20);
    assert.ok(summary.totalTiles >= 2, `Expected at least 2 tiles, got ${summary.totalTiles}`);

    // Verify tileset.json has children
    const tileset = JSON.parse(fs.readFileSync(path.join(outDir, 'tileset.json'), 'utf8'));
    assert.ok(tileset.root.children, 'Root should have children when tiling');
  });
});
