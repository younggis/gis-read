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
 *
 * Global options:
 *   --log-level <level>       debug | info | warn | error | silent (default: info)
 *   --log-file <path>         Append log lines to this file in addition to stderr.
 *
 * All subcommands accept `-f/--format` to force a format (skips detection).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  importFileToDatabase,
  exportDatabaseTable,
  parseGeoJSONStream,
  formatKMLPlacemarkLines,
  type Format,
  type DatabaseKind,
} from './parsers/index.js';
import { formatBytes, formatDuration, withErrorBoundary, readTextFile } from './io.js';
import { getCRS, transformFeatures, transformGeometry, normalizeId } from './crs.js';
import { log, Logger, type LogLevel } from './logger.js';

const VERSION = '1.0.4';

const program = new Command();
program
  .name('gis')
  .description('GIS data parser and converter (Shapefile, MapInfo TAB, GeoJSON, KML, GPX, TopoJSON, CZML, CSV, ESRI JSON, MIF) with multi-CRS support and streaming for large files')
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
  .action((file: string, opts: { format?: Format }) => {
    const fmt = (opts.format as Format) ?? detectFormat(file);
    const stat = fs.statSync(file);
    log.info(`File: ${path.resolve(file)}`);
    console.log(`File:      ${path.resolve(file)}`);
    console.log(`Size:      ${formatBytes(stat.size)}`);
    console.log(`Format:    ${fmt}`);
    const result = parseFile(file, fmt as Format);
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
  .option('--no-pretty', 'single-line JSON output')
  .action((file: string, opts: { format?: Format; limit: number; pretty: boolean }) => {
    const fmt = (opts.format as Format) ?? detectFormat(file);
    const result = parseFile(file, fmt as Format, { limit: opts.limit });
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
  .option('--stream', 'use streaming mode (lower memory, GeoJSON in only)')
  .action(async (
    input: string,
    opts: { output: string; from?: Format; to?: Format; fromCrs?: string; toCrs?: string; precision: number; stream?: boolean },
  ) => {
    const from = (opts.from as Format) ?? detectFormat(input);
    const to = (opts.to as Format) ?? detectFormat(opts.output);
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

    // In-memory path.
    const result = parseFile(input, from as Format);
    reProject(result.features as any);

    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    writeFile(result, opts.output, to as Format, { precision: opts.precision });
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
  .command('db-import')
  .description('Import a supported vector file into a PostgreSQL/PostGIS or SQL Server geometry table.')
  .argument('<input>', 'input GIS file')
  .requiredOption('--db <db>', 'database type: postgresql or sqlserver')
  .option('--connection <connection>', 'database connection string')
  .option('--table <schema.table>', 'target table name; defaults to the input filename without extension')
  .option('--geom-column <name>', 'geometry column name', 'geom')
  .option('--srid <n>', 'target geometry SRID', (v) => Number(v), 4326)
  .option('--from-crs <crs>', 'source CRS before optional reprojection')
  .option('--to-crs <crs>', 'target CRS before import')
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
  .description('Export a PostgreSQL/PostGIS or SQL Server geometry table to a supported vector file.')
  .requiredOption('--db <db>', 'database type: postgresql or sqlserver')
  .option('--connection <connection>', 'database connection string')
  .requiredOption('--table <schema.table>', 'source table name')
  .option('-o, --output <file>', 'output vector file; defaults to <table>.geojson')
  .option('-t, --to <format>', 'force output format')
  .option('--geom-column <name>', 'geometry column name; auto-detected when omitted')
  .option('--where <sql>', 'optional SQL WHERE clause without the WHERE keyword')
  .action(async (opts: {
    db: DatabaseKind;
    connection?: string;
    table: string;
    output?: string;
    to?: Format;
    geomColumn?: string;
    where?: string;
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
  if (db === 'postgresql' || db === 'sqlserver') return db;
  throw new Error(`Unsupported database "${db}". Use postgresql or sqlserver.`);
}

// --- Main: route through error boundary -----------------------------------

(async () => {
  const exitCode = await withErrorBoundary('gis', async () => {
    await program.parseAsync(process.argv);
  });
  process.exit(exitCode);
})();
