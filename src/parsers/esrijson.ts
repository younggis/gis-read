/**
 * ESRI JSON parser and writer.
 *
 * ESRI's JSON format mirrors their shapefile geometry model. The
 * coordinate layout is `[x, y]` (or `[x, y, z]`), and a `spatialReference`
 * block carries the WKID.
 *
 * Reference: https://developers.arcgis.com/documentation/common-data-types/geometry-objects.htm
 */
import * as fs from 'node:fs';
import type { Feature, Geometry, ParseResult, Properties, WriteOptions } from '../types.js';

export function parseEsriJSON(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`ESRI JSON parse error: ${(e as Error).message}`);
  }

  let features: Feature[] = [];
  let name: string | undefined;
  let crs: any;

  if (data?.geometryType || data?.features) {
    // FeatureSet.
    name = data.name;
    if (data.spatialReference) crs = esriSRToCRS(data.spatialReference);
    features = (data.features ?? []).map((f: any) => esriFeatureToFeature(f, crs));
  } else if (data?.geometry) {
    // Single feature wrapper (e.g. a record from query endpoint).
    features = [esriFeatureToFeature(data, crs)];
  } else if (data?.x !== undefined && data?.y !== undefined) {
    // Bare geometry.
    features = [{ type: 'Feature', geometry: esriGeomToGeometry(data), properties: {} }];
  } else {
    throw new Error('Unrecognized ESRI JSON structure');
  }

  return { name, features, crs, meta: { source: 'esrijson' } };
}

function esriSRToCRS(sr: any): any {
  if (sr?.wkid) {
    return { type: 'name', properties: { name: `EPSG:${sr.wkid}` } };
  }
  if (sr?.wkt) {
    return { type: 'name', properties: { name: sr.wkt } };
  }
  return undefined;
}

function esriFeatureToFeature(f: any, crs?: any): Feature {
  return {
    type: 'Feature',
    geometry: f.geometry ? esriGeomToGeometry(f.geometry) : null,
    properties: f.attributes ?? {},
    id: f.id,
  };
}

function esriGeomToGeometry(g: any): Geometry | null {
  if (!g) return null;
  switch (g.rings) {
    case undefined:
      break;
    default:
      return { type: g.rings.length > 1 ? 'MultiPolygon' : 'Polygon', coordinates: g.rings };
  }
  if (g.paths) {
    return g.paths.length > 1 ? { type: 'MultiLineString', coordinates: g.paths } : { type: 'LineString', coordinates: g.paths[0] };
  }
  if (g.points) {
    return g.points.length > 1 ? { type: 'MultiPoint', coordinates: g.points } : { type: 'Point', coordinates: g.points[0] };
  }
  if (g.x !== undefined && g.y !== undefined) {
    return { type: 'Point', coordinates: g.z !== undefined ? [g.x, g.y, g.z] : [g.x, g.y] };
  }
  return null;
}

// --- Writer -------------------------------------------------------------

export function writeEsriJSON(result: ParseResult, opts: WriteOptions = {}): string {
  const wkid = (() => {
    if (!opts.crs?.properties?.name) return 4326;
    const m = String(opts.crs.properties.name).match(/EPSG:(\d+)/i);
    return m ? Number(m[1]) : 4326;
  })();
  const out = {
    geometryType: 'esriGeometryPolygon', // overwritten per feature below
    spatialReference: { wkid },
    features: result.features.map((f) => featureToEsri(f)),
  };
  return JSON.stringify(out, null, opts.pretty === false ? undefined : 2);
}

function featureToEsri(f: Feature): any {
  const g = f.geometry;
  const attrs = f.properties ?? {};
  if (!g) return { attributes: attrs };
  if (g.type === 'Point') {
    const c = g.coordinates as number[];
    return c.length === 3 ? { attributes: attrs, geometry: { x: c[0], y: c[1], z: c[2] } } : { attributes: attrs, geometry: { x: c[0], y: c[1] } };
  }
  if (g.type === 'MultiPoint') {
    return { attributes: attrs, geometry: { points: g.coordinates } };
  }
  if (g.type === 'LineString') {
    return { attributes: attrs, geometry: { paths: [g.coordinates] } };
  }
  if (g.type === 'MultiLineString') {
    return { attributes: attrs, geometry: { paths: g.coordinates } };
  }
  if (g.type === 'Polygon') {
    return { attributes: attrs, geometry: { rings: g.coordinates } };
  }
  if (g.type === 'MultiPolygon') {
    return { attributes: attrs, geometry: { rings: (g.coordinates as number[][][][]).flat() } };
  }
  return { attributes: attrs };
}

export function convertEsriJSON(inputPath: string, outputPath?: string): ParseResult {
  const result = parseEsriJSON(fs.readFileSync(inputPath));
  if (outputPath) fs.writeFileSync(outputPath, writeEsriJSON(result), 'utf8');
  return result;
}
