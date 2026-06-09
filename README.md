# gis-read

[中文](./read.md) | English

`gis-read` is a TypeScript GIS parser and converter available as both a CLI and a Node.js library. It normalizes supported GIS inputs into GeoJSON-style features, then writes common interchange formats such as GeoJSON, KML, GPX, ESRI JSON, CSV/WKT, Shapefile, and MapInfo MIF.

## Features

- Parse Shapefile, MapInfo TAB, GeoJSON, KML, GPX, TopoJSON, CZML, CSV/WKT, ESRI JSON, MapInfo MIF, and GeoPackage.
- Convert supported inputs to GeoJSON, KML, GPX, ESRI JSON, CSV/WKT, Shapefile, MapInfo MIF, or GeoPackage. MapInfo TAB writing is available when GDAL `ogr2ogr` is installed.
- Stream large GeoJSON files to GeoJSON/KML/GPX without loading the whole file into memory.
- Generate standard XYZ Mapbox Vector Tile (`.pbf`) directories from supported vector inputs.
- Import vector files into PostgreSQL/PostGIS or SQL Server geometry tables, and export geometry tables back to vector files.
- Read Shapefile DBF attributes record-by-record, including DBF files larger than 2 GiB, and decode Chinese field names from `.cpg` or corrected content detection when `.cpg` is mislabeled.
- Preserve common metadata such as CRS, bbox, attributes, and parser-specific details.
- Transform coordinates between WGS84, WebMercator, CGCS2000, GCJ-02, BD-09, and supported `EPSG:xxxx` definitions.
- Detect common Chinese GIS text encodings from `.cpg`, TAB headers, valid UTF-8 DBF bytes, dBASE language drivers, and content heuristics; `Neutral` TAB charsets are treated as unspecified and probed from text fields.
- Decode MapInfo TAB `WindowsSimpChinese` field names and attribute values, plus common legacy lines, v500 `0x25` point-table lines, and v300 compressed/uncompressed region coordinate blocks into GeoJSON geometries.

## Requirements

- Node.js `>=18`
- npm `>=8` recommended

## Installation

From npm after publication:

```bash
npm install -g gis-read
gis --help
```

From a local package tarball:

```bash
npm install -g ./gis-read-1.0.7.tgz
gis --help
```

For project-local use:

```bash
npm install gis-read
npx gis --help
```

## CLI Quick Start

```bash
# Inspect metadata
gis info input.shp
gis detect input.kml

# Print parsed JSON to stdout
gis parse input.geojson --limit 5
gis parse input.geojson --no-pretty

# Convert formats
gis convert input.shp -o output.geojson
gis convert input.tab -o output.geojson
gis convert input.geojson -o output.kml
gis convert input.geojson -o output.esrijson -t esrijson
gis convert input.geojson -o output.csv
gis convert points.geojson -o points.shp -t shapefile
gis convert input.geojson -o output.mif
gis convert input.geojson -o output.tab -t tab # requires GDAL ogr2ogr

# GeoPackage (multi-layer support)
gis info input.gpkg                          # list all layers
gis convert input.gpkg -o output.geojson     # export all layers (one file per layer)
gis convert input.gpkg -o output.geojson --layer roads  # export specific layer
gis convert input.geojson -o output.gpkg     # write GeoPackage

# Generate MVT/PBF vector tiles
gis tile input.shp -o tiles --min-zoom 8 --max-zoom 14
gis tile input.geojson -o tiles --from-crs WGS84 --threads 4 --layer buildings

# Import/export database geometry tables
gis db-import roads.shp --db postgresql --connection "$POSTGIS_URL" --srid 4326
gis db-import input.shp --db postgresql --connection "$POSTGIS_URL" --table public.roads --srid 4326
gis db-export --db sqlserver --connection "$MSSQL_URL" --table dbo.roads
gis db-export --db sqlserver --connection "$MSSQL_URL" --table dbo.roads -o roads.shp -t shapefile

# Stream large GeoJSON files
gis stream big.geojson -o big.kml
gis convert big.geojson -o big.geojson --stream

# Re-project GeoJSON
gis crs input.geojson --from WGS84 --to WebMercator -o output.geojson
gis crs-info BD09
```

When running from a source checkout instead of a global install:

```bash
npm install
npm run build
node dist/cli.js --help
```

## Supported Formats

