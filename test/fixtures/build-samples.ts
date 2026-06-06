/**
 * Build real-format sample files in `data/` from `data/lakes.geojson`.
 *
 * These siblings (`lakes.gpx`, `lakes.topojson`, `lakes.czml`,
 * `lakes.esrijson`, `lakes.csv`, `lakes.mif`+`lakes.mid`) feed the
 * end-to-end CLI tests. Output is checked in; run this script once
 * (or via `npm run pretest`) when the upstream `lakes.geojson` changes.
 *
 *   tsx test/fixtures/build-samples.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseGeoJSON } from '../../src/parsers/geojson.js';
import { geometryToWKT } from '../../src/parsers/csv-wkt.js';

const DATA = path.resolve('data');
const SRC = path.join(DATA, 'lakes.geojson');

function centroidOf(geom: any): [number, number] | null {
  if (!geom) return null;
  let ring: number[][] | null = null;
  if (geom.type === 'Point') return [geom.coordinates[0], geom.coordinates[1]];
  if (geom.type === 'Polygon') ring = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon' && geom.coordinates[0]?.[0]) ring = geom.coordinates[0][0];
  if (!ring || ring.length === 0) return null;
  let sx = 0, sy = 0, n = 0;
  for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return [sx / n, sy / n];
}

function buildGPX(features: any[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="gis-read" xmlns="http://www.topografix.com/GPX/1/1">');
  lines.push('  <metadata><name>lakes</name></metadata>');
  // First 100 features as waypoints (centroids). Avoids 1225 redundant wpt elements.
  for (let i = 0; i < Math.min(100, features.length); i++) {
    const c = centroidOf(features[i].geometry);
    if (!c) continue;
    const name = String(features[i].properties?.Name ?? `lake-${i}`);
    lines.push(`  <wpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"><name>${escapeXml(name)}</name></wpt>`);
  }
  // First feature as a track using its outer ring (line-only, since GPX
  // has no native polygon type).
  if (features[0]?.geometry?.type === 'MultiPolygon') {
    const ring = features[0].geometry.coordinates[0][0];
    const name = String(features[0].properties?.Name ?? 'track-0');
    lines.push(`  <trk><name>${escapeXml(name)}</name><trkseg>`);
    for (const [x, y] of ring) lines.push(`    <trkpt lat="${y.toFixed(6)}" lon="${x.toFixed(6)}"/>`);
    lines.push('  </trkseg></trk>');
  }
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

function buildTopoJSON(features: any[]): string {
  // Construct a minimal Topology that contains LineStrings (built from
  // polygon outer rings). All arcs are flat, no transform, so a simple
  // version of parseTopoJSON will round-trip them.
  const round = (n: number) => Number(n.toFixed(6));
  const arcs: number[][][] = [];
  const geometries: any[] = [];
  for (let i = 0; i < features.length; i++) {
    const g = features[i].geometry;
    let ring: number[][] | null = null;
    if (g?.type === 'Polygon') ring = g.coordinates[0];
    else if (g?.type === 'MultiPolygon') ring = g.coordinates?.[0]?.[0];
    if (!ring || ring.length < 2) continue;
    const arcId = arcs.length;
    arcs.push(ring.map(([x, y]) => [round(x), round(y)]));
    geometries.push({
      type: 'LineString',
      arcs: [arcId],
      properties: { OBJECTID: features[i].properties?.OBJECTID ?? i, Name: features[i].properties?.Name ?? '' },
    });
  }
  return JSON.stringify({
    type: 'Topology',
    name: 'lakes',
    objects: { lakes: { type: 'GeometryCollection', geometries } },
    arcs: arcs,
  });
}

function buildCZML(features: any[]): string {
  const packets: any[] = [{ id: 'document', name: 'lakes', version: '1.0' }];
  for (let i = 0; i < features.length; i++) {
    const c = centroidOf(features[i].geometry);
    if (!c) continue;
    packets.push({
      id: `lake-${i}`,
      name: features[i].properties?.Name ?? `lake-${i}`,
      description: features[i].properties?.Comment ?? '',
      position: { cartographicDegrees: [c[0], c[1], 0] },
      properties: {
        OBJECTID: features[i].properties?.OBJECTID,
        SHAPE_Area: features[i].properties?.SHAPE_Area,
      },
    });
  }
  return JSON.stringify(packets, null, 0);
}

function buildEsriJSON(features: any[]): string {
  const round = (n: number) => Number(n.toFixed(6));
  const roundRing = (ring: number[][]) => ring.map(([x, y]) => [round(x), round(y)]);
  const out = {
    geometryType: 'esriGeometryPolygon',
    spatialReference: { wkid: 4326 },
    features: features.map((f) => ({
      attributes: f.properties,
      geometry: f.geometry?.type === 'MultiPolygon'
        ? { rings: f.geometry.coordinates.flatMap((poly: any) => poly.map(roundRing)) }
        : f.geometry?.type === 'Polygon'
        ? { rings: f.geometry.coordinates.map(roundRing) }
        : null,
    })),
  };
  return JSON.stringify(out);
}

function buildCSV(features: any[]): string {
  const cols = ['OBJECTID', 'Name', 'Comment', 'SHAPE_Length', 'SHAPE_Area', 'wkt'];
  const rows: string[] = [cols.join(',')];
  for (const f of features) {
    const wkt = geometryToWKT(f.geometry);
    if (!wkt) continue;
    const vals = [
      f.properties?.OBJECTID ?? '',
      csvQuote(f.properties?.Name ?? ''),
      csvQuote(f.properties?.Comment ?? ''),
      f.properties?.SHAPE_Length ?? '',
      f.properties?.SHAPE_Area ?? '',
      csvQuote(wkt),
    ];
    rows.push(vals.join(','));
  }
  return rows.join('\n') + '\n';
}

function buildMIF(features: any[]): { mif: string; mid: string } {
  const mifLines: string[] = [
    'Version 300',
    'Charset "WindowsLatin1"',
    'Delimiter ","',
    'Columns 3',
    '  OBJECTID Integer',
    '  Name Char(254)',
    '  SHAPE_Area Float',
    'Data',
  ];
  const midLines: string[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g?.type !== 'MultiPolygon' && g?.type !== 'Polygon') continue;
    const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const polyCount = polys.length;
    mifLines.push(`Region ${polyCount}`);
    for (const poly of polys) {
      const ring = poly[0];
      mifLines.push(`  ${ring.length}`);
      for (const [x, y] of ring) mifLines.push(`    ${x.toFixed(6)} ${y.toFixed(6)}`);
    }
    // MIF sections are separated by a blank line. Without it, the parser
    // fuses consecutive regions into one record.
    mifLines.push('');
    midLines.push([
      f.properties?.OBJECTID ?? '',
      csvQuote(String(f.properties?.Name ?? '')),
      f.properties?.SHAPE_Area ?? '',
    ].join('\t'));
  }
  return { mif: mifLines.join('\n') + '\n', mid: midLines.join('\n') + '\n' };
}

function csvQuote(s: string): string {
  if (s == null) return '';
  const t = String(s);
  if (t.includes(',') || t.includes('"') || t.includes('\n')) {
    return '"' + t.replace(/"/g, '""') + '"';
  }
  return t;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeIfChanged(file: string, content: string): boolean {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source missing: ${SRC}`);
    process.exit(1);
  }
  console.log(`Reading ${SRC}...`);
  const r = parseGeoJSON(fs.readFileSync(SRC));
  console.log(`  ${r.features.length} features`);

  // Clean up artifacts from manual repros.
  for (const stale of ['out.kml', 'test-kml.kml']) {
    const p = path.join(DATA, stale);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const tasks: Array<[string, () => string]> = [
    ['lakes.gpx', () => buildGPX(r.features)],
    ['lakes.topojson', () => buildTopoJSON(r.features)],
    ['lakes.czml', () => buildCZML(r.features)],
    ['lakes.esrijson', () => buildEsriJSON(r.features)],
    ['lakes.csv', () => buildCSV(r.features)],
  ];
  for (const [name, fn] of tasks) {
    const content = fn();
    const changed = writeIfChanged(path.join(DATA, name), content);
    console.log(`  ${changed ? 'wrote' : 'unchanged'} ${name} (${content.length} bytes)`);
  }
  const { mif, mid } = buildMIF(r.features);
  console.log(`  ${writeIfChanged(path.join(DATA, 'lakes.mif'), mif) ? 'wrote' : 'unchanged'} lakes.mif (${mif.length} bytes)`);
  console.log(`  ${writeIfChanged(path.join(DATA, 'lakes.mid'), mid) ? 'wrote' : 'unchanged'} lakes.mid (${mid.length} bytes)`);

  console.log('Done.');
}

main();
