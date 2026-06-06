/**
 * GeoJSON parser and writer.
 *
 * Two parsing modes:
 *   - `parseGeoJSON(buffer)` — load whole file into memory. Fast, OK for
 *     files up to a few hundred MB.
 *   - `parseGeoJSONStream(path)` — async generator that yields one feature
 *     at a time. Memory usage is bounded by the largest single feature.
 *
 * Writing always uses the in-memory representation. For multi-GB outputs,
 * consider using the streaming converter at the CLI layer instead.
 */
import * as fs from 'node:fs';
import type { Feature, FeatureCollection, ParseResult, WriteOptions } from '../types.js';
import { log } from '../logger.js';
import { formatBytes } from '../io.js';
import { parseGeoJSONStream } from './geojson-stream.js';

export function parseGeoJSON(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(`GeoJSON parse error: ${msg}. (Tip: for files > 256 MB use the streaming API.)`);
  }
  return normalize(data);
}

/**
 * Choose the right parsing mode based on file size. Files above the
 * streaming threshold (256 MB by default) are parsed feature-by-feature;
 * smaller files are loaded into memory.
 */
export async function parseGeoJSONAuto(
  filePath: string,
  opts: { streamingThresholdBytes?: number; onProgress?: (bytes: number, total: number) => void } = {},
): Promise<ParseResult> {
  const stat = fs.statSync(filePath);
  const threshold = opts.streamingThresholdBytes ?? 256 * 1024 * 1024;
  if (stat.size <= threshold) {
    log.debug(`Reading ${filePath} (${formatBytes(stat.size)}) in memory`);
    return parseGeoJSON(fs.readFileSync(filePath));
  }
  log.info(`Streaming ${filePath} (${formatBytes(stat.size)}) — large file mode`);
  const features: Feature[] = [];
  for await (const f of parseGeoJSONStream(filePath, { onProgress: opts.onProgress })) {
    features.push(f);
  }
  return {
    features,
    meta: { source: 'geojson', streaming: true },
  };
}

/** Normalize a parsed GeoJSON object into our ParseResult. */
export function normalize(data: any): ParseResult {
  let features: Feature[] = [];
  let name: string | undefined;
  let crs: any;
  let bbox: any;

  if (data?.type === 'FeatureCollection') {
    const fc: FeatureCollection = data;
    name = fc.name;
    crs = fc.crs;
    bbox = fc.bbox;
    features = (fc.features ?? []).map(normalizeFeature);
  } else if (data?.type === 'Feature') {
    features = [normalizeFeature(data)];
  } else if (data?.type) {
    // Bare geometry — wrap it.
    features = [{ type: 'Feature', geometry: data, properties: {} }];
  } else {
    throw new Error('Not a valid GeoJSON document');
  }

  return { name, features, crs, bbox, meta: { source: 'geojson' } };
}

function normalizeFeature(f: any): Feature {
  if (!f || f.type !== 'Feature') {
    throw new Error(`Expected Feature, got: ${f?.type ?? typeof f}`);
  }
  return {
    type: 'Feature',
    geometry: f.geometry ?? null,
    properties: f.properties ?? {},
    id: f.id,
  };
}

/** Serialize a ParseResult (or FeatureCollection / Feature / Geometry) to GeoJSON text. */
export function writeGeoJSON(result: ParseResult | FeatureCollection | Feature, opts: WriteOptions = {}): string {
  let fc: FeatureCollection;
  if ('features' in result && Array.isArray((result as any).features)) {
    const r = result as ParseResult;
    fc = {
      type: 'FeatureCollection',
      name: opts.name ?? r.name,
      features: r.features,
    };
    if (opts.crs ?? r.crs) fc.crs = opts.crs ?? r.crs;
    if (r.bbox) fc.bbox = r.bbox;
  } else if ('geometry' in result) {
    fc = { type: 'FeatureCollection', features: [result as Feature] };
  } else {
    fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: result as any, properties: {} }] };
  }

  const indent = opts.pretty === false ? undefined : 2;
  return JSON.stringify(fc, replacer, indent);
}

function replacer(_key: string, value: any): any {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) return value;
  return value;
}

/** Convenience: read + write (in-memory). */
export function convertGeoJSON(inputPath: string, outputPath?: string, opts: WriteOptions = {}): ParseResult {
  const result = parseGeoJSON(fs.readFileSync(inputPath));
  const text = writeGeoJSON(result, opts);
  if (outputPath) {
    fs.writeFileSync(outputPath, text, 'utf8');
  }
  return result;
}

export { parseGeoJSONStream };