| Format | Extensions | Read | Write | Notes |
| --- | --- | --- | --- | --- |
| Shapefile | `.shp` + sidecars | Yes | Yes | Reads DBF attributes without one huge Buffer, supports Chinese field names from `.cpg` or corrected GBK/GB18030 detection, and writes `.shp/.shx/.dbf/.cpg`; one geometry family per bundle. |
| MapInfo TAB | `.tab` + `.dat`/`.map`/`.id` | Yes | Yes* | Write requires GDAL `ogr2ogr`; reads TAB charsets, Chinese attributes, common legacy line records, v500 `0x25` point-table lines, and v300 compressed/uncompressed regions; unsupported private `.map` records may return `null`. |
| GeoJSON | `.geojson`, `.json` | Yes | Yes | Streaming input and output supported. |
| KML | `.kml` | Yes | Yes | Supports Placemark, ExtendedData, Point, LineString, Polygon, MultiGeometry. |
| GPX | `.gpx` | Yes | Yes | Waypoints and tracks/routes; polygon output is skipped. |
| TopoJSON | `.topojson` | Yes | GeoJSON only | Expands shared arcs into coordinates. |
| CZML | `.czml` | Yes | GeoJSON only | Converts entity packets to features. |
| CSV/WKT | `.csv` | Yes | Yes | Writes attributes plus a `wkt` geometry column. |
| ESRI JSON | `.json` | Yes | Yes | Reads/writes ArcGIS-style geometry structures. |
| MapInfo MIF | `.mif` + `.mid` | Yes | Yes | Writes text `.mif` plus attribute `.mid`. |
| GeoPackage | `.gpkg` | Yes | Yes | Multi-layer support; `--layer` selects a specific layer; without `--layer`, each layer exports to a separate file. Also reads SpatiaLite `.sqlite` files. |
| MVT/PBF tiles | `/{z}/{x}/{y}.pbf` | No | Yes | Generated with `gis tile`; all input geometries are converted to WebMercator. |
| PostgreSQL/PostGIS | geometry tables | Yes | Yes | Uses WKB via `ST_AsBinary` and `ST_GeomFromWKB`; connection from `--connection` or `GIS_READ_PG_CONNECTION`. |
| SQL Server | geometry tables | Yes | Yes | Uses WKB via `STAsBinary()` and `geometry::STGeomFromWKB`; connection from `--connection` or `GIS_READ_MSSQL_CONNECTION`. |

## Library Usage

```ts
import {
  parseFile,
  parseShapefile,
  parseGeoJSON,
  writeGeoJSON,
  writeKML,
  writeCSV,
  writeMIF,
  writeShapefile,
  writeFile,
  tileFile,
  writeVectorTiles,
  importFileToDatabase,
  exportDatabaseTable,
  transformFeatures,
  parseGeoPackage,
  parseGeoPackageLayers,
  writeGeoPackage,
  listGeoPackageLayers,
} from 'gis-read';

const parsed = parseFile('input.shp');
console.log(parsed.features.length);

const geojson = writeGeoJSON(parsed, { precision: 6 });
const kml = writeKML(parsed, { precision: 6 });
const csv = writeCSV(parsed, { precision: 6 });
writeMIF(parsed, { outputPath: 'output.mif', precision: 6 });
writeShapefile(parseFile('points.geojson'), { outputPath: 'points.shp' });
writeFile(parsed, 'output.csv', 'csv', { precision: 6 });

const manual = parseShapefile('input.shp');
transformFeatures(manual.features, 'WGS84', 'WebMercator');

await tileFile('input.shp', {
  outputPath: 'tiles',
  minZoom: 8,
  maxZoom: 14,
  fromCrs: 'WGS84',
  threads: 4,
  layerName: 'buildings',
});

await importFileToDatabase('input.shp', {
  db: 'postgresql',
  connection: process.env.GIS_READ_PG_CONNECTION,
  table: 'public.roads', // optional; defaults to the input filename without extension
  srid: 4326,
});

await exportDatabaseTable({
  db: 'sqlserver',
  connection: process.env.GIS_READ_MSSQL_CONNECTION,
  table: 'dbo.roads',
  outputPath: 'roads.geojson', // optional; defaults to <table>.geojson
});

// GeoPackage: list layers and read specific layer
const layers = listGeoPackageLayers('input.gpkg');
console.log('Layers:', layers);

const gpkg = parseGeoPackage('input.gpkg', { layer: 'roads' });
console.log(gpkg.features.length);

// GeoPackage: write
writeGeoPackage(parsed, { outputPath: 'output.gpkg' });
```

Streaming GeoJSON:

```ts
import { parseGeoJSONStream } from 'gis-read';

for await (const feature of parseGeoJSONStream('big.geojson')) {
  console.log(feature.properties);
}
```

For large Shapefiles, `parseShapefile('input.shp', { limit: 10 })` reads only the first matching SHP/DBF records, which is useful for checking schema and encoding before a full conversion.

The main return shape is:

```ts
interface ParseResult {
  name?: string;
  features: Feature[];
  crs?: CRS;
  bbox?: [number, number, number, number];
  meta?: Record<string, unknown>;
}
```

