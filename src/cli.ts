#!/usr/bin/env node
/**
 * `gis` — command-line entry point.
 *
 * Subcommands:
 *   info <file>               Show format, feature count, CRS, bbox.
 *   parse <file>              Pretty-print features as JSON to stdout.
 *   convert <in> -o <out>     Convert between supported formats.
 *   detect <file>             Print detected format.
 *   crs <file> -t <crs>       Re-project a file to another CRS in-place.
 *   crs-info <crs>            Show details for a CRS id.
 *   stream <in> -o <out>      Memory-bounded streaming conversion (GeoJSON only).
 *   serve <dir>               Start a local static file server with CORS.
 *
 * Global options:
 *   --log-level <level>       debug | info | warn | error | silent (default: info)
 *   --log-file <path>         Append log lines to this file in addition to stderr.
 *
 * All subcommands accept `-f/--format` to force a format (skips detection).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Command, Option } from 'commander';
import {
  parseFile,
  detectFormat,
  writeGeoJSON,
  writeKML,
  writeGPX,
  writeEsriJSON,
  writeFile,
  tileFile,
  writeTerrainTiles,
  writeQuantizedMeshTiles,
  writeTerrainCesiumTiles,
  writeThreeDTiles,
  importFileToDatabase,
  exportDatabaseTable,
  parseGeoJSONStream,
  formatKMLPlacemarkLines,
  parseGeoPackageLayers,
  listGeoPackageLayers,
  initGeoPackage,
  type Format,
  type DatabaseKind,
  type TerrainEncoding,
} from './parsers/index.js';
import { formatBytes, formatDuration, withErrorBoundary, readTextFile } from './io.js';
import { getCRS, transformFeatures, transformGeometry, normalizeId } from './crs.js';
import { log, Logger, type LogLevel } from './logger.js';

const VERSION = '1.1.1';

const program = new Command();
program
  .name('gis')
  .description('GIS data parser and converter (Shapefile, MapInfo TAB, GeoJSON, KML, GPX, TopoJSON, CZML, CSV, ESRI JSON, MIF, GeoPackage) with multi-CRS support and streaming for large files')
  .version(VERSION)
  .addOption(new Option('--log-level <level>', 'logging verbosity').choices(['debug', 'info', 'warn', 'error', 'silent']).default('info'))
  .option('--log-file <path>', 'append log lines to this file')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.logLevel) log.setLevel(opts.logLevel as LogLevel);
    if (opts.logFile) log.addFileSink(opts.logFile);
  });

program
  .command('info')
  .argument('<file>', 'input file')
  .option('-f, --format <format>', 'force format')
  .option('-l, --layer <name>', 'specific layer name (for multi-layer formats)')
  .action(async (file: string, opts: { format?: Format; layer?: string }) => {
    const fmt = (opts.format as Format) ?? detectFormat(file);
    if (fmt === 'geopackage') await initGeoPackage();
    const stat = fs.statSync(file);
    log.info(`File: ${path.resolve(file)}`);
    console.log(`File:      ${path.resolve(file)}`);
    console.log(`Size:      ${formatBytes(stat.size)}`);
    console.log(`Format:    ${fmt}`);

    // For GeoPackage, list all layers first
    if (fmt === 'geopackage' && !opts.layer) {
      const layerNames = listGeoPackageLayers(file);
      console.log(`Layers:    ${layerNames.length} (${layerNames.join(', ')})`);
      // Parse all layers
      const results = parseGeoPackageLayers(file);
      let totalFeatures = 0;
      for (const r of results) {
        console.log(`  ${r.name}: ${r.features.length} features`);
        totalFeatures += r.features.length;
      }
      console.log(`Features:  ${totalFeatures} (total)`);
      if (results.length > 0 && results[0].crs) {
        console.log(`CRS:       ${results[0].crs.properties.name ?? '(unknown)'}`);
      }
      if (results.length > 0 && results[0].bbox) {
        console.log(`BBox:      ${results[0].bbox.join(', ')}`);
      }
      return;
    }

    const result = parseFile(file, fmt as Format, opts.layer ? { layer: opts.layer } : {});
    console.log(`Name:      ${result.name ?? '(none)'}`);
    console.log(`Features:  ${result.features.length}`);
    if (result.crs) console.log(`CRS:       ${result.crs.properties.name ?? '(unknown)'}`);
    if (result.bbox) console.log(`BBox:      ${result.bbox.join(', ')}`);
    if (result.meta) {
      for (const [k, v] of Object.entries(result.meta)) {
        console.log(`${k.padEnd(12)} ${String(v)}`);
      }
    }
  });

program
  .command('detect')
  .argument('<file>', 'input file')
  .action((file: string) => {
    const fmt = detectFormat(file);
    console.log(fmt);
  });

program
  .command('parse')
  .argument('<file>', 'input file')
  .option('-f, --format <format>', 'force format')
  .option('-l, --limit <n>', 'max features to print', (v) => Number(v), 0)
  .option('--layer <name>', 'specific layer name (for multi-layer formats)')
  .option('--no-pretty', 'single-line JSON output')
  .action(async (file: string, opts: { format?: Format; limit: number; pretty: boolean; layer?: string }) => {
    const fmt = (opts.format as Format) ?? detectFormat(file);
    if (fmt === 'geopackage') await initGeoPackage();
    let result;
    if (fmt === 'flatgeobuf') {
      const { parseFlatGeobuf } = await import('./parsers/flatgeobuf.js');
      result = await parseFlatGeobuf(file);
    } else {
      const parseOpts: any = { limit: opts.limit };
      if (opts.layer) parseOpts.layer = opts.layer;
      result = parseFile(file, fmt as Format, parseOpts);
    }
    const features = opts.limit > 0 ? result.features.slice(0, opts.limit) : result.features;
    const trimmed = { ...result, features };
    process.stdout.write(JSON.stringify(trimmed, null, opts.pretty ? 2 : undefined));
    process.stdout.write('\n');
  });

program
  .command('convert')
  .argument('<input>', 'input file')
  .requiredOption('-o, --output <file>', 'output file')
  .option('-f, --from <format>', 'force input format')
  .option('-t, --to <format>', 'force output format (inferred from extension otherwise)')
  .option('--from-crs <crs>', 'source CRS for re-projection')
  .option('--to-crs <crs>', 'target CRS for re-projection')
  .option('--precision <n>', 'coordinate decimal precision', (v) => Number(v), 6)
  .option('--layer <name>', 'specific layer name (for multi-layer formats like GeoPackage)')
  .option('--stream', 'use streaming mode (lower memory, GeoJSON in only)')
  .action(async (
    input: string,
    opts: { output: string; from?: Format; to?: Format; fromCrs?: string; toCrs?: string; precision: number; stream?: boolean; layer?: string },
  ) => {
    const from = (opts.from as Format) ?? detectFormat(input);
    const to = (opts.to as Format) ?? detectFormat(opts.output);
    if (from === 'geopackage' || to === 'geopackage') await initGeoPackage();
    if (!to || to === 'unknown') {
      throw new Error(`Cannot determine output format for: ${opts.output}. Use -t/--to to specify one.`);
    }

    // Re-projection: only for in-memory mode (CRS transform is recursive).
    const reProject = (features: any[]) => {
      if (opts.fromCrs && opts.toCrs && opts.fromCrs !== opts.toCrs) {
        getCRS(opts.fromCrs); getCRS(opts.toCrs);
        transformFeatures(features, opts.fromCrs, opts.toCrs);
      }
    };

    const done = log.startTimer('convert');

    if (opts.stream) {
      if (from !== 'geojson') {
        throw new Error('Streaming mode currently only supports GeoJSON input.');
      }
      if (to !== 'geojson' && to !== 'kml' && to !== 'gpx') {
        throw new Error(`Streaming output for "${to}" is not supported. Use non-streaming convert.`);
      }
      log.info(`Streaming convert: ${input} -> ${opts.output}`);
      const out = fs.createWriteStream(opts.output, 'utf8');
      const reProjectFn = (f: any) => {
        if (opts.fromCrs && opts.toCrs && opts.fromCrs !== opts.toCrs) {
          f.geometry = transformGeometry(f.geometry, opts.fromCrs, opts.toCrs);
        }
        return f;
      };
      let n = 0;
      if (to === 'geojson') {
        out.write('{"type":"FeatureCollection","features":[\n');
        let first = true;
        for await (const f of parseGeoJSONStream(input)) {
          reProjectFn(f);
          if (!first) out.write(',\n');
          first = false;
          out.write(JSON.stringify(f, null, 0));
          n++;
        }
        out.write(']}\n');
      } else if (to === 'kml') {
        out.write('<?xml version="1.0" encoding="UTF-8"?>\n');
        out.write('<kml xmlns="http://www.opengis.net/kml/2.2">\n');
        for await (const f of parseGeoJSONStream(input)) {
          reProjectFn(f);
          out.write(kmlPlacemark(f, opts.precision));
          n++;
        }
        out.write('</kml>\n');
      } else if (to === 'gpx') {
        out.write('<?xml version="1.0" encoding="UTF-8"?>\n');
        out.write('<gpx version="1.1" creator="gis-read" xmlns="http://www.topografix.com/GPX/1/1">\n');
        for await (const f of parseGeoJSONStream(input)) {
          reProjectFn(f);
          out.write(gpxForFeature(f, opts.precision));
          n++;
        }
        out.write('</gpx>\n');
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err: Error | null | undefined) => err ? reject(err) : resolve());
      });
      done(`Streaming convert complete`, { features: n, output: opts.output });
      return;
    }

    // Multi-layer GeoPackage handling: when input is GeoPackage and no --layer specified,
    // export each layer to a separate file.
    if (from === 'geopackage' && !opts.layer) {
      const layers = parseGeoPackageLayers(input);
      if (layers.length <= 1) {
        // Single layer: normal path
        const result = layers[0] ?? parseFile(input, from);
        reProject(result.features as any);
        fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        await writeFile(result, opts.output, to as Format, { precision: opts.precision });
        done(`Converted ${from} -> ${to}`, {
          features: result.features.length,
          input,
          output: path.resolve(opts.output),
        });
      } else {
        // Multiple layers: export each to a separate file
        const ext = path.extname(opts.output);
        const base = opts.output.slice(0, -ext.length);
        let totalFeatures = 0;
        for (const layerResult of layers) {
          const layerName = layerResult.name ?? 'layer';
          const layerOutput = `${base}_${layerName}${ext}`;
          reProject(layerResult.features as any);
          fs.mkdirSync(path.dirname(path.resolve(layerOutput)), { recursive: true });
          await writeFile(layerResult, layerOutput, to as Format, { precision: opts.precision });
          log.info(`  ${layerName}: ${layerResult.features.length} features -> ${path.resolve(layerOutput)}`);
          totalFeatures += layerResult.features.length;
        }
        done(`Converted ${from} -> ${to} (${layers.length} layers)`, {
          features: totalFeatures,
          input,
          output: path.resolve(opts.output),
          layers: layers.length,
        });
      }
      return;
    }

    // In-memory path (single layer).
    // FlatGeobuf uses async deserialization
    let result;
    if (from === 'flatgeobuf') {
      const { parseFlatGeobuf } = await import('./parsers/flatgeobuf.js');
      result = await parseFlatGeobuf(input);
    } else {
      const parseOpts: any = {};
      if (opts.layer) parseOpts.layer = opts.layer;
      result = parseFile(input, from as Format, parseOpts);
    }
    reProject(result.features as any);

    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    await writeFile(result, opts.output, to as Format, { precision: opts.precision });
    done(`Converted ${from} -> ${to}`, {
      features: result.features.length,
      input: input,
      output: path.resolve(opts.output),
    });
  });

program
  .command('stream')
  .description('Memory-bounded streaming conversion (GeoJSON in, GeoJSON/KML/GPX out).')
  .argument('<input>', 'input GeoJSON file (can be > available RAM)')
  .requiredOption('-o, --output <file>', 'output file')
  .option('--from-crs <crs>', 'source CRS')
  .option('--to-crs <crs>', 'target CRS')
  .option('--precision <n>', 'coordinate precision', (v) => Number(v), 6)
  .action(async (input: string, opts: { output: string; fromCrs?: string; toCrs?: string; precision: number }) => {
    const out = fs.createWriteStream(opts.output, 'utf8');
    const outFmt = detectFormat(opts.output);
    const done = log.startTimer('stream');

    let n = 0;
    if (outFmt === 'geojson') {
      out.write('{"type":"FeatureCollection","features":[\n');
      let first = true;
      for await (const f of parseGeoJSONStream(input)) {
        if (opts.fromCrs && opts.toCrs && opts.fromCrs !== opts.toCrs) {
          f.geometry = transformGeometry(f.geometry, opts.fromCrs, opts.toCrs);
        }
        if (!first) out.write(',\n');
        first = false;
        out.write(JSON.stringify(f));
        n++;
      }
      out.write(']}\n');
    } else if (outFmt === 'kml') {
      out.write('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n');
      for await (const f of parseGeoJSONStream(input)) {
        if (opts.fromCrs && opts.toCrs && opts.fromCrs !== opts.toCrs) {
          f.geometry = transformGeometry(f.geometry, opts.fromCrs, opts.toCrs);
        }
        out.write(kmlPlacemark(f, opts.precision));
        n++;
      }
      out.write('</kml>\n');
    } else if (outFmt === 'gpx') {
      out.write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="gis-read" xmlns="http://www.topografix.com/GPX/1/1">\n');
      for await (const f of parseGeoJSONStream(input)) {
        if (opts.fromCrs && opts.toCrs && opts.fromCrs !== opts.toCrs) {
          f.geometry = transformGeometry(f.geometry, opts.fromCrs, opts.toCrs);
        }
        out.write(gpxForFeature(f, opts.precision));
        n++;
      }
      out.write('</gpx>\n');
    } else {
      throw new Error(`Streaming output to ${outFmt} is not supported.`);
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: Error | null | undefined) => err ? reject(err) : resolve());
    });
    done('Stream complete', { features: n, output: opts.output });
  });

program
  .command('tile')
  .description('Generate XYZ Mapbox Vector Tile (MVT/PBF) tiles from any supported vector input.')
  .argument('<input>', 'input GIS file')
  .requiredOption('-o, --output <dir>', 'output XYZ tile directory')
  .option('--min-zoom <n>', 'minimum zoom level', (v) => Number(v), 0)
  .option('--max-zoom <n>', 'maximum zoom level', (v) => Number(v), 14)
  .option('--threads <n>', 'worker count hint', (v) => Number(v), Math.max(1, os.cpus().length - 1))
  .option('--from-crs <crs>', 'source CRS before converting to WebMercator', 'WGS84')
  .option('--layer <name>', 'MVT layer name')
  .action(async (
    input: string,
    opts: { output: string; minZoom: number; maxZoom: number; threads: number; fromCrs: string; layer?: string },
  ) => {
    const done = log.startTimer('tile');
    const summary = await tileFile(input, {
      outputPath: opts.output,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      threads: opts.threads,
      fromCrs: opts.fromCrs,
      layerName: opts.layer,
    });
    done('Tile generation complete', {
      features: summary.featureCount,
      tiles: summary.generatedTiles,
      minZoom: summary.minZoom,
      maxZoom: summary.maxZoom,
      output: path.resolve(summary.outputPath),
    });
  });

program
  .command('terrain')
  .description('Generate Mapbox terrain-RGB PNG tiles from a DEM (GeoTIFF) file.')
  .argument('<input>', 'input DEM file (.tif)')
  .requiredOption('-o, --output <dir>', 'output XYZ tile directory')
  .option('--min-zoom <n>', 'minimum zoom level', (v) => Number(v), 0)
  .option('--max-zoom <n>', 'maximum zoom level', (v) => Number(v), 12)
  .option('--encoding <fmt>', 'encoding format: terrain-rgb | terrarium', 'terrain-rgb')
  .option('--tile-size <n>', 'tile size in pixels', (v) => Number(v), 256)
  .option('--from-crs <crs>', 'source CRS (auto-detected from GeoTIFF)')
  .action(async (
    input: string,
    opts: { output: string; minZoom: number; maxZoom: number; encoding: TerrainEncoding; tileSize: number; fromCrs?: string },
  ) => {
    const done = log.startTimer('terrain');
    const summary = await writeTerrainTiles(input, {
      outputPath: opts.output,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      encoding: opts.encoding,
      tileSize: opts.tileSize,
      fromCrs: opts.fromCrs,
    });
    done('Terrain tile generation complete', {
      tiles: summary.totalTiles,
      emptySkipped: summary.emptyTilesSkipped,
      minZoom: summary.minZoom,
      maxZoom: summary.maxZoom,
      output: path.resolve(summary.outputPath),
    });
  });

program
  .command('terrain-cesium')
  .description('Generate Cesium quantized-mesh-1.0 .terrain tiles from a DEM (GeoTIFF) file. Mirrors src/dem_to_terrain.py.')
  .argument('<input>', 'input DEM file (.tif)')
  .requiredOption('-o, --output <dir>', 'output XYZ tile directory (z/x/y.terrain + layer.json)')
  .option('--max-level <n>', 'maximum tiling zoom level', (v) => Number(v), 8)
  .option('--grid-size <n>', 'vertices per tile edge (16/32/64 typical)', (v) => Number(v), 32)
  .option('--no-compress', 'skip gzip compression (debug only)')
  .option('--from-crs <crs>', 'source CRS (auto-detected from GeoTIFF)')
  .action(async (
    input: string,
    opts: { output: string; maxLevel: number; gridSize: number; noCompress?: boolean; fromCrs?: string },
  ) => {
    const done = log.startTimer('terrain-cesium');
    const summary = await writeTerrainCesiumTiles(input, {
      outputPath: opts.output,
      maxLevel: opts.maxLevel,
      gridSize: opts.gridSize,
      noCompress: opts.noCompress,
      fromCrs: opts.fromCrs,
    });
    done('Cesium quantized-mesh tiles generated', {
      realTiles: summary.totalTiles,
      blankTiles: summary.blankTiles,
      maxLevel: summary.maxLevel,
      demBounds: summary.demBounds,
      output: summary.outputPath,
    });
  });

program
  .command('3dtiles')
  .description('Generate Cesium 3D Tiles (b3dm white models) from a building Shapefile. Mirrors src/shp_to_3dtiles_dem.py.')
  .argument('<input>', 'input Shapefile (.shp, companion .dbf loaded automatically)')
  .requiredOption('-o, --output <dir>', 'output directory (tileset.json + Tiles/{z}/{x}/{y}.b3dm)')
  .option('--lod <n>', 'Web Mercator tiling zoom level (0-22)', (v) => Number(v), 12)
  .option('--limit <n>', 'only process the first N polygon records (debug)', (v) => Number(v))
  .option('--color <hex>', 'building tint, #RGB / #RRGGBB / #RRGGBBAA', '#cccccc')
  .option('--height-field <name>', 'DBF field with per-feature building height')
  .option('--base-height-field <name>', 'DBF field with per-feature base height')
  .option('--default-height <m>', 'fallback building height when --height-field is missing', (v) => Number(v), 10)
  .option('--base-height <m>', 'fallback base height (ground offset when --dem is set)', (v) => Number(v), 0)
  .option('--dem <file>', 'optional DEM file (.tif/.tiff/.asc) for ground elevation sampling')
  .option('--dem-crs <crs>', 'DEM CRS override (defaults to EPSG:4326)', 'EPSG:4326')
  .option('--dem-offset <m>', 'vertical offset added to sampled DEM height', (v) => Number(v), 0)
  .option('--dem-default-height <m>', 'fallback ground elevation when DEM is missing / out of range', (v) => Number(v), 0)
  .option('--dem-sample <mode>', 'vertices | centroid | minimum | average', 'vertices')
  .option('--height-is-relative', 'treat the height field as a relative building height (top = base + height)')
  .option('--height-absolute', 'treat the height field as an absolute top elevation (overrides the default when --dem is set)')
  .option('--min-height <m>', 'clamp the relative building height to a minimum')
  .option('--max-height <m>', 'clamp the relative building height to a maximum')
  .option('--input-crs <crs>', 'source CRS for the SHP (defaults to EPSG:4326)', 'EPSG:4326')
  .option('--outer-orientation <mode>', 'auto | cw | ccw | all (exterior-ring orientation hint)', 'auto')
  .option('--root-geometric-error <n>', 'tileset root geometricError', (v) => Number(v), 500)
  .option('--overwrite', 'clear the output directory before writing')
  .option('--no-pretty-json', 'emit minified tileset.json')
  .action(async (
    input: string,
    opts: {
      output: string;
      lod: number;
      limit?: number;
      color: string;
      heightField?: string;
      baseHeightField?: string;
      defaultHeight: number;
      baseHeight: number;
      dem?: string;
      demCrs: string;
      demOffset: number;
      demDefaultHeight: number;
      demSample: 'vertices' | 'centroid' | 'minimum' | 'average';
      heightIsRelative?: boolean;
      heightAbsolute?: boolean;
      minHeight?: number;
      maxHeight?: number;
      inputCrs: string;
      outerOrientation: 'auto' | 'cw' | 'ccw' | 'all';
      rootGeometricError: number;
      overwrite?: boolean;
      prettyJson: boolean;
    },
  ) => {
    const done = log.startTimer('3dtiles');
    const summary = await writeThreeDTiles(input, {
      outputPath: opts.output,
      lod: opts.lod,
      limit: opts.limit,
      color: opts.color,
      heightField: opts.heightField,
      baseHeightField: opts.baseHeightField,
      defaultHeight: opts.defaultHeight,
      baseHeight: opts.baseHeight,
      dem: opts.dem,
      demCrs: opts.demCrs,
      demOffset: opts.demOffset,
      demDefaultHeight: opts.demDefaultHeight,
      demSample: opts.demSample,
      heightIsRelative: opts.heightIsRelative,
      heightAbsolute: opts.heightAbsolute,
      minHeight: opts.minHeight,
      maxHeight: opts.maxHeight,
      inputCrs: opts.inputCrs,
      outerOrientation: opts.outerOrientation,
      rootGeometricError: opts.rootGeometricError,
      overwrite: opts.overwrite,
      prettyJson: opts.prettyJson,
    });
    done('3D Tiles generated', {
      features: summary.features,
      shapesRead: summary.shapesRead,
      skipped: summary.skipped,
      tiles: summary.tiles,
      lod: summary.lod,
      output: summary.outputPath,
    });
  });

program
  .command('db-import')
  .description('Import a supported vector file into a PostgreSQL/PostGIS, SQL Server, or MongoDB collection.')
  .argument('<input>', 'input GIS file')
  .requiredOption('--db <db>', 'database type: postgresql, sqlserver, or mongodb')
  .option('--connection <connection>', 'database connection string')
  .option('--table <schema.table>', 'target table or collection name; defaults to the input filename without extension')
  .option('--geom-column <name>', 'geometry column name (postgresql/sqlserver only)', 'geom')
  .option('--srid <n>', 'target geometry SRID', (v) => Number(v), 4326)
  .option('--from-crs <crs>', 'source CRS before optional reprojection')
  .option('--to-crs <crs>', 'target CRS before import')
  .option('--db-name <name>', 'MongoDB database name; overrides the db inferred from the connection URI')
  .option('--drop', 'MongoDB only: drop the target collection before insert')
  .action(async (
    input: string,
    opts: {
      db: DatabaseKind;
      connection?: string;
      table?: string;
      geomColumn: string;
      srid: number;
      fromCrs?: string;
      toCrs?: string;
      dbName?: string;
      drop?: boolean;
    },
  ) => {
    const done = log.startTimer('db-import');
    const summary = await importFileToDatabase(input, {
      db: normalizeDbKind(opts.db),
      connection: opts.connection,
      table: opts.table,
      geomColumn: opts.geomColumn,
      srid: opts.srid,
      fromCrs: opts.fromCrs,
      toCrs: opts.toCrs,
      dbName: opts.dbName,
      drop: opts.drop,
    });
    done('Database import complete', {
      db: summary.db,
      table: summary.table,
      features: summary.featureCount,
      geomColumn: summary.geomColumn,
      srid: summary.srid,
    });
  });

program
  .command('db-export')
  .description('Export a PostgreSQL/PostGIS, SQL Server, or MongoDB collection to a supported vector file.')
  .requiredOption('--db <db>', 'database type: postgresql, sqlserver, or mongodb')
  .option('--connection <connection>', 'database connection string')
  .requiredOption('--table <schema.table|db.collection>', 'source table or collection name')
  .option('-o, --output <file>', 'output vector file; defaults to <table>.geojson')
  .option('-t, --to <format>', 'force output format')
  .option('--geom-column <name>', 'geometry column name; auto-detected when omitted')
  .option('--where <sql>', 'optional SQL WHERE clause without the WHERE keyword (postgresql/sqlserver only)')
  .option('--db-name <name>', 'MongoDB database name; overrides the db inferred from the connection URI')
  .action(async (opts: {
    db: DatabaseKind;
    connection?: string;
    table: string;
    output?: string;
    to?: Format;
    geomColumn?: string;
    where?: string;
    dbName?: string;
  }) => {
    const done = log.startTimer('db-export');
    const summary = await exportDatabaseTable({
      db: normalizeDbKind(opts.db),
      connection: opts.connection,
      table: opts.table,
      outputPath: opts.output,
      outputFormat: opts.to,
      geomColumn: opts.geomColumn,
      where: opts.where,
      dbName: opts.dbName,
    });
    done('Database export complete', {
      db: summary.db,
      table: summary.table,
      features: summary.featureCount,
      output: path.resolve(summary.outputPath ?? opts.output ?? ''),
    });
  });

program
  .command('crs')
  .description('Re-project features to a different CRS in place (GeoJSON only).')
  .argument('<file>', 'input GeoJSON file')
  .requiredOption('--to <crs>', 'target CRS id')
  .option('--from <crs>', 'source CRS id (defaults to GeoJSON crs or WGS84)')
  .option('-o, --output <file>', 'output file (defaults to overwriting input)')
  .action((file: string, opts: { to: string; from?: string; output?: string }) => {
    const result = parseFile(file, 'geojson');
    const sourceCrs = opts.from ?? (result.crs?.properties?.name ? normalizeId(String(result.crs.properties.name)) : 'WGS84');
    if (sourceCrs === opts.to) {
      log.info(`Source and target CRS are both "${sourceCrs}" — no transformation needed.`);
    } else {
      transformFeatures(result.features as any, sourceCrs, opts.to);
      result.crs = { type: 'name', properties: { name: opts.to } };
      log.info(`Re-projected ${sourceCrs} -> ${opts.to}`, { features: result.features.length });
    }
    const text = writeGeoJSON(result);
    const outPath = opts.output ?? file;
    fs.writeFileSync(outPath, text, 'utf8');
    log.info(`Wrote ${outPath}`);
  });

program
  .command('crs-info')
  .argument('<crs>', 'CRS id (WGS84, WebMercator, CGCS2000, GCJ02, BD09, EPSG:xxxx, …)')
  .action((id: string) => {
    const info = getCRS(id);
    console.log(`ID:         ${info.id}`);
    console.log(`Name:       ${info.name}`);
    console.log(`Encrypted:  ${info.encrypted}`);
    if (info.proj4) console.log(`proj4 def:  ${info.proj4}`);
  });

program
  .command('serve')
  .description('Start a local static file server with CORS support. Useful for serving terrain, PBF tiles, etc.')
  .argument('<dir>', 'directory to serve')
  .option('-p, --port <n>', 'port number', (v) => Number(v), 8080)
  .action(async (dir: string, opts: { port: number }) => {
    const serveDir = path.resolve(dir);
    if (!fs.existsSync(serveDir) || !fs.statSync(serveDir).isDirectory()) {
      throw new Error(`Directory not found: ${serveDir}`);
    }
    const port = opts.port;

    // Check if port is available
    const available = await isPortAvailable(port);
    if (!available) {
      throw new Error(`Port ${port} is already in use. Choose a different port with --port.`);
    }

    const mimeTypes: Record<string, string> = {
      '.json': 'application/json',
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.pbf': 'application/x-protobuf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.xml': 'application/xml',
      '.kml': 'application/vnd.google-earth.kml+xml',
      '.gpx': 'application/gpx+xml',
      '.terrain': 'application/vnd.quantized-mesh',
      '.b3dm': 'application/octet-stream',
      '.i3dm': 'application/octet-stream',
      '.pnts': 'application/octet-stream',
      '.cmpt': 'application/octet-stream',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };

    // Extensions that should be gzipped on the fly. Cesium's CesiumTerrainProvider
    // and 3D Tiles tile loaders expect Content-Encoding: gzip for these formats.
    const gzipExtensions = new Set(['.terrain', '.b3dm', '.i3dm', '.pnts', '.cmpt']);

    const server = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const filePath = path.join(serveDir, urlPath);

      // Prevent directory traversal
      if (!filePath.startsWith(serveDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          // Try index.html for directories
          if (!err && stat.isDirectory()) {
            const indexPath = path.join(filePath, 'index.html');
            if (fs.existsSync(indexPath)) {
              const ext = path.extname(indexPath).toLowerCase();
              const contentType = mimeTypes[ext] ?? 'application/octet-stream';
              res.writeHead(200, { 'Content-Type': contentType });
              fs.createReadStream(indexPath).pipe(res);
              return;
            }
          }
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] ?? 'application/octet-stream';
        const shouldGzip = gzipExtensions.has(ext);
        if (ext === '.terrain') {
          // .terrain files are already gzipped on disk per Cesium quantized-mesh spec.
          // Stream as-is and declare Content-Encoding: gzip.
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Encoding': 'gzip',
            'Vary': 'Accept-Encoding',
            'Content-Length': stat.size,
          });
          fs.createReadStream(filePath).pipe(res);
        } else if (shouldGzip) {
          // 3D Tiles formats (.b3dm, .i3dm, .pnts, .cmpt) are typically NOT pre-gzipped.
          // Serve them as uncompressed binary files with correct Content-Type.
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
          });
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
          });
          fs.createReadStream(filePath).pipe(res);
        }
      });
    });

    server.listen(port, () => {
      log.info(`Serving ${serveDir} at http://localhost:${port}`);
      log.info('CORS enabled (Access-Control-Allow-Origin: *)');
      log.info('Press Ctrl+C to stop.');
    });

    // Keep the process alive
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        server.close();
        log.info('Server stopped.');
        resolve();
      });
      process.on('SIGTERM', () => {
        server.close();
        resolve();
      });
    });
  });

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port);
  });
}

// --- Helpers for streaming writers ---------------------------------------

/**
 * Format a single Feature as a `<Placemark>...</Placemark>` block for the
 * streaming KML writer. Thin wrapper around the shared `formatKMLPlacemarkLines`
 * in `src/parsers/kml.ts` — kept in sync with the in-memory `writeKML`.
 */
