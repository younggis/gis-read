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

function writeWindowsSimpChineseTABBundle(dir: string): string {
  const base = path.join(dir, 'windows-simpchinese');
  const fields = [
    { dbfName: 'F1', tabName: Buffer.from([0xb5, 0xd8, 0xca, 0xd0]), width: 10 },
    { dbfName: 'F2', tabName: Buffer.from([0xcf, 0xdf, 0xc2, 0xb7]), width: 10 },
    { dbfName: 'F3', tabName: Buffer.from([0xb1, 0xe0, 0xba, 0xc5]), width: 60 },
    { dbfName: 'F4', tabName: Buffer.from([0xd5, 0xfd, 0xb7, 0xb4, 0xcf, 0xf2]), width: 60 },
  ];

  const tabChunks: Buffer[] = [
    Buffer.from('!table\n!version 300\n!charset WindowsSimpChinese\n\nDefinition Table\n  Type NATIVE Charset "WindowsSimpChinese"\n  Fields 4\n', 'ascii'),
  ];
  for (const field of fields) {
    tabChunks.push(Buffer.from('    ', 'ascii'), field.tabName, Buffer.from(` Char (${field.width}) ;\n`, 'ascii'));
  }
  fs.writeFileSync(`${base}.tab`, Buffer.concat(tabChunks));

  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((sum, field) => sum + field.width, 0);
  const dat = Buffer.alloc(headerLen + recordLen, 0);
  dat[0] = 0x03;
  dat.writeUInt32LE(1, 4);
  dat.writeUInt16LE(headerLen, 8);
  dat.writeUInt16LE(recordLen, 10);
  let off = 32;
  for (const field of fields) {
    dat.write(field.dbfName, off, 'ascii');
    dat[off + 11] = 0x43;
    dat[off + 16] = field.width;
    off += 32;
  }
  dat[headerLen - 1] = 0x0d;
  dat[headerLen] = 0x20;
  const values = [
    Buffer.from([0xb3, 0xc9, 0xb6, 0xbc]),
    Buffer.from([0x39, 0xba, 0xc5, 0xcf, 0xdf]),
    Buffer.from([0x44, 0x39, 0x2d, 0xbb, 0xc6, 0xcc, 0xef, 0xb0, 0xd3, 0x2d, 0xb3, 0xc9, 0xb6, 0xbc, 0xce, 0xf7, 0xd5, 0xbe]),
    Buffer.from('F', 'ascii'),
  ];
  let cursor = headerLen + 1;
  for (let i = 0; i < fields.length; i++) {
    const value = values[i];
    const width = fields[i].width;
    dat.set(value, cursor);
    dat.fill(0x20, cursor + value.length, cursor + width);
    cursor += width;
  }
  fs.writeFileSync(`${base}.dat`, dat);

  const id = Buffer.alloc(4);
  id.writeUInt32LE(16, 0);
  fs.writeFileSync(`${base}.id`, id);

  const map = Buffer.alloc(16 + 38, 0);
  const geom = map.subarray(16);
  geom.set([0x08, 0x01, 0x00, 0x00]);
  let coord = 13;
  for (const [x, y] of [[104.03897, 30.637395], [104.04, 30.638], [104.05, 30.64]]) {
    geom.writeInt32LE(-Math.round(x * 1_000_000), coord);
    geom.writeInt32LE(Math.round(y * 1_000_000), coord + 4);
    coord += 8;
  }
  fs.writeFileSync(`${base}.map`, map);

  return `${base}.tab`;
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

test('convert command decodes Chinese TAB fields, values, and legacy line geometries', async () => {
  const dir = tempDir();
  const input = writeWindowsSimpChineseTABBundle(dir);
  const output = path.join(dir, 'windows-simpchinese.geojson');

  await runCli(['convert', input, '-o', output, '-t', 'geojson', '--log-level', 'silent']);

  const parsed = parseGeoJSON(fs.readFileSync(output));
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].properties['地市'], '成都');
  assert.equal(parsed.features[0].properties['线路'], '9号线');
  assert.equal(parsed.features[0].properties['编号'], 'D9-黄田坝-成都西站');
  const geometries = parsed.features.map((f) => f.geometry).filter(Boolean);
  assert.ok(geometries.length > 0, 'converted TAB should include line geometries');
});

test('convert command preserves grid road TAB line geometry', async () => {
  const dir = tempDir();
  const output = path.join(dir, 'grid-road.geojson');

  await runCli(['convert', path.join('data', '网格内道路图层.TAB'), '-o', output, '-t', 'geojson', '--log-level', 'silent']);

  const parsed = parseGeoJSON(fs.readFileSync(output));
  assert.equal(parsed.features.length, 28);
  const geometries = parsed.features.map((f) => f.geometry).filter(Boolean);
  assert.ok(geometries.length > 0, 'converted grid road TAB should include line geometries');
  assert.ok(geometries.every((g) => g?.type === 'LineString' || g?.type === 'MultiLineString'));
});

test('convert command preserves JN TAB region geometry', async () => {
  const dir = tempDir();
  const output = path.join(dir, 'jn-region.geojson');

  await runCli(['convert', path.join('data', 'JN-36-01.TAB'), '-o', output, '-t', 'geojson', '--log-level', 'silent']);

  const parsed = parseGeoJSON(fs.readFileSync(output));
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].properties.JN, 'JN-36-01');
  assert.equal(parsed.features[0].geometry?.type, 'Polygon');
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

test('tile command writes XYZ MVT PBF tiles', async () => {
  const dir = tempDir();
  const input = writeFixture(dir, 'input.geojson');
  const output = path.join(dir, 'tiles');

  await runCli(['tile', input, '-o', output, '--min-zoom', '0', '--max-zoom', '1', '--threads', '1', '--log-level', 'silent']);

  const files = fs.readdirSync(output, { recursive: true }).map(String).filter((name) => name.endsWith('.pbf'));
  assert.ok(files.length > 0, 'tile command should write pbf files');
  const first = fs.readFileSync(path.join(output, files[0]));
  assert.ok(first.length > 0, 'pbf tile should not be empty');
});

test('tile command rejects invalid zoom range', async () => {
  const dir = tempDir();
  const input = writeFixture(dir, 'input.geojson');
  const output = path.join(dir, 'tiles');

  await assert.rejects(
    runCli(['tile', input, '-o', output, '--min-zoom', '3', '--max-zoom', '2', '--log-level', 'error']),
    /min-zoom/i,
  );
});
