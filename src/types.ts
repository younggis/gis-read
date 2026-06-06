/**
 * Common types used across GIS data parsers and writers.
 */

/** A 2D coordinate pair [x, y], optionally with z. */
export type Position = number[];

/** A linear ring of positions; first and last positions must be equal. */
export type LinearRing = Position[];

/** GeoJSON-compatible geometry object. */
export interface Geometry {
  type: string;
  coordinates: any;
}

/** Feature properties bag (free-form key/value). */
export type Properties = Record<string, unknown>;

/** A single feature: geometry + properties + optional id. */
export interface Feature {
  type: 'Feature';
  geometry: Geometry | null;
  properties: Properties;
  id?: string | number;
}

/** A collection of features, optionally with a name. */
export interface FeatureCollection {
  type: 'FeatureCollection';
  name?: string;
  features: Feature[];
  crs?: CRS;
  bbox?: BBox;
}

/** Bounding box [minX, minY, maxX, maxY] (or with z/m). */
export type BBox = [number, number, number, number] | number[];

/** Coordinate Reference System description. */
export interface CRS {
  type: 'name' | 'link';
  properties: { name?: string; href?: string };
}

/** Result returned by a parser. */
export interface ParseResult {
  name?: string;
  features: Feature[];
  crs?: CRS;
  bbox?: BBox;
  /** Format-specific metadata (driver info, layer count, etc.). */
  meta?: Record<string, unknown>;
}

/** Options controlling the parser. */
export interface ParseOptions {
  /** Limit number of features parsed (0 = no limit). */
  limit?: number;
  /** Bounding box filter [minX, minY, maxX, maxY]. */
  bbox?: BBox;
  /** Property names to include (others dropped). */
  propertyFilter?: string[];
}

/** Options controlling the writer. */
export interface WriteOptions {
  /** Output path; if omitted, writer returns string. */
  outputPath?: string;
  /** Pretty-print output. */
  pretty?: boolean;
  /** Coordinate precision (digits after decimal). */
  precision?: number;
  /** CRS to embed. */
  crs?: CRS;
  /** Layer / type name. */
  name?: string;
}
