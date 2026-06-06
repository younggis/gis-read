/**
 * Parser factory and dispatcher.
 */
import * as fs from 'node:fs';
import type { Format } from '../format-detect.js';
import type { ParseResult } from '../types.js';
import { detectFormat } from '../format-detect.js';
import { parseGeoJSON, parseGeoJSONAuto, parseGeoJSONStream } from './geojson.js';
import { parseKML } from './kml.js';
import { parseShapefile } from './shapefile.js';
import { parseTAB } from './tab.js';
import { parseGPX } from './gpx.js';
import { parseTopoJSON } from './topojson.js';
import { parseCZML } from './czml.js';
import { parseCSV } from './csv.js';
import { parseEsriJSON } from './esrijson.js';
import { parseMIF } from './mif.js';
import { log, Logger } from '../logger.js';
import { formatBytes } from '../io.js';

export function parseFile(filePath: string, format?: Format): ParseResult {
  const fmt = format ?? detectFormat(filePath);
  const stat = fs.statSync(filePath);
  log.debug(`parseFile: ${filePath} (${formatBytes(stat.size)}) as ${fmt}`);

  switch (fmt) {
    case 'geojson':
      return parseGeoJSON(fs.readFileSync(filePath));
    case 'kml':
      return parseKML(fs.readFileSync(filePath));
    case 'shapefile':
      return parseShapefile(filePath);
    case 'tab':
      return parseTAB(filePath);
    case 'gpx':
      return parseGPX(fs.readFileSync(filePath));
    case 'topojson':
      return parseTopoJSON(fs.readFileSync(filePath));
    case 'czml':
      return parseCZML(fs.readFileSync(filePath));
    case 'csv':
      return parseCSV(fs.readFileSync(filePath));
    case 'esrijson':
      return parseEsriJSON(fs.readFileSync(filePath));
    case 'mif':
      return parseMIF(filePath);
    default:
      throw new Error(`Unknown / unsupported format for: ${filePath}`);
  }
}

export { detectFormat } from '../format-detect.js';
export { parseGeoJSON, parseGeoJSONAuto, parseGeoJSONStream, writeGeoJSON, convertGeoJSON } from './geojson.js';
export { parseKML, writeKML, convertKML, formatKMLPlacemarkLines } from './kml.js';
export { parseShapefile } from './shapefile.js';
export { parseTAB } from './tab.js';
export { parseGPX, writeGPX, convertGPX } from './gpx.js';
export { parseTopoJSON, convertTopoJSON } from './topojson.js';
export { parseCZML, convertCZML } from './czml.js';
export { parseCSV, parseWKT, convertCSV } from './csv.js';
export { parseEsriJSON, writeEsriJSON, convertEsriJSON } from './esrijson.js';
export { parseMIF, convertMIF } from './mif.js';
export type { Format } from '../format-detect.js';
export type { Feature, FeatureCollection, Geometry, Properties, ParseOptions, ParseResult, WriteOptions } from '../types.js';
export { Logger, log } from '../logger.js';
export { formatBytes, formatDuration, withErrorBoundary, readFileMaybeStream, streamTextLines, streamJson } from '../io.js';
