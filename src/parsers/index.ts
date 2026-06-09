/**
 * Parser factory and dispatcher.
 */
import * as fs from 'node:fs';
import type { Format } from '../format-detect.js';
import type { ParseOptions, ParseResult, WriteOptions } from '../types.js';
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
import { parseGeoPackage, parseGeoPackageLayers, writeGeoPackage, listGeoPackageLayers } from './geopackage.js';
import { writeCSV } from './csv.js';
import { writeEsriJSON } from './esrijson.js';
import { writeGeoJSON } from './geojson.js';
import { writeGPX } from './gpx.js';
import { writeKML } from './kml.js';
import { writeMIF } from './mif.js';
import { writeShapefile } from './shapefile-writer.js';
import { writeTAB } from './tab-writer.js';
import { writeVectorTiles, type TileOptions, type TileSummary } from './vector-tile.js';
import { log, Logger } from '../logger.js';
import { formatBytes } from '../io.js';

export function parseFile(filePath: string, format?: Format, opts: ParseOptions = {}): ParseResult {
  const fmt = format ?? detectFormat(filePath);
  const stat = fs.statSync(filePath);
  log.debug(`parseFile: ${filePath} (${formatBytes(stat.size)}) as ${fmt}`);

  switch (fmt) {
    case 'geojson':
      return parseGeoJSON(fs.readFileSync(filePath));
    case 'kml':
      return parseKML(fs.readFileSync(filePath));
    case 'shapefile':
      return parseShapefile(filePath, opts);
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
    case 'geopackage':
      return parseGeoPackage(filePath, opts);
    default:
      throw new Error(`Unknown / unsupported format for: ${filePath}`);
  }
}

export function writeFile(result: ParseResult, outputPath: string, format?: Format, opts: WriteOptions = {}): void {
  const fmt = format ?? detectFormat(outputPath);
  const writeOpts = { ...opts, outputPath };
  switch (fmt) {
    case 'geojson':
      fs.writeFileSync(outputPath, writeGeoJSON(result, opts), 'utf8');
      return;
    case 'kml':
      fs.writeFileSync(outputPath, writeKML(result, opts), 'utf8');
      return;
    case 'gpx':
      fs.writeFileSync(outputPath, writeGPX(result, opts), 'utf8');
      return;
    case 'esrijson':
      fs.writeFileSync(outputPath, writeEsriJSON(result, { ...opts, pretty: true }), 'utf8');
      return;
    case 'csv':
      writeCSV(result, writeOpts);
      return;
    case 'mif':
      writeMIF(result, writeOpts);
      return;
    case 'shapefile':
      writeShapefile(result, writeOpts);
      return;
    case 'tab':
      writeTAB(result, writeOpts);
      return;
    case 'geopackage':
      writeGeoPackage(result, writeOpts);
      return;
    default:
      throw new Error(`Writing to format "${fmt}" is not supported. Try: geojson, kml, gpx, esrijson, csv, mif, shapefile, tab, geopackage`);
  }
}

export async function tileFile(inputPath: string, opts: TileOptions): Promise<TileSummary> {
  const result = parseFile(inputPath);
  return writeVectorTiles(result, {
    ...opts,
    layerName: opts.layerName ?? result.name ?? inputPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''),
  });
}

export { writeVectorTiles, computeWebMercatorBBox, tileRangeForBBox } from './vector-tile.js';
export type { TileOptions, TileRange, TileSummary } from './vector-tile.js';

export { detectFormat } from '../format-detect.js';
export { parseGeoJSON, parseGeoJSONAuto, parseGeoJSONStream, writeGeoJSON, convertGeoJSON } from './geojson.js';
export { parseKML, writeKML, convertKML, formatKMLPlacemarkLines } from './kml.js';
export { parseShapefile } from './shapefile.js';
export { writeShapefile } from './shapefile-writer.js';
export { parseTAB } from './tab.js';
export { writeTAB } from './tab-writer.js';
export { parseGPX, writeGPX, convertGPX } from './gpx.js';
export { parseTopoJSON, convertTopoJSON } from './topojson.js';
export { parseCZML, convertCZML } from './czml.js';
export { parseCSV, parseWKT, writeCSV, convertCSV } from './csv.js';
export { parseEsriJSON, writeEsriJSON, convertEsriJSON } from './esrijson.js';
export { parseMIF, writeMIF, convertMIF } from './mif.js';
export { parseGeoPackage, parseGeoPackageLayers, writeGeoPackage, listGeoPackageLayers } from './geopackage.js';
export type { Format } from '../format-detect.js';
export type { Feature, FeatureCollection, Geometry, Properties, ParseOptions, ParseResult, WriteOptions } from '../types.js';
export { Logger, log } from '../logger.js';
export { formatBytes, formatDuration, withErrorBoundary, readFileMaybeStream, streamTextLines, streamJson } from '../io.js';
export {
  importFileToDatabase,
  exportDatabaseTable,
  readDatabaseTable,
  writeDatabaseTable,
  inferDatabaseOutputPathFromTable,
  inferDatabaseTableNameFromPath,
  validateDatabaseIdentifier,
  validateDatabaseTableName,
} from '../database/index.js';
export type {
  DatabaseConnectionOptions,
  DatabaseExportOptions,
  DatabaseImportOptions,
  DatabaseKind,
  DatabaseTransferSummary,
} from '../database/index.js';
