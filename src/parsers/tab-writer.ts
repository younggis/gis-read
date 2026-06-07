import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ParseResult, WriteOptions } from '../types.js';
import { writeGeoJSON } from './geojson.js';

export interface TabWriteOptions extends WriteOptions {
  ogr2ogrPath?: string;
}

export function writeTAB(result: ParseResult, opts: TabWriteOptions = {}): void {
  if (!opts.outputPath) throw new Error('writeTAB requires outputPath.');
  const ogr2ogr = opts.ogr2ogrPath ?? 'ogr2ogr';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gis-read-tab-'));
  const tmpGeoJSON = path.join(tmpDir, 'input.geojson');
  fs.writeFileSync(tmpGeoJSON, writeGeoJSON(result, { precision: opts.precision }), 'utf8');
  fs.mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });

  try {
    execFileSync(ogr2ogr, ['-f', 'MapInfo File', opts.outputPath, tmpGeoJSON], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `Writing MapInfo TAB requires GDAL/OGR "ogr2ogr" on PATH. ` +
      `Install GDAL or write MapInfo MIF instead. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
