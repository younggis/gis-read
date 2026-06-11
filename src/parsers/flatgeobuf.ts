/**
 * FlatGeobuf (.fgb) parser and writer.
 *
 * FlatGeobuf is a performant binary encoding for geographic data based on
 * FlatBuffers. It supports streaming, spatial indexing, and zero-copy
 * deserialization.
 *
 * Reference: https://flatgeobuf.org/
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, Geometry, ParseResult, WriteOptions, Properties } from '../types.js';
import { log } from '../logger.js';

// flatgeobuf: import geojson module directly from ESM path to avoid flatbuffers CJS issue
import { serialize as fgbSerialize, deserialize as fgbDeserialize } from 'flatgeobuf/lib/mjs/geojson.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseFlatGeobuf(filePath: string): Promise<ParseResult> {
  const buf = fs.readFileSync(filePath);
  const iter = fgbDeserialize(new Uint8Array(buf)) as AsyncIterable<any>;

  const features: Feature[] = [];
  for await (const f of iter) {
    features.push(normalizeFeature(f));
  }

  const name = filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

  return {
    name,
    features,
    meta: { source: 'flatgeobuf' },
  };
}

function normalizeFeature(f: any): Feature {
  return {
    type: 'Feature',
    geometry: f.geometry ?? null,
    properties: f.properties ?? {},
    id: f.id,
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export async function writeFlatGeobuf(result: ParseResult, opts: WriteOptions = {}): Promise<void> {
  if (!opts.outputPath) throw new Error('writeFlatGeobuf requires outputPath.');

  const features = result.features
    .filter((f) => f.geometry)
    .map((f) => ({
      type: 'Feature' as const,
      geometry: f.geometry as any,
      properties: { ...f.properties },
    }));

  const fc = {
    type: 'FeatureCollection' as const,
    features,
  };

  const bytes = fgbSerialize(fc);
  fs.mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });
  fs.writeFileSync(opts.outputPath, Buffer.from(bytes));

  log.debug(`Wrote FlatGeobuf: ${opts.outputPath} (${features.length} features)`);
}
