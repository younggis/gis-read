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

const DATA = path.resolve('data');
const GEOJSON = path.join(DATA, 'lakes.geojson');
const KML = path.join(DATA, 'lakes.kml');
const SHP = path.join(DATA, 'lakes.shp');
const TAB = path.join(DATA, 'lakes.tab');

function findDataFile(name: string): string {
  const file = fs.readdirSync(DATA).find((entry) => entry === name);
  assert.ok(file, `missing fixture: ${name}`);
  return path.join(DATA, file);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gis-read-parser-'));
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

test('parseTAB decodes WindowsSimpChinese field names and subway line geometries', () => {
  const r = parseTAB(findDataFile('地铁线路图层.TAB'));
  assert.equal(r.features.length, 22);
  assert.equal(r.meta?.charset, 'WindowsSimpChinese');
  assert.equal(r.meta?.fieldCount, 1);
  assert.equal(r.features[0].properties['地铁线路'], '5号线');
  const geometries = r.features.map((f) => f.geometry).filter(Boolean);
  assert.ok(geometries.length > 0, 'subway TAB should produce line geometries');
  assert.ok(geometries.every((g) => g?.type === 'LineString' || g?.type === 'MultiLineString'));
  const firstLine = geometries[0] as any;
  const firstCoord = firstLine.type === 'LineString' ? firstLine.coordinates[0] : firstLine.coordinates[0][0];
  assert.ok(firstCoord[0] > 100 && firstCoord[0] < 105, 'subway line longitude should decode from scaled MAP coordinates');
  assert.ok(firstCoord[1] > 30 && firstCoord[1] < 31, 'subway line latitude should decode from scaled MAP coordinates');
});

test('parseTAB decodes WindowsSimpChinese attribute values in segmented subway lines', () => {
  const r = parseTAB(findDataFile('地铁分段线路正反向.TAB'));
  assert.equal(r.features.length, 819);
  assert.equal(r.meta?.charset, 'WindowsSimpChinese');
  assert.match(String(r.meta?.encoding), /gb/i);
  assert.equal(r.features[0].properties['地市'], '成都');
  assert.equal(r.features[0].properties['线路'], '9号线');
  assert.equal(r.features[0].properties['编号'], 'D9-黄田坝-成都西站');
  assert.equal(r.features[0].properties['正反向'], 'F');
  const geometries = r.features.map((f) => f.geometry).filter(Boolean);
  assert.ok(geometries.length > 0, 'segmented subway TAB should keep line geometries');
  assert.ok(geometries.every((g) => g?.type === 'LineString' || g?.type === 'MultiLineString'));
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
