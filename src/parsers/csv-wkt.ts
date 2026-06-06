/**
 * WKT (Well-Known Text) serializer for GeoJSON geometries.
 *
 * Inverse of `parseWKT` in `csv.ts`. Used by sample-data generation and
 * by anything that needs to produce a single-string geometry column
 * (CSV, SQL, etc.).
 */
import type { Geometry } from '../types.js';

const fmt = (n: number, precision: number) => n.toFixed(precision);

function pt(c: number[], p: number): string {
  return `${fmt(c[0], p)} ${fmt(c[1], p)}`;
}

function ptList(arr: number[][], p: number): string {
  return arr.map((c) => pt(c, p)).join(', ');
}

function ringList(rings: number[][][], p: number): string {
  return rings.map((r) => `(${ptList(r, p)})`).join(', ');
}

export function geometryToWKT(geom: Geometry | null | undefined, precision: number = 6): string {
  if (!geom) return '';
  switch (geom.type) {
    case 'Point':
      return `POINT (${pt(geom.coordinates as number[], precision)})`;
    case 'LineString':
      return `LINESTRING (${ptList(geom.coordinates as number[][], precision)})`;
    case 'Polygon':
      return `POLYGON (${ringList(geom.coordinates as number[][][], precision)})`;
    case 'MultiPoint':
      return `MULTIPOINT (${(geom.coordinates as number[][]).map((c) => `(${pt(c, precision)})`).join(', ')})`;
    case 'MultiLineString':
      return `MULTILINESTRING (${(geom.coordinates as number[][][]).map((l) => `(${ptList(l, precision)})`).join(', ')})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON (${(geom.coordinates as number[][][][]).map((p) => `(${ringList(p, precision)})`).join(', ')})`;
    default:
      return '';
  }
}