function kmlPlacemark(f: any, precision: number): string {
  return formatKMLPlacemarkLines(f, '  ', precision).join('\n') + '\n';
}

function gpxForFeature(f: any, precision: number): string {
  const fmt = (n: number) => n.toFixed(precision);
  if (!f.geometry) return '';
  if (f.geometry.type === 'Point') {
    const c = f.geometry.coordinates as number[];
    return `  <wpt lat="${fmt(c[1])}" lon="${fmt(c[0])}"/>\n`;
  }
  if (f.geometry.type === 'LineString') {
    const coords = (f.geometry.coordinates as number[][]).map((c) => `    <trkpt lat="${fmt(c[1])}" lon="${fmt(c[0])}"/>`).join('\n');
    return `  <trk>\n    <trkseg>\n${coords}\n    </trkseg>\n  </trk>\n`;
  }
  return '';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeDbKind(db: string): DatabaseKind {
  if (db === 'postgresql' || db === 'sqlserver' || db === 'mongodb') return db;
  throw new Error(`Unsupported database "${db}". Use postgresql, sqlserver, or mongodb.`);
}

// --- Main: route through error boundary -----------------------------------

(async () => {
  const exitCode = await withErrorBoundary('gis', async () => {
    await program.parseAsync(process.argv);
  });
  process.exit(exitCode);
})();