## Development

```bash
npm install
npm test
npm run lint
npm run build
```

Useful commands:

```bash
# Run the TypeScript CLI directly
npm run dev -- info input.geojson

# Run the compiled CLI
npm start -- info input.geojson

# Create an npm tarball
npm pack
```

The test suite covers parser behavior, CLI conversion behavior, vector tile generation, database SQL/WKB behavior, streaming GeoJSON, CRS transforms, encoding detection, and error handling. Set `GIS_READ_TEST_PG_CONNECTION` to run the optional live PostGIS integration test.

## Packaging

The npm package intentionally includes only runtime artifacts:

- `dist/`
- `README.md`
- `read.md`
- `操作手册.md`
- `LICENSE`

Large sample files, generated outputs, source tests, and development-only fixtures are not included in the package. `npm pack` runs `npm run build` first through the `prepack` script.

To inspect package contents before publishing:

```bash
npm pack --dry-run
```

To publish publicly:

```bash
npm publish --access public
```

Source repository: <https://github.com/younggis/gis-read>

## Repository Layout

```text
src/
  cli.ts                  CLI entry point
  index.ts                Public library exports
  crs.ts                  CRS definitions and transforms
  encoding.ts             Text encoding detection/decoding
  format-detect.ts        Format detection
  parsers/                Format-specific parsers and writers
test/
  cli.test.ts             CLI integration tests
  parsers.test.ts         Parser/writer/CRS/encoding tests
  streaming.test.ts       Streaming, logger, and error-boundary tests
操作手册.md                 Full Chinese operation manual
```

## Limitations

- Shapefile output writes one geometry family per bundle; split mixed Point/Line/Polygon data before exporting.
- Shapefile DBF reading avoids Node's 2 GiB single-Buffer limit, but normal `parse` and `convert` still materialize the returned features in memory. Use `gis parse input.shp --limit 10` to inspect very large data first.
- Vector tile generation writes XYZ `.pbf` directories only; MBTiles and GeoJSON tile output are not included.
- Vector tile input is parsed into memory before tiling; use `--threads` to parallelize tile encoding across worker threads.
- Database import auto-creates geometry tables and fails if the target table already exists; when `--table` is omitted, the input filename without extension is used as the table name.
- Imported attribute columns are sanitized and de-duplicated case-insensitively; source fields such as `ID` that collide with the internal `id` primary key are written as `ID_1`.
- Database export accepts a table name plus optional `--where`; when `--geom-column` is omitted, it auto-detects the only `geometry`/`geography` column. When `-o/--output` is omitted, output defaults to `<table>.geojson`. Arbitrary SQL export is not included.
- Derived database table names must be valid identifiers: letters/numbers/underscore, not starting with a number. Chinese letters are accepted; spaces and hyphens are rejected.
- SQL Server import/export uses the `mssql` package and supports the CommonJS default export shape used by `mssql@11`. For older SQL Server TLS setups, add `Encrypt=false` to the connection string or enable TLS 1.2 on the server; `TrustServerCertificate=true` skips certificate validation but does not disable encryption.
- Encoding detection can recover mislabeled UTF-8 `.cpg` files and `Neutral` TAB headers when the original DBF/DAT bytes still contain Chinese text. Characters already replaced with literal `?` by the source exporter, or DBF field names truncated mid-character by the 11-byte dBASE name limit, cannot be reconstructed.
- MapInfo TAB output delegates to GDAL `ogr2ogr`; install GDAL or write MapInfo MIF when `ogr2ogr` is unavailable.
- CSV output stores geometry as WKT in a single `wkt` column.
- GPX cannot represent polygons; polygon and multipolygon output is skipped.
- KML parsing focuses on static Placemark geometry and does not cover dynamic display features such as NetworkLink, Region, and LOD.
- GeoPackage reading loads the entire file into memory via sql.js (WASM); very large files may require significant RAM. Use `--layer` to process individual layers. The `_layer` property is added to each feature to preserve the source table name.
- Some MapInfo TAB `.map` private record types may produce `geometry: null`; attributes are still returned. Common legacy line records and v500 `0x25` point-table line records are decoded as `LineString` or `MultiLineString`, and v300 compressed/uncompressed region coordinate blocks are decoded as `Polygon` or `MultiPolygon`.

## Contributing

Contributions should include tests for new formats, conversion paths, or bug fixes. Run the full verification set before opening a pull request:

```bash
npm test
npm run lint
npm run build
npm pack --dry-run
```

Pull requests should describe the affected format or CLI behavior and include sample commands or fixtures when behavior changes.

## Security

Treat GIS files as untrusted input. Avoid running this tool on files from unknown sources in privileged environments. Do not commit `.env`, logs, generated output, or large local sample data.

## License

MIT
