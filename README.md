# gis-read

[中文](./read.md) | English

`gis-read` is a TypeScript GIS parser and converter available as both a CLI and a Node.js library. It normalizes supported GIS inputs into GeoJSON-style features, then writes common interchange formats such as GeoJSON, KML, GPX, ESRI JSON, CSV/WKT, Shapefile, and MapInfo MIF.

## Features

- Parse Shapefile, MapInfo TAB, GeoJSON, KML, GPX, TopoJSON, CZML, CSV/WKT, ESRI JSON, and MapInfo MIF.
- Convert supported inputs to GeoJSON, KML, GPX, ESRI JSON, CSV/WKT, Shapefile, or MapInfo MIF. MapInfo TAB writing is available when GDAL `ogr2ogr` is installed.
- Stream large GeoJSON files to GeoJSON/KML/GPX without loading the whole file into memory.
- Preserve common metadata such as CRS, bbox, attributes, and parser-specific details.
- Transform coordinates between WGS84, WebMercator, CGCS2000, GCJ-02, BD-09, and supported `EPSG:xxxx` definitions.
- Detect common Chinese GIS text encodings from `.cpg`, TAB headers, dBASE language drivers, and content heuristics.
- Decode MapInfo TAB `WindowsSimpChinese` field names and attribute values, and common legacy line records into GeoJSON line geometries.

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
npm install -g ./gis-read-0.1.0.tgz
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
| Shapefile | `.shp` + sidecars | Yes | Yes | Writes `.shp/.shx/.dbf/.cpg`; one geometry family per bundle. |
| MapInfo TAB | `.tab` + `.dat`/`.map`/`.id` | Yes | Yes* | Write requires GDAL `ogr2ogr`; reads TAB charsets, Chinese attributes, and common legacy line records; unsupported private `.map` records may return `null`. |
| GeoJSON | `.geojson`, `.json` | Yes | Yes | Streaming input and output supported. |
| KML | `.kml` | Yes | Yes | Supports Placemark, ExtendedData, Point, LineString, Polygon, MultiGeometry. |
| GPX | `.gpx` | Yes | Yes | Waypoints and tracks/routes; polygon output is skipped. |
| TopoJSON | `.topojson` | Yes | GeoJSON only | Expands shared arcs into coordinates. |
| CZML | `.czml` | Yes | GeoJSON only | Converts entity packets to features. |
| CSV/WKT | `.csv` | Yes | Yes | Writes attributes plus a `wkt` geometry column. |
| ESRI JSON | `.json` | Yes | Yes | Reads/writes ArcGIS-style geometry structures. |
| MapInfo MIF | `.mif` + `.mid` | Yes | Yes | Writes text `.mif` plus attribute `.mid`. |

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
  transformFeatures,
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
```

Streaming GeoJSON:

```ts
import { parseGeoJSONStream } from 'gis-read';

for await (const feature of parseGeoJSONStream('big.geojson')) {
  console.log(feature.properties);
}
```

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

The test suite covers parser behavior, CLI conversion behavior, streaming GeoJSON, CRS transforms, encoding detection, and error handling.

## Packaging

The npm package intentionally includes only runtime artifacts:

- `dist/`
- `README.md`
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
- MapInfo TAB output delegates to GDAL `ogr2ogr`; install GDAL or write MapInfo MIF when `ogr2ogr` is unavailable.
- CSV output stores geometry as WKT in a single `wkt` column.
- GPX cannot represent polygons; polygon and multipolygon output is skipped.
- KML parsing focuses on static Placemark geometry and does not cover dynamic display features such as NetworkLink, Region, and LOD.
- Some MapInfo TAB `.map` private record types may produce `geometry: null`; attributes are still returned. Common legacy line records with scaled lon/lat coordinates are decoded as `LineString` or `MultiLineString`.

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
