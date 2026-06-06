/**
 * TopoJSON parser.
 *
 * TopoJSON encodes geometries as shared arcs referenced by index. To
 * convert to GeoJSON we rehydrate the arc topology into concrete
 * coordinate arrays.
 *
 * Reference: https://github.com/topojson/topojson-specification
 */
import * as fs from 'node:fs';
import type { Feature, Geometry, ParseResult, Properties } from '../types.js';

interface TopoArc {
  coordinates: number[][];
}
interface TopoGeometry {
  type: string; // Point / LineString / Polygon / MultiPoint / MultiLineString / MultiPolygon / GeometryCollection
  /** Either an arc id (for LineString/Polygon) or an array of arc ids. */
  arcs?: number | number[] | number[][] | number[][][];
  coordinates?: any; // For Point / MultiPoint, raw coordinates are inlined.
  geometries?: TopoGeometry[];
  properties?: Properties;
  id?: string | number;
}

export function parseTopoJSON(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`TopoJSON parse error: ${(e as Error).message}`);
  }
  if (!data || data.type !== 'Topology') throw new Error('Not a TopoJSON Topology');
  const arcs: TopoArc[] = (data.arcs ?? []).map((a: number[][]) => ({ coordinates: a }));
  const transform = data.transform;
  const features: Feature[] = [];
  for (const [layerName, layer] of Object.entries<any>(data.objects ?? {})) {
    const geometries: TopoGeometry[] = (layer as any).geometries ?? [];
    for (const g of geometries) {
      features.push(geometryToFeature(g, arcs, transform, layerName));
    }
  }
  return {
    name: data.name ?? Object.keys(data.objects ?? {})[0],
    features,
    bbox: data.bbox,
    meta: { source: 'topojson', layers: Object.keys(data.objects ?? {}) },
  };
}

function geometryToFeature(
  g: TopoGeometry,
  arcsRef: TopoArc[],
  transform: { scale: [number, number]; translate: [number, number] } | undefined,
  layer: string,
): Feature {
  const properties: Properties = { ...(g.properties ?? {}), _layer: layer };
  let geometry: Geometry;
  switch (g.type) {
    case 'Point':
      geometry = { type: 'Point', coordinates: applyTransform(g.coordinates, transform) };
      break;
    case 'MultiPoint':
      geometry = { type: 'MultiPoint', coordinates: (g.coordinates ?? []).map((c: number[]) => applyTransform(c, transform)) };
      break;
    case 'LineString':
      geometry = { type: 'LineString', coordinates: resolveArcs((g.arcs as number[]) ?? [], arcsRef, transform, false) };
      break;
    case 'MultiLineString':
      geometry = { type: 'MultiLineString', coordinates: ((g.arcs as number[][]) ?? []).map((a) => resolveArcs(a, arcsRef, transform, false)) };
      break;
    case 'Polygon':
      geometry = { type: 'Polygon', coordinates: ((g.arcs as number[][]) ?? []).map((a) => resolveArcs(a, arcsRef, transform, true)) };
      break;
    case 'MultiPolygon': {
      const polys = (g.arcs as unknown as number[][][][]) ?? [];
      geometry = {
        type: 'MultiPolygon',
        coordinates: polys.map((poly) => {
          const rings: number[][][] = [];
          for (const a of poly) {
            rings.push(resolveArcs(a as unknown as number[], arcsRef, transform, true));
          }
          return rings;
        }),
      };
      break;
    }

    case 'GeometryCollection':
      geometry = {
        type: 'GeometryCollection',
        geometries: (g.geometries ?? []).map((sub) => geometryToFeature(sub, arcsRef, transform, layer).geometry as Geometry),
      } as any;
      break;
    default:
      geometry = { type: 'GeometryCollection', geometries: [] } as any;
  }
  const f: Feature = { type: 'Feature', geometry, properties };
  if (g.id !== undefined) f.id = g.id;
  return f;
}

function applyTransform(c: number[] | undefined, t: { scale: [number, number]; translate: [number, number] } | undefined): number[] {
  if (!c) return [];
  if (!t) return c;
  return [c[0] * t.scale[0] + t.translate[0], c[1] * t.scale[1] + t.translate[1]];
}

function resolveArcs(
  arcIds: number[],
  arcs: TopoArc[],
  transform: { scale: [number, number]; translate: [number, number] } | undefined,
  closed: boolean,
): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < arcIds.length; i++) {
    const id = arcIds[i];
    // Negative id = reversed arc.
    const idx = id >= 0 ? id : ~id;
    const arc = arcs[idx];
    if (!arc) continue;
    const coords = transform ? arc.coordinates.map((c) => applyTransform(c, transform)) : arc.coordinates;
    if (id < 0) coords.reverse();
    if (i > 0) coords.shift(); // Deduplicate shared endpoint.
    for (const c of coords) out.push(c);
  }
  if (closed && out.length > 0) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  }
  return out;
}

export function convertTopoJSON(inputPath: string, outputPath?: string): ParseResult {
  const result = parseTopoJSON(fs.readFileSync(inputPath));
  if (outputPath) {
    // Write as GeoJSON FeatureCollection.
    const text = JSON.stringify(
      { type: 'FeatureCollection', name: result.name, features: result.features, bbox: result.bbox },
      null,
      2,
    );
    fs.writeFileSync(outputPath, text, 'utf8');
  }
  return result;
}
