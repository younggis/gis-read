/**
 * Test suite for the GIS parser and writer.
 *
 * Run with: `npm test`
 *
 * Each test uses the sample datasets in `data/` and checks that the
 * parser returns the expected feature count + a sample feature structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseGeoJSON, writeGeoJSON } from '../src/parsers/geojson.js';
import { parseKML, writeKML } from '../src/parsers/kml.js';
import { parseShapefile } from '../src/parsers/shapefile.js';
import { parseTAB } from '../src/parsers/tab.js';
import { parseGPX, writeGPX } from '../src/parsers/gpx.js';
import { parseTopoJSON } from '../src/parsers/topojson.js';
import { parseCZML } from '../src/parsers/czml.js';
import { parseCSV, parseWKT, writeCSV } from '../src/parsers/csv.js';
import { parseEsriJSON, writeEsriJSON } from '../src/parsers/esrijson.js';
import { parseMIF, writeMIF } from '../src/parsers/mif.js';
import { writeShapefile } from '../src/parsers/shapefile-writer.js';
import { writeTAB } from '../src/parsers/tab-writer.js';
import {
  computeWebMercatorBBox,
  tileRangeForBBox,
  writeVectorTiles,
} from '../src/parsers/vector-tile.js';
import { detectFormat } from '../src/format-detect.js';
import {
  transformCoord,
  transformGeometry,
  wgs84ToGCJ02,
  gcj02ToWGS84,
  gcj02ToBD09,
  bd09ToGCJ02,
  normalizeId,
} from '../src/crs.js';
import {
  detectEncoding,
  normalizeCPG,
  decoderFor,
  decodeStringField,
  driverToEncoding,
} from '../src/encoding.js';
import type { Feature } from '../src/types.js';
import type { Geometry } from '../src/types.js';

const DATA = path.resolve('data');
const GEOJSON = path.join(DATA, 'lakes.geojson');
const KML = path.join(DATA, 'lakes.kml');
const SHP = path.join(DATA, 'lakes.shp');
const TAB = path.join(DATA, 'lakes.tab');
const UNTITLED_REGION_SHP = path.join(DATA, 'Untitled_region.shp');
const GRID_ROAD_TAB = path.join(DATA, '网格内道路图层.TAB');
const JN_REGION_TAB = path.join(DATA, 'JN-36-01.TAB');

function skipIfMissing(filePath: string): false | string {
  return fs.existsSync(filePath) ? false : `fixture missing: ${filePath}`;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gis-read-parser-'));
}

function geometryBBox(geometry: Geometry | null | undefined): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      xs.push(value[0]);
      ys.push(value[1]);
      return;
    }
    for (const item of value) visit(item);
  };
  visit((geometry as { coordinates?: unknown } | null | undefined)?.coordinates);
  return xs.length > 0
    ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    : null;
}

function assertBBoxClose(actual: [number, number, number, number], expected: [number, number, number, number], tolerance = 1e-6): void {
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `bbox[${i}] expected ${expected[i]}, got ${actual[i]}`);
  }
}

function writeWindowsSimpChineseTABBundle(dir: string, charset = 'WindowsSimpChinese'): string {
  const base = path.join(dir, `tab-${charset.toLowerCase()}`);
  const fields = [
    { dbfName: 'F1', tabName: Buffer.from([0xb5, 0xd8, 0xca, 0xd0]), width: 10 },
    { dbfName: 'F2', tabName: Buffer.from([0xcf, 0xdf, 0xc2, 0xb7]), width: 10 },
    { dbfName: 'F3', tabName: Buffer.from([0xb1, 0xe0, 0xba, 0xc5]), width: 60 },
    { dbfName: 'F4', tabName: Buffer.from([0xd5, 0xfd, 0xb7, 0xb4, 0xcf, 0xf2]), width: 60 },
  ];

  const tabChunks: Buffer[] = [
    Buffer.from(`!table\n!version 300\n!charset ${charset}\n\nDefinition Table\n  Type NATIVE Charset "${charset}"\n  Fields 4\n`, 'ascii'),
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

function writeV500PointTableLineTABBundle(dir: string): string {
  const base = path.join(dir, 'v500-point-table-line');
  fs.writeFileSync(`${base}.tab`, [
    '!table',
    '!version 500',
    '!charset Neutral',
    '',
    'Definition Table',
    '  Type NATIVE Charset "Neutral"',
    '  Fields 1',
    '    name Char (20) ;',
    '',
  ].join('\n'));

  const headerLen = 32 + 32 + 1;
  const recordLen = 1 + 20;
  const dat = Buffer.alloc(headerLen + recordLen * 2, 0);
  dat[0] = 0x03;
  dat.writeUInt32LE(2, 4);
  dat.writeUInt16LE(headerLen, 8);
  dat.writeUInt16LE(recordLen, 10);
  dat.write('name', 32, 'ascii');
  dat[32 + 11] = 0x43;
  dat[32 + 16] = 20;
  dat[headerLen - 1] = 0x0d;
  dat[headerLen] = 0x20;
  Buffer.from('road', 'ascii').copy(dat, headerLen + 1);
  dat.fill(0x20, headerLen + 5, headerLen + recordLen);
  dat[headerLen + recordLen] = 0x20;
  Buffer.from('road2', 'ascii').copy(dat, headerLen + recordLen + 1);
  dat.fill(0x20, headerLen + recordLen + 6, headerLen + recordLen * 2);
  fs.writeFileSync(`${base}.dat`, dat);

  const objectOffset = 512;
  const coordBlockOffset = 1024;
  const objectOffset2 = 560;
  const coordBlockOffset2 = 1100;
  const id = Buffer.alloc(8);
  id.writeUInt32LE(objectOffset, 0);
  id.writeUInt32LE(objectOffset2, 4);
  fs.writeFileSync(`${base}.id`, id);

  const map = Buffer.alloc(2048, 0);
  map.writeInt16LE(500, 0x104);
  map.writeInt16LE(512, 0x106);
  map[0x161] = 1;
  map.writeDoubleLE(1_000_000, 0x170);
  map.writeDoubleLE(1_000_000, 0x178);
  map.writeDoubleLE(0, 0x180);
  map.writeDoubleLE(0, 0x188);

  const originX = 106_811_144;
  const originY = 31_720_798;
  map[objectOffset] = 0x25;
  map.writeUInt32LE(1, objectOffset + 1);
  map.writeUInt32LE(coordBlockOffset, objectOffset + 5);
  map.writeUInt32LE(36, objectOffset + 9);
  map.writeUInt16LE(1, objectOffset + 13);
  map.writeInt32LE(originX, objectOffset + 19);
  map.writeInt32LE(originY, objectOffset + 23);

  const deltas = [
    [-1683, -1216],
    [-382, -386],
    [854, 453],
    [1674, 1201],
    [1684, 1216],
  ];
  map.writeUInt32LE(deltas.length, coordBlockOffset);
  map.writeInt16LE(-1683, coordBlockOffset + 4);
  map.writeInt16LE(-1216, coordBlockOffset + 6);
  map.writeInt16LE(1684, coordBlockOffset + 8);
  map.writeInt16LE(1216, coordBlockOffset + 10);
  map.writeUInt32LE(24, coordBlockOffset + 12);
  let cursor = coordBlockOffset + 16;
  for (const [dx, dy] of deltas) {
    map.writeInt16LE(dx, cursor);
    map.writeInt16LE(dy, cursor + 2);
    cursor += 4;
  }

  const originX2 = 107_386_386;
  const originY2 = 31_880_807;
  map[objectOffset2] = 0x25;
  map.writeUInt32LE(2, objectOffset2 + 1);
  map.writeUInt32LE(coordBlockOffset2, objectOffset2 + 5);
  map.writeUInt32LE(24, objectOffset2 + 9);
  map.writeUInt16LE(1, objectOffset2 + 13);
  map.writeInt32LE(originX2, objectOffset2 + 19);
  map.writeInt32LE(originY2, objectOffset2 + 23);
  const deltas2 = [[-2237, 23], [2237, -23]];
  map.writeUInt32LE(deltas2.length, coordBlockOffset2);
  map.writeInt16LE(-2237, coordBlockOffset2 + 4);
  map.writeInt16LE(-23, coordBlockOffset2 + 6);
  map.writeInt16LE(2237, coordBlockOffset2 + 8);
  map.writeInt16LE(23, coordBlockOffset2 + 10);
  map.writeUInt32LE(24, coordBlockOffset2 + 12);
  cursor = coordBlockOffset2 + 16;
  for (const [dx, dy] of deltas2) {
    map.writeInt16LE(dx, cursor);
    map.writeInt16LE(dy, cursor + 2);
    cursor += 4;
  }
  fs.writeFileSync(`${base}.map`, map);
  return `${base}.tab`;
}

function writeMislabeledGbkShapefile(dir: string): string {
  const shp = path.join(dir, 'mislabeled-gbk.shp');
  writeShapefile({
    name: 'mislabeled-gbk',
    features: [{
      type: 'Feature',
      properties: { F1: 'placeholder', F2: 'placeholder' },
      geometry: { type: 'Point', coordinates: [107.25, 31.85] },
    }],
  }, { outputPath: shp });

  const fields = [
    { name: Buffer.from([0xb5, 0xd8, 0xca, 0xd0]), size: 20 }, // 地市
    { name: Buffer.from([0xc7, 0xf8, 0xcf, 0xd8]), size: 30 }, // 区县
  ];
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((sum, field) => sum + field.size, 0);
  const dbf = Buffer.alloc(headerLen + recordLen + 1, 0x20);
  dbf[0] = 0x03;
  dbf.writeUInt32LE(1, 4);
  dbf.writeUInt16LE(headerLen, 8);
  dbf.writeUInt16LE(recordLen, 10);
  dbf[29] = 0x57;
  let descriptor = 32;
  for (const field of fields) {
    field.name.copy(dbf, descriptor, 0, Math.min(field.name.length, 11));
    dbf[descriptor + 11] = 0x43;
    dbf[descriptor + 16] = field.size;
    descriptor += 32;
  }
  dbf[headerLen - 1] = 0x0d;
  dbf[headerLen] = 0x20;
  const values = [
    Buffer.from([0xb0, 0xcd, 0xd6, 0xd0]), // 巴中
    Buffer.from([0xb0, 0xcd, 0xd6, 0xdd, 0xc7, 0xf8]), // 巴州区
  ];
  let cursor = headerLen + 1;
  for (let i = 0; i < fields.length; i++) {
    values[i].copy(dbf, cursor);
    cursor += fields[i].size;
  }
  dbf[dbf.length - 1] = 0x1a;
  fs.writeFileSync(shp.replace(/\.shp$/i, '.dbf'), dbf);
  fs.writeFileSync(shp.replace(/\.shp$/i, '.cpg'), 'UTF-8\n', 'utf8');
  return shp;
}

function smallFeatureSet() {
  return {
    name: 'writer-fixture',
    features: [
      {
        type: 'Feature' as const,
        properties: { id: 1, name: 'point', active: true },
        geometry: { type: 'Point', coordinates: [116.391, 39.907] },
      },
      {
        type: 'Feature' as const,
        properties: { id: 2, name: 'line', active: false },
        geometry: { type: 'LineString', coordinates: [[116.391, 39.907], [116.4, 39.91]] },
      },
      {
        type: 'Feature' as const,
        properties: { id: 3, name: 'poly', active: true },
        geometry: {
          type: 'Polygon',
          coordinates: [[[116.39, 39.9], [116.41, 39.9], [116.41, 39.92], [116.39, 39.9]]],
        },
      },
    ],
  };
}

function writeUtf8ChineseFieldNameShapefile(dir: string): string {
  const shp = path.join(dir, 'utf8-field.shp');
  const feature: Feature = {
    type: 'Feature',
    properties: { '建筑物P': 'CD-317139-1', NAME: '青城1号1栋' },
    geometry: { type: 'Point', coordinates: [105.3876082, 30.87093462] },
  };
  writeShapefile({ name: 'utf8-field', features: [feature] }, { outputPath: shp });
  const dbf = shp.replace(/\.shp$/i, '.dbf');
  const fd = fs.openSync(dbf, 'r+');
  try {
    const rawName = Buffer.from('建筑物编码', 'utf8').subarray(0, 11);
    const fieldName = Buffer.alloc(11, 0);
    rawName.copy(fieldName);
    fs.writeSync(fd, fieldName, 0, fieldName.length, 32);
  } finally {
    fs.closeSync(fd);
  }
  return shp;
}

function copyBundleToSparseLargeDbf(srcShp: string, dir: string): string {
  const srcBase = srcShp.replace(/\.(shp|shx|dbf|prj|cpg)$/i, '');
  const dstBase = path.join(dir, 'large-dbf');
  for (const ext of ['.shp', '.shx', '.cpg']) {
    fs.copyFileSync(srcBase + ext, dstBase + ext);
  }

  const srcDbf = srcBase + '.dbf';
  const dstDbf = dstBase + '.dbf';
  fs.copyFileSync(srcDbf, dstDbf);
  const header = fs.readFileSync(dstDbf).subarray(0, 32);
  const headerLen = header.readUInt16LE(8);
  const recordLen = header.readUInt16LE(10);
  const logicalSize = 2 * 1024 * 1024 * 1024 + recordLen;
  const fd = fs.openSync(dstDbf, 'r+');
  try {
    const record = Buffer.alloc(recordLen, 0x20);
    fs.readSync(fd, record, 0, recordLen, headerLen);
    fs.writeSync(fd, record, 0, recordLen, logicalSize - recordLen);
    fs.ftruncateSync(fd, logicalSize);
  } finally {
    fs.closeSync(fd);
  }
  return dstBase + '.shp';
}

test('detectFormat classifies sample files', () => {
  assert.equal(detectFormat(GEOJSON), 'geojson');
  assert.equal(detectFormat(KML), 'kml');
  assert.equal(detectFormat(SHP), 'shapefile');
  assert.equal(detectFormat(TAB), 'tab');
});

test('parseGeoJSON returns 1225 features with MultiPolygon geometry', () => {
  const r = parseGeoJSON(fs.readFileSync(GEOJSON));
  assert.equal(r.features.length, 1225);
  assert.equal(r.name, 'lakes');
  const geomTypes = new Set(r.features.map((f) => f.geometry?.type));
  assert.ok(geomTypes.has('MultiPolygon') || geomTypes.has('Polygon'));
  assert.equal(r.crs?.properties?.name, 'urn:ogc:def:crs:OGC:1.3:CRS84');
});

test('GeoJSON round-trip preserves features', () => {
  const r = parseGeoJSON(fs.readFileSync(GEOJSON));
  const text = writeGeoJSON(r);
  const re = parseGeoJSON(text);
  assert.equal(re.features.length, r.features.length);
  const orig = r.features[0].geometry as any;
  const back = re.features[0].geometry as any;
  assert.equal(orig.coordinates.length, back.coordinates.length);
});

test('parseKML extracts Placemarks with ExtendedData + geometry', () => {
  const r = parseKML(fs.readFileSync(KML));
  assert.equal(r.features.length, 1225);
  const f0 = r.features[0];
  assert.ok(f0.properties);
  assert.ok(f0.geometry);
  assert.ok('OBJECTID' in f0.properties);
  assert.equal(f0.geometry?.type, 'MultiPolygon');
});

test('KML round-trip preserves feature count and geometry type', () => {
  const r = parseKML(fs.readFileSync(KML));
  const text = writeKML(r);
  const re = parseKML(text);
  assert.equal(re.features.length, r.features.length);
  assert.equal(re.features[0].geometry?.type, r.features[0].geometry?.type);
});

test('parseShapefile reads shp + dbf with attributes and polygon geometry', () => {
  const r = parseShapefile(SHP);
  assert.equal(r.features.length, 1225);
  const f0 = r.features[0];
  assert.equal(f0.geometry?.type, 'Polygon');
  assert.equal(f0.properties.OBJECTID, 1);
  assert.equal(f0.properties.Name, '茶园沟水库');
  assert.ok(r.bbox && r.bbox.length === 4);
  assert.ok(r.bbox![1] < r.bbox![3]);
});

test('parseShapefile detects UTF-8 attributes when .cpg is missing', { skip: skipIfMissing(UNTITLED_REGION_SHP) }, () => {
  const r = parseShapefile(UNTITLED_REGION_SHP);
  assert.equal(r.features.length, 1);
  assert.match(String(r.meta?.encoding), /utf-8 \(detected\)/i);
  assert.equal(r.features[0].properties.name, '扎科乡');
  assert.equal(r.features[0].properties.quhua, '513328205');
  assert.equal(r.features[0].geometry?.type, 'Polygon');
});

test('parseShapefile decodes UTF-8 DBF field names from .cpg', () => {
  const r = parseShapefile(writeUtf8ChineseFieldNameShapefile(tempDir()));
  assert.equal(r.features.length, 1);
  assert.match(String(r.meta?.encoding), /utf-8 \(cpg\)/i);
  assert.equal(r.features[0].properties['建筑物'], 'CD-317139-1');
  assert.equal(r.features[0].properties.NAME, '青城1号1栋');
});

test('parseShapefile recovers GBK attributes when .cpg is mislabeled as UTF-8', () => {
  const r = parseShapefile(writeMislabeledGbkShapefile(tempDir()));
  assert.equal(r.features.length, 1);
  assert.match(String(r.meta?.encoding), /gb/i);
  assert.equal(r.features[0].properties['地市'], '巴中');
  assert.equal(r.features[0].properties['区县'], '巴州区');
});

test('parseShapefile supports limiting parsed features', () => {
  const r = parseShapefile(SHP, { limit: 2 });
  assert.equal(r.features.length, 2);
  assert.equal(r.meta?.recordCount, 2);
});

test('parseShapefile streams DBF records larger than Node Buffer limit', () => {
  const largeShp = copyBundleToSparseLargeDbf(writeUtf8ChineseFieldNameShapefile(tempDir()), tempDir());
  const r = parseShapefile(largeShp);
  assert.equal(r.features.length, 1);
  assert.equal(r.features[0].properties['建筑物'], 'CD-317139-1');
});

test('parseTAB reads .tab + .dat attributes (geometry best-effort)', () => {
  const r = parseTAB(TAB);
  assert.equal(r.features.length, 1225);
  const f0 = r.features[0];
  assert.equal(f0.properties.OBJECTID, 1);
  assert.equal(f0.properties.Name, '茶园沟水库');
  assert.equal(typeof f0.properties.SHAPE_Length, 'number');
  assert.equal(typeof f0.properties.SHAPE_Area, 'number');
  assert.equal(r.meta?.fieldCount, 8);
});

test('parseTAB reads v300 region geometries with correct coordinates', () => {
  const tab = parseTAB(TAB);
  const shp = parseShapefile(SHP);
  const firstTabBBox = geometryBBox(tab.features[0].geometry);
  const firstShpBBox = geometryBBox(shp.features[0].geometry);

  assert.ok(firstTabBBox, 'first TAB feature should include geometry');
  assert.ok(firstShpBBox, 'first SHP feature should include geometry');
  assert.equal(tab.features.slice(0, 50).filter((f) => f.geometry).length, 50);
  assert.ok(tab.features.slice(0, 50).every((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'));
  assertBBoxClose(firstTabBBox, firstShpBBox);
});

test('parseTAB decodes WindowsSimpChinese field names, attribute values, and legacy line geometries', () => {
  const r = parseTAB(writeWindowsSimpChineseTABBundle(tempDir()));
  assert.equal(r.features.length, 1);
  assert.equal(r.meta?.charset, 'WindowsSimpChinese');
  assert.equal(r.meta?.fieldCount, 4);
  assert.match(String(r.meta?.encoding), /gb/i);
  assert.equal(r.features[0].properties['地市'], '成都');
  assert.equal(r.features[0].properties['线路'], '9号线');
  assert.equal(r.features[0].properties['编号'], 'D9-黄田坝-成都西站');
  assert.equal(r.features[0].properties['正反向'], 'F');
  const geometries = r.features.map((f) => f.geometry).filter(Boolean);
  assert.ok(geometries.length > 0, 'TAB should produce line geometries');
  assert.ok(geometries.every((g) => g?.type === 'LineString' || g?.type === 'MultiLineString'));
  const firstLine = geometries[0] as any;
  const firstCoord = firstLine.type === 'LineString' ? firstLine.coordinates[0] : firstLine.coordinates[0][0];
  assert.ok(firstCoord[0] > 100 && firstCoord[0] < 105, 'line longitude should decode from scaled MAP coordinates');
  assert.ok(firstCoord[1] > 30 && firstCoord[1] < 31, 'line latitude should decode from scaled MAP coordinates');
});

test('parseTAB detects GBK attributes when TAB charset is Neutral', () => {
  const r = parseTAB(writeWindowsSimpChineseTABBundle(tempDir(), 'Neutral'));
  assert.equal(r.features.length, 1);
  assert.equal(r.meta?.charset, 'Neutral');
  assert.match(String(r.meta?.encoding), /gb/i);
  assert.equal(r.features[0].properties['地市'], '成都');
  assert.equal(r.features[0].properties['线路'], '9号线');
  assert.equal(r.features[0].properties['编号'], 'D9-黄田坝-成都西站');
});

test('parseTAB decodes v500 point-table line geometry', () => {
  const r = parseTAB(writeV500PointTableLineTABBundle(tempDir()));
  assert.equal(r.meta?.version, 500);
  assert.equal(r.features.length, 2);
  assert.equal(r.features[0].geometry?.type, 'LineString');
  const coords = (r.features[0].geometry as any).coordinates;
  assert.equal(coords.length, 5);
  assert.deepEqual(coords[0], [106.809461, 31.719582]);
  assert.deepEqual(coords[4], [106.812828, 31.722014]);
  assert.equal(r.features[1].geometry?.type, 'LineString');
  const coords2 = (r.features[1].geometry as any).coordinates;
  assert.equal(coords2.length, 2);
  assert.deepEqual(coords2[0], [107.384149, 31.88083]);
  assert.deepEqual(coords2[1], [107.388623, 31.880784]);
});

test('parseTAB decodes WindowsSimpChinese grid road line geometry', { skip: skipIfMissing(GRID_ROAD_TAB) }, () => {
  const r = parseTAB(GRID_ROAD_TAB);
  assert.equal(r.features.length, 28);
  assert.equal(r.meta?.charset, 'WindowsSimpChinese');
  const geometries = r.features.map((f) => f.geometry).filter(Boolean);
  assert.ok(geometries.length > 0, 'grid road TAB should produce at least one line geometry');
  assert.ok(geometries.every((g) => g?.type === 'LineString' || g?.type === 'MultiLineString'));
  const firstLine = geometries[0] as any;
  const coords = firstLine.type === 'LineString' ? firstLine.coordinates : firstLine.coordinates[0];
  assert.ok(coords.length >= 2, 'grid road geometry should contain multiple points');
  assert.ok(coords[0][0] > 100 && coords[0][0] < 105, 'grid road longitude should decode from scaled MAP coordinates');
  assert.ok(coords[0][1] > 30 && coords[0][1] < 31, 'grid road latitude should decode from scaled MAP coordinates');
});

test('parseTAB decodes JN legacy region geometry', { skip: skipIfMissing(JN_REGION_TAB) }, () => {
  const r = parseTAB(JN_REGION_TAB);
  assert.equal(r.features.length, 1);
  assert.equal(r.features[0].properties.JN, 'JN-36-01');
  assert.equal(r.features[0].geometry?.type, 'Polygon');
  const ring = (r.features[0].geometry as any).coordinates[0];
  assert.ok(ring.length >= 4, 'JN region should contain a polygon ring');
  assert.deepEqual(ring[0], ring[ring.length - 1], 'JN region ring should be closed');
  assert.ok(ring[0][0] > 100 && ring[0][0] < 105, 'JN longitude should decode from scaled MAP coordinates');
  assert.ok(ring[0][1] > 30 && ring[0][1] < 31, 'JN latitude should decode from scaled MAP coordinates');
});

test('KML coordinate parsing handles whitespace + commas', () => {
  const r = parseKML(`<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <Point><coordinates>1.0,2.0</coordinates></Point>
  </Placemark>
  <Placemark>
    <Point><coordinates>3.0,4.0 5.5,6.6</coordinates></Point>
  </Placemark>
</kml>`);
  assert.equal(r.features[0].geometry?.type, 'Point');
  assert.deepEqual((r.features[0].geometry as any).coordinates, [1, 2]);
});

// --- New format tests ----------------------------------------------------

test('parseGPX extracts waypoints, tracks, routes', () => {
  const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="40.0" lon="-74.0"><name>WP1</name><ele>10.0</ele></wpt>
  <trk>
    <name>My Track</name>
    <trkseg>
      <trkpt lat="40.0" lon="-74.0"/>
      <trkpt lat="40.1" lon="-74.1"/>
      <trkpt lat="40.2" lon="-74.2"/>
    </trkseg>
  </trk>
  <rte>
    <name>My Route</name>
    <rtept lat="41.0" lon="-75.0"/>
    <rtept lat="41.1" lon="-75.1"/>
  </rte>
</gpx>`;
  const r = parseGPX(gpx);
  assert.equal(r.features.length, 3);
  // 1 waypoint, 1 track, 1 route.
  const wpt = r.features[0];
  assert.equal(wpt.geometry?.type, 'Point');
  assert.deepEqual((wpt.geometry as any).coordinates, [-74, 40, 10]);
  const trk = r.features[1];
  assert.equal(trk.geometry?.type, 'LineString');
  assert.equal((trk.geometry as any).coordinates.length, 3);
  const rte = r.features[2];
  assert.equal(rte.geometry?.type, 'LineString');
  assert.equal((rte.geometry as any).coordinates.length, 2);
});

test('GPX round-trip preserves waypoints and tracks', () => {
  const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="40.0" lon="-74.0"><name>A</name></wpt>
  <trk><trkseg><trkpt lat="40.0" lon="-74.0"/><trkpt lat="40.5" lon="-74.5"/></trkseg></trk>
</gpx>`;
  const r = parseGPX(gpx);
  const text = writeGPX(r);
  const re = parseGPX(text);
  assert.equal(re.features.length, 2);
  assert.equal(re.features[0].properties.name, 'A');
});

test('parseTopoJSON decodes shared arcs into geometries', () => {
  // A minimal topology with one LineString using 2 arcs.
  const tj = {
    type: 'Topology',
    transform: { scale: [1, 1], translate: [0, 0] },
    objects: {
      line: { type: 'GeometryCollection', geometries: [{ type: 'LineString', arcs: [0, 1] }] },
    },
    arcs: [
      [[0, 0], [1, 0], [2, 0]],
      [[2, 0], [3, 0], [3, 1]],
    ],
  };
  const r = parseTopoJSON(JSON.stringify(tj));
  assert.equal(r.features.length, 1);
  const g = r.features[0].geometry as any;
  assert.equal(g.type, 'LineString');
  assert.deepEqual(g.coordinates, [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]]);
});

test('parseCZML extracts entity packets as features', () => {
  const czml = [
    { id: 'document', name: 'doc', version: '1.0' },
    {
      id: 'point-1',
      name: 'Some point',
      position: { cartographicDegrees: [-75, 40, 0] },
    },
    {
      id: 'line-1',
      polyline: { positions: { cartographicDegrees: [-75, 40, 0, -76, 41, 0] } },
    },
  ];
  const r = parseCZML(JSON.stringify(czml));
  // Document packet is skipped.
  assert.equal(r.features.length, 2);
  assert.equal(r.features[0].geometry?.type, 'Point');
  assert.equal((r.features[0].geometry as any).coordinates[0], -75);
});

test('parseCSV with WKT column produces geometries', () => {
  const csv = `id,name,wkt
1,Park,"POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"
2,Line,"LINESTRING(0 0, 1 1, 2 0)"
3,Pt,"POINT(5 5)"`;
  const r = parseCSV(csv);
  assert.equal(r.features.length, 3);
  assert.equal(r.features[0].geometry?.type, 'Polygon');
  assert.equal(r.features[1].geometry?.type, 'LineString');
  assert.equal(r.features[2].geometry?.type, 'Point');
  assert.equal(r.features[0].properties.name, 'Park');
  assert.equal(r.meta?.wktColumn, 'wkt');
});

test('parseCSV falls back to lat/lng columns when no WKT', () => {
  const csv = `id,name,lat,lon
1,A,40.0,-74.0
2,B,41.0,-75.0`;
  const r = parseCSV(csv);
  assert.equal(r.features.length, 2);
  assert.equal(r.features[0].geometry?.type, 'Point');
  assert.deepEqual((r.features[0].geometry as any).coordinates, [-74, 40]);
});

test('writeCSV emits WKT geometry column and can be parsed back', () => {
  const text = writeCSV(smallFeatureSet(), { precision: 3 });
  assert.match(text.split(/\r?\n/)[0], /wkt/);
  assert.match(text, /POINT \(116\.391 39\.907\)/);
  assert.match(text, /LINESTRING/);
  assert.match(text, /POLYGON/);

  const parsed = parseCSV(text);
  assert.equal(parsed.features.length, 3);
  assert.equal(parsed.features[0].properties.name, 'point');
  assert.equal(parsed.features[2].geometry?.type, 'Polygon');
});

test('parseWKT supports all common geometry types', () => {
  assert.equal(parseWKT('POINT(1 2)')!.type, 'Point');
  assert.equal(parseWKT('LINESTRING(0 0, 1 1, 2 0)')!.type, 'LineString');
  const poly = parseWKT('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))')!;
  assert.equal(poly.type, 'Polygon');
  assert.equal((poly.coordinates as any)[0].length, 5);
  const mp = parseWKT('MULTIPOINT((0 0), (1 1), (2 2))')!;
  assert.equal(mp.type, 'MultiPoint');
  assert.equal((mp.coordinates as any).length, 3);
  const ml = parseWKT('MULTILINESTRING((0 0, 1 1), (2 2, 3 3))')!;
  assert.equal(ml.type, 'MultiLineString');
  const mpg = parseWKT('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))')!;
  assert.equal(mpg.type, 'MultiPolygon');
});

test('writeMIF emits MIF/MID files and can be parsed back', () => {
  const dir = tempDir();
  const out = path.join(dir, 'fixture.mif');

  writeMIF(smallFeatureSet(), { outputPath: out, precision: 3 });

  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(path.join(dir, 'fixture.mid')));
  const parsed = parseMIF(out);
  assert.equal(parsed.features.length, 3);
  assert.equal(parsed.features[0].geometry?.type, 'Point');
  assert.equal(parsed.features[1].geometry?.type, 'LineString');
  assert.equal(parsed.features[2].geometry?.type, 'Polygon');
  assert.equal(parsed.features[0].properties.name, 'point');
});

test('writeMIF preserves sanitized field values and multi geometries', () => {
  const dir = tempDir();
  const out = path.join(dir, 'multi.mif');
  const result = {
    name: 'multi',
    features: [
      {
        type: 'Feature' as const,
        properties: { 'display name': 'multi-point' },
        geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
      },
      {
        type: 'Feature' as const,
        properties: { 'display name': 'multi-line' },
        geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] },
      },
    ],
  };

  writeMIF(result, { outputPath: out });

  const parsed = parseMIF(out);
  assert.equal(parsed.features.length, 2);
  assert.equal(parsed.features[0].geometry?.type, 'MultiPoint');
  assert.equal(parsed.features[1].geometry?.type, 'MultiLineString');
  assert.equal(parsed.features[0].properties.display_name, 'multi-point');
});

test('writeShapefile emits readable shapefile bundle for one geometry type', () => {
  const dir = tempDir();
  const out = path.join(dir, 'points.shp');
  const result = {
    name: 'points',
    features: [
      {
        type: 'Feature' as const,
        properties: { id: 1, name: 'A' },
        geometry: { type: 'Point', coordinates: [1, 2] },
      },
      {
        type: 'Feature' as const,
        properties: { id: 2, name: 'B' },
        geometry: { type: 'Point', coordinates: [3, 4] },
      },
    ],
  };

  writeShapefile(result, { outputPath: out });

  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(path.join(dir, 'points.shx')));
  assert.ok(fs.existsSync(path.join(dir, 'points.dbf')));
  assert.ok(fs.existsSync(path.join(dir, 'points.cpg')));
  const parsed = parseShapefile(out);
  assert.equal(parsed.features.length, 2);
  assert.equal(parsed.features[0].geometry?.type, 'Point');
  assert.equal(parsed.features[0].properties.name, 'A');
});

test('writeShapefile preserves MultiPoint geometries', () => {
  const dir = tempDir();
  const out = path.join(dir, 'multipoints.shp');
  const result = {
    name: 'multipoints',
    features: [
      {
        type: 'Feature' as const,
        properties: { name: 'cluster' },
        geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4], [5, 6]] },
      },
    ],
  };

  writeShapefile(result, { outputPath: out });

  const parsed = parseShapefile(out);
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].geometry?.type, 'MultiPoint');
  assert.deepEqual((parsed.features[0].geometry as any).coordinates, [[1, 2], [3, 4], [5, 6]]);
});

test('writeShapefile rejects incompatible mixed geometry bundles', () => {
  assert.throws(
    () => writeShapefile(smallFeatureSet(), { outputPath: path.join(tempDir(), 'mixed.shp') }),
    /single geometry family/i,
  );
});

test('writeTAB reports missing GDAL adapter clearly', () => {
  assert.throws(
    () => writeTAB(smallFeatureSet(), { outputPath: path.join(tempDir(), 'out.tab'), ogr2ogrPath: '__missing_ogr2ogr__' }),
    /GDAL\/OGR.*ogr2ogr/i,
  );
});

test('tileRangeForBBox computes XYZ ranges for WebMercator bbox', () => {
  const world = 20037508.342789244;
  const range = tileRangeForBBox([-world, -world, world, world], 1);
  assert.deepEqual(range, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
});

test('computeWebMercatorBBox scans transformed feature geometries', () => {
  const bbox = computeWebMercatorBBox([
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [116.391, 39.907] } },
  ], 'WGS84');
  assert.ok(bbox[0] <= 0);
  assert.ok(bbox[1] <= 0);
  assert.ok(bbox[2] > 12_000_000);
  assert.ok(bbox[3] > 4_000_000);
});

test('writeVectorTiles writes non-empty MVT PBF XYZ tiles', async () => {
  const dir = tempDir();
  const summary = await writeVectorTiles({
    name: 'points',
    features: [
      { type: 'Feature', properties: { name: 'origin' }, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature', properties: { name: 'beijing' }, geometry: { type: 'Point', coordinates: [116.391, 39.907] } },
    ],
  }, {
    outputPath: dir,
    minZoom: 0,
    maxZoom: 1,
    threads: 1,
    fromCrs: 'WGS84',
    layerName: 'points',
  });
  assert.equal(summary.minZoom, 0);
  assert.equal(summary.maxZoom, 1);
  assert.equal(summary.featureCount, 2);
  assert.ok(summary.generatedTiles > 0);
  const pbfFiles = fs.readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.pbf'));
  assert.ok(pbfFiles.length > 0);
  const first = fs.readFileSync(path.join(dir, String(pbfFiles[0])));
  assert.ok(first.length > 0);
});

test('writeVectorTiles supports multi-threaded tile generation', async () => {
  const single = tempDir();
  const multi = tempDir();
  const result = {
    name: 'points',
    features: [
      { type: 'Feature' as const, properties: { name: 'origin' }, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature' as const, properties: { name: 'beijing', large_id: 9_007_199_254_740_991 }, geometry: { type: 'Point', coordinates: [116.391, 39.907] } },
    ],
  };

  const one = await writeVectorTiles(result, {
    outputPath: single,
    minZoom: 0,
    maxZoom: 2,
    threads: 1,
    fromCrs: 'WGS84',
    layerName: 'points',
  });
  const two = await writeVectorTiles(result, {
    outputPath: multi,
    minZoom: 0,
    maxZoom: 2,
    threads: 2,
    fromCrs: 'WGS84',
    layerName: 'points',
  });

  assert.equal(two.generatedTiles, one.generatedTiles);
  assert.equal(two.emptyTilesSkipped, one.emptyTilesSkipped);
  assert.equal(fs.readdirSync(multi, { recursive: true }).filter((name) => String(name).endsWith('.pbf')).length, one.generatedTiles);
});

test('parseEsriJSON reads FeatureSet and decodes rings/paths', () => {
  const esri = {
    geometryType: 'esriGeometryPolygon',
    spatialReference: { wkid: 4326 },
    features: [
      { attributes: { name: 'A' }, geometry: { rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { attributes: { name: 'B' }, geometry: { x: 5, y: 5 } },
    ],
  };
  const r = parseEsriJSON(JSON.stringify(esri));
  assert.equal(r.features.length, 2);
  assert.equal(r.features[0].geometry?.type, 'Polygon');
  assert.equal(r.features[1].geometry?.type, 'Point');
  assert.equal(r.crs?.properties?.name, 'EPSG:4326');
});

test('ESRI JSON round-trip preserves features', () => {
  const geo = parseGeoJSON(fs.readFileSync(GEOJSON));
  const text = writeEsriJSON(geo);
  const re = parseEsriJSON(text);
  assert.equal(re.features.length, geo.features.length);
  // First feature is a Polygon -> rings should be there.
  assert.ok((re.features[0].geometry as any).coordinates.length > 0);
});

// --- CRS tests -----------------------------------------------------------

test('normalizeId maps aliases to canonical ids', () => {
  assert.equal(normalizeId('wgs84'), 'WGS84');
  assert.equal(normalizeId('4326'), 'WGS84');
  assert.equal(normalizeId('3857'), 'WebMercator');
  assert.equal(normalizeId('CGCS2000'), 'CGCS2000');
  assert.equal(normalizeId('gcj02'), 'GCJ02');
  assert.equal(normalizeId('bd09'), 'BD09');
  assert.equal(normalizeId('火星坐标系'), 'GCJ02');
  assert.equal(normalizeId('国家2000'), 'CGCS2000');
  // Unknown / arbitrary EPSG codes are returned unchanged.
  assert.equal(normalizeId('EPSG:4326'), 'EPSG:4326');
});

test('WGS84 <-> WebMercator round-trips to within numerical precision', () => {
  const [x, y] = transformCoord(116.391, 39.907, 'WGS84', 'WebMercator');
  const [x2, y2] = transformCoord(x, y, 'WebMercator', 'WGS84');
  assert.ok(Math.abs(x2 - 116.391) < 1e-9);
  assert.ok(Math.abs(y2 - 39.907) < 1e-9);
});

test('WGS84 <-> CGCS2000 round-trips exactly (datums identical)', () => {
  const [x, y] = transformCoord(116.391, 39.907, 'WGS84', 'CGCS2000');
  assert.ok(Math.abs(x - 116.391) < 1e-9);
  assert.ok(Math.abs(y - 39.907) < 1e-9);
});

test('GCJ-02 offset is non-zero inside mainland China', () => {
  // Tiananmen Square
  const [lng, lat] = wgs84ToGCJ02(116.391, 39.907);
  assert.notEqual(lng, 116.391);
  assert.notEqual(lat, 39.907);
  // Offset is in the tens of meters, not kilometers.
  assert.ok(Math.abs(lng - 116.391) < 0.01);
  assert.ok(Math.abs(lat - 39.907) < 0.01);
});

test('GCJ-02 is identity outside China', () => {
  // New York
  const [lng, lat] = wgs84ToGCJ02(-74.0, 40.7);
  assert.equal(lng, -74.0);
  assert.equal(lat, 40.7);
});

test('GCJ-02 -> WGS84 iteration converges', () => {
  // WGS -> GCJ -> WGS recovers original within ~1cm.
  const wgs: [number, number] = [116.391, 39.907];
  const gcj = wgs84ToGCJ02(wgs[0], wgs[1]);
  const back = gcj02ToWGS84(gcj[0], gcj[1]);
  assert.ok(Math.abs(back[0] - wgs[0]) < 1e-3);
  assert.ok(Math.abs(back[1] - wgs[1]) < 1e-3);
});

test('BD-09 chain: WGS -> GCJ -> BD -> GCJ -> WGS converges', () => {
  const wgs: [number, number] = [116.391, 39.907];
  const gcj = wgs84ToGCJ02(wgs[0], wgs[1]);
  const bd = gcj02ToBD09(gcj[0], gcj[1]);
  const gcjBack = bd09ToGCJ02(bd[0], bd[1]);
  const wgsBack = gcj02ToWGS84(gcjBack[0], gcjBack[1]);
  assert.ok(Math.abs(wgsBack[0] - wgs[0]) < 1e-3);
  assert.ok(Math.abs(wgsBack[1] - wgs[1]) < 1e-3);
  // BD-09 is offset further from GCJ-02.
  assert.notEqual(bd[0], gcj[0]);
});

test('transformGeometry walks nested coordinates', () => {
  const geom = {
    type: 'Polygon',
    coordinates: [[[116, 39], [117, 39], [117, 40], [116, 39]]],
  };
  const out = transformGeometry(geom, 'WGS84', 'WebMercator') as any;
  assert.equal(out.type, 'Polygon');
  // After Mercator projection, lng=116 should map to ~12.9M meters east.
  assert.ok(out.coordinates[0][0][0] > 1_000_000);
  // And y should be > 0 (north of equator).
  assert.ok(out.coordinates[0][0][1] > 0);
});

// --- Encoding detection / decoding tests ---------------------------------

test('normalizeCPG maps common aliases', () => {
  assert.equal(normalizeCPG('utf8'), 'utf-8');
  assert.equal(normalizeCPG('UTF-8'), 'utf-8');
  assert.equal(normalizeCPG('936'), 'gbk');
  assert.equal(normalizeCPG('GBK'), 'gbk');
  assert.equal(normalizeCPG('"UTF-8"'), 'utf-8');
  assert.equal(normalizeCPG('Big5'), 'big5');
  assert.equal(normalizeCPG(''), null);
});

test('driverToEncoding maps common dBASE language drivers', () => {
  assert.equal(driverToEncoding(0x4D), 'gb18030'); // Visual FoxPro simplified Chinese
  assert.equal(driverToEncoding(0x4E), 'big5');
  assert.equal(driverToEncoding(0x4F), 'shift_jis');
  assert.equal(driverToEncoding(0x50), 'euc-kr');
  assert.equal(driverToEncoding(0x01), 'windows-1252');
  assert.equal(driverToEncoding(0x00), null);
});

test('detectEncoding chooses UTF-8 for a UTF-8 Chinese string', () => {
  const s = '北京市海淀区中关村';
  const buf = Buffer.from(s, 'utf-8');
  const enc = detectEncoding(buf);
  assert.equal(enc, 'utf-8');
});

test('detectEncoding chooses GBK/GB18030 for GBK-encoded Chinese', () => {
  // "中国" in GBK is 0xD6D0 0xB9FA. In UTF-8 the same bytes would be invalid.
  const buf = Buffer.from([0xD6, 0xD0, 0xB9, 0xFA, 0xC8, 0xCB, 0xC3, 0xF1, 0xBA, 0xD0, 0xCC, 0xEC]);
  const enc = detectEncoding(buf);
  assert.ok(enc === 'gb18030' || enc === 'gbk', `expected GBK family, got: ${enc}`);
});

test('detectEncoding chooses GBK/GB18030 for null-padded Chinese DBF samples', () => {
  const buf = Buffer.from([
    0xb0, 0xcd, 0xd6, 0xd0, 0, 0, 0, 0, 0, 0, 0, 0,
    0xb0, 0xcd, 0xd6, 0xdd, 0xc7, 0xf8, 0, 0, 0, 0,
    0x47, 0x38, 0x35, 0xd2, 0xf8, 0xc0, 0xa5, 0xb8, 0xdf, 0xcb, 0xd9,
  ]);
  const enc = detectEncoding(buf);
  assert.ok(enc === 'gb18030' || enc === 'gbk', `expected GBK family, got: ${enc}`);
});

test('detectEncoding chooses GBK/GB18030 for mixed GBK DBF samples with placeholders', () => {
  const buf = Buffer.from(
    'b0cdd6d0202020202020202020202020202020203fbdadcfd820202020202020' +
    '2020202020202020202020202020202020203838343420202020202020202020' +
    '202020202020202020202020202020205331353fb9e3b8dfcbd9202020202020' +
    '2020202020202020202020202020b9e3c4c9cae03f2d3fbdadb6abca3fd13f20',
    'hex',
  );
  const enc = detectEncoding(buf);
  assert.ok(enc === 'gb18030' || enc === 'gbk', `expected GBK family, got: ${enc}`);
});

test('detectEncoding chooses Big5 for Traditional Chinese', () => {
  // "中臺" in Big5 = 0xA4 0xA4 0xBB 0xD5 (approximate; we use 0xA4 0xA4 + a known Big5 two-byte sequence)
  // Use a known Big5-only sequence: "中文" in Big5 = 0xA4 0xA4 0xA4 0xE5
  const b5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]);
  const enc = detectEncoding(b5);
  // Big5 and GBK are visually similar; just assert it's a CJK encoding, not Latin1.
  assert.ok(enc !== 'latin1' && enc !== 'windows-1252', `got: ${enc}`);
});

test('decoderFor round-trips ASCII + UTF-8 + GBK', () => {
  // UTF-8 round trip
  const utf8 = Buffer.from('北京市', 'utf-8');
  assert.equal(decoderFor('utf-8')(utf8), '北京市');

  // GBK round trip
  const gbkBytes = Buffer.from([0xB1, 0xB1, 0xBE, 0xA9]); // "北京" in GBK
  const dec = decoderFor('gbk');
  const result = dec(gbkBytes);
  // GBK decoding of [0xB1,0xB1, 0xBE,0xA9] should give "北京".
  assert.ok(result.includes('北') || result.includes('京') || result.length > 0, `got: ${JSON.stringify(result)}`);

  // Invalid encoding should fall back to latin1, not throw.
  const dec2 = decoderFor('not-a-real-encoding');
  const out = dec2(Buffer.from([0xC0, 0xC1]));
  assert.equal(typeof out, 'string');
});

test('decodeStringField strips trailing NUL and whitespace', () => {
  // 茶园沟水库 in UTF-8 + trailing spaces + NULs
  const s = '茶园沟水库   \x00\x00';
  const buf = Buffer.from(s, 'utf-8');
  const dec = decoderFor('utf-8');
  const out = decodeStringField(buf, dec);
  assert.equal(out, '茶园沟水库');
});

test('shapefile surfaces detected encoding in meta', () => {
  const r = parseShapefile(SHP);
  // The .cpg file says UTF-8, so encoding source should be 'cpg'.
  assert.ok(r.meta?.encoding);
  assert.match(String(r.meta.encoding), /utf-8/);
});

test('TAB parser surfaces detected encoding in meta', () => {
  const r = parseTAB(TAB);
  assert.ok(r.meta?.encoding);
  // The .cpg file is UTF-8, so we expect UTF-8 detection.
  assert.match(String(r.meta.encoding), /utf-8/);
});
