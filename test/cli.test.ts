/**
 * CLI integration tests.
 *
 * These tests exercise the command surface rather than parser helpers. They
 * use temporary files so conversions can generate additional fixtures without
 * modifying data/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseGeoJSON } from '../src/parsers/geojson.js';
import { parseKML } from '../src/parsers/kml.js';
import { parseGPX } from '../src/parsers/gpx.js';
import { parseEsriJSON } from '../src/parsers/esrijson.js';
import { parseCSV } from '../src/parsers/csv.js';
import { parseMIF } from '../src/parsers/mif.js';
import { parseShapefile } from '../src/parsers/shapefile.js';

const execFileAsync = promisify(execFile);

const SOURCE_CLI = path.resolve('src/cli.ts');

async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', SOURCE_CLI, ...args], {
    cwd: path.resolve('.'),
    env,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return result;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gis-read-cli-'));
}

function writeFixture(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({
    type: 'FeatureCollection',
    name: 'cli-fixture',
    features: [
      {
        type: 'Feature',
        properties: { name: 'point', value: 1 },
        geometry: { type: 'Point', coordinates: [116.391, 39.907] },
      },
      {
        type: 'Feature',
        properties: { name: 'line', value: 2 },
        geometry: { type: 'LineString', coordinates: [[116.391, 39.907], [116.4, 39.91]] },
      },
      {
        type: 'Feature',
        properties: { name: 'poly', value: 3 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[116.39, 39.9], [116.41, 39.9], [116.41, 39.92], [116.39, 39.9]]],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'multipoly', value: 4 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[116, 39], [117, 39], [117, 40], [116, 39]]],
            [[[118, 41], [119, 41], [119, 42], [118, 41]]],
          ],
        },
      },
    ],
  }));
  return file;
}

test('stream command writes non-empty KML with one Placemark per GeoJSON feature', async () => {
  const dir = tempDir();
  const input = writeFixture(dir, 'input.geojson');
  const output = path.join(dir, 'out.kml');

  await runCli(['stream', input, '-o', output, '--log-level', 'silent']);

  const text = fs.readFileSync(output, 'utf8');
  assert.ok(text.length > 1_000, 'KML output should include feature content, not just headers');
  assert.equal((text.match(/<Placemark>/g) ?? []).length, 4);
  assert.match(text, /<Point><coordinates>/);
  assert.match(text, /<LineString><coordinates>/);
  assert.match(text, /<Polygon>/);
  assert.match(text, /<MultiGeometry>/);

  const parsed = parseKML(text);
  assert.equal(parsed.features.length, 4);
});

test('stream command writes valid GeoJSON and GPX outputs', async () => {
  const dir = tempDir();
  const input = writeFixture(dir, 'input.geojson');
  const geojsonOut = path.join(dir, 'out.geojson');
  const gpxOut = path.join(dir, 'out.gpx');

  await runCli(['stream', input, '-o', geojsonOut, '--log-level', 'silent']);
  await runCli(['stream', input, '-o', gpxOut, '--log-level', 'silent']);

  assert.equal(parseGeoJSON(fs.readFileSync(geojsonOut)).features.length, 4);
  const gpx = parseGPX(fs.readFileSync(gpxOut));
  assert.equal(gpx.features.length, 2, 'GPX streaming supports Point and LineString geometries');
});

test('convert command handles common input formats to GeoJSON', async () => {
  const dir = tempDir();
  const cases = [
    ['data/lakes.shp', 'shp-out.geojson', 1225],
    ['data/lakes.tab', 'tab-out.geojson', 1225],
    ['data/lakes.kml', 'kml-out.geojson', 1225],
    ['data/lakes.gpx', 'gpx-out.geojson', 101],
    ['data/lakes.topojson', 'topojson-out.geojson', 1225],
    ['data/lakes.czml', 'czml-out.geojson', 1225],
    ['data/lakes.csv', 'csv-out.geojson', 1225],
    ['data/lakes.esrijson', 'esri-out.geojson', 1225],
    ['data/lakes.mif', 'mif-out.geojson', 1225],
  ] as const;

  for (const [input, name, expectedFeatures] of cases) {
    const output = path.join(dir, name);
    await runCli(['convert', input, '-o', output, '-t', 'geojson', '--log-level', 'silent']);
    const parsed = parseGeoJSON(fs.readFileSync(output));
    assert.equal(parsed.features.length, expectedFeatures, `${input} should convert to GeoJSON`);
  }
});

test('convert command writes CSV, MIF, and Shapefile outputs from compatible GeoJSON input', async () => {
  const dir = tempDir();
  const points = path.join(dir, 'points.geojson');
  fs.writeFileSync(points, JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A', id: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: { name: 'B', id: 2 }, geometry: { type: 'Point', coordinates: [3, 4] } },
    ],
  }));
  const csvOut = path.join(dir, 'out.csv');
  const mifOut = path.join(dir, 'out.mif');
  const shpOut = path.join(dir, 'out.shp');

  await runCli(['convert', points, '-o', csvOut, '--log-level', 'silent']);
  await runCli(['convert', points, '-o', mifOut, '--log-level', 'silent']);
  await runCli(['convert', points, '-o', shpOut, '-t', 'shapefile', '--log-level', 'silent']);

  assert.equal(parseCSV(fs.readFileSync(csvOut)).features.length, 2);
  assert.equal(parseMIF(mifOut).features.length, 2);
  assert.equal(parseShapefile(shpOut).features.length, 2);
});

test('convert command surfaces TAB writer GDAL requirement when ogr2ogr is unavailable', async () => {
  const dir = tempDir();
  const input = writeFixture(dir, 'input.geojson');
  const tabOut = path.join(dir, 'out.tab');

  try {
    await runCli(['convert', input, '-o', tabOut, '-t', 'tab', '--log-level', 'error'], { ...process.env, PATH: '' });
    assert.fail('TAB conversion should fail when ogr2ogr is unavailable');
  } catch (error) {
    assert.match(String((error as { stderr?: string }).stderr), /GDAL\/OGR.*ogr2ogr/i);
  }
});

test('convert command writes KML, GPX, and ESRI JSON from GeoJSON input', async () => {
  const dir = tempDir();
  const input = writeFixture(dir, 'input.geojson');
  const kmlOut = path.join(dir, 'out.kml');
  const gpxOut = path.join(dir, 'out.gpx');
  const esriOut = path.join(dir, 'out.esrijson');

  await runCli(['convert', input, '-o', kmlOut, '--log-level', 'silent']);
  await runCli(['convert', input, '-o', gpxOut, '--log-level', 'silent']);
  await runCli(['convert', input, '-o', esriOut, '-t', 'esrijson', '--log-level', 'silent']);

  assert.equal(parseKML(fs.readFileSync(kmlOut)).features.length, 4);
  assert.equal(parseGPX(fs.readFileSync(gpxOut)).features.length, 2);
  assert.equal(parseEsriJSON(fs.readFileSync(esriOut)).features.length, 4);
});
