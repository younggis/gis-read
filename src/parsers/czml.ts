/**
 * CZML parser.
 *
 * CZML is a JSON-based format used by Cesium. A CZML document is a
 * stream of "packets"; the first packet typically describes the document
 * itself (clock, etc.) and subsequent packets describe entities. We
 * convert each entity packet into a GeoJSON feature.
 *
 * Reference: https://github.com/AnalyticalGraphicsInc/czml-writer/wiki/CZML-Structure
 */
import * as fs from 'node:fs';
import type { Feature, Geometry, ParseResult, Properties } from '../types.js';

export function parseCZML(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`CZML parse error: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new Error('CZML must be a JSON array of packets');

  const features: Feature[] = [];
  let name: string | undefined;
  for (let i = 0; i < data.length; i++) {
    const packet = data[i];
    if (!packet || typeof packet !== 'object') continue;
    // First packet is typically the document; the rest are entities.
    if (i === 0) {
      if (packet.name) name = packet.name;
      continue;
    }
    const f = packetToFeature(packet);
    if (f) features.push(f);
  }
  return { name, features, meta: { source: 'czml', packets: data.length } };
}

function packetToFeature(p: any): Feature | null {
  const id = p.id;
  const props: Properties = { id };
  if (p.name) props.name = p.name;
  if (p.description) props.description = p.description;
  for (const [k, v] of Object.entries(p)) {
    if (['id', 'name', 'description', 'position', 'polyline', 'polygon', 'point', 'billboard', 'label', 'model', 'path', 'ellipse', 'corridor', 'rectangle', 'wall', 'cylinder', 'box'].includes(k)) continue;
    props[k] = v;
  }

  if (p.position) {
    return { type: 'Feature', geometry: czmlPositionToGeometry(p.position), properties: props, id };
  }
  if (p.polyline?.positions) {
    return { type: 'Feature', geometry: czmlPositionToGeometry(p.polyline.positions, 'polyline'), properties: props, id };
  }
  if (p.polygon?.positions) {
    return { type: 'Feature', geometry: czmlPositionToGeometry(p.polygon.positions, 'polygon'), properties: props, id };
  }
  if (p.point) {
    return { type: 'Feature', geometry: null, properties: { ...props, _kind: 'point' }, id };
  }
  return null;
}

/** Convert a CZML position reference to a geometry. The position may be
 *  - a number array `[lng, lat, h]`
 *  - an object like `{ cartographicDegrees: [...] }`
 *  - an array of arrays (LineString / Polygon ring)
 *  - an array of arrays of arrays (MultiLineString or Polygon with rings)
 *  - a property reference (string): in that case we can't resolve, skip.
 */
function czmlPositionToGeometry(pos: any, hint: 'point' | 'polyline' | 'polygon' = 'point'): Geometry | null {
  if (typeof pos === 'string') return null;
  if (pos && typeof pos === 'object' && !Array.isArray(pos)) {
    // Reference form like { cartographicDegrees: [...], cartesian: [...] }.
    for (const k of ['cartographicDegrees', 'cartographicRadians', 'cartesian']) {
      if (Array.isArray(pos[k])) {
        return czmlPositionToGeometry(pos[k], hint);
      }
    }
    return null;
  }
  if (!Array.isArray(pos) || pos.length === 0) return null;
  const first = pos[0];
  if (typeof first === 'number') {
    return hint === 'polygon'
      ? { type: 'Polygon', coordinates: [pos] }
      : hint === 'polyline'
        ? { type: 'LineString', coordinates: pos }
        : { type: 'Point', coordinates: pos };
  }
  if (Array.isArray(first)) {
    if (typeof first[0] === 'number') {
      // Single ring.
      return hint === 'polygon' || hint === 'polyline'
        ? { type: hint === 'polygon' ? 'Polygon' : 'LineString', coordinates: hint === 'polygon' ? [pos] : pos }
        : { type: 'LineString', coordinates: pos };
    }
    if (Array.isArray(first[0])) {
      // Multi: rings for polygon, lines for polyline.
      return hint === 'polygon'
        ? { type: 'Polygon', coordinates: pos }
        : { type: 'MultiLineString', coordinates: pos };
    }
  }
  return null;
}

export function convertCZML(inputPath: string, outputPath?: string): ParseResult {
  const result = parseCZML(fs.readFileSync(inputPath));
  if (outputPath) {
    const text = JSON.stringify({ type: 'FeatureCollection', name: result.name, features: result.features }, null, 2);
    fs.writeFileSync(outputPath, text, 'utf8');
  }
  return result;
}
