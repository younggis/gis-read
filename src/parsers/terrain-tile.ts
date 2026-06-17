/**
 * Terrain tile generator — converts DEM (GeoTIFF) to Mapbox terrain-RGB PNG tiles.
 *
 * Pure JavaScript implementation, no GDAL dependency.
 * Uses geotiff for reading DEM, pngjs for writing PNG.
 *
 * Output: {z}/{x}/{y}.png directory structure (XYZ scheme).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromFile } from 'geotiff';
import { PNG } from 'pngjs';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEB_MERCATOR_MAX = 20037508.342789244;
const WEB_MERCATOR_SIZE = WEB_MERCATOR_MAX * 2;

// ---------------------------------------------------------------------------
// Terrain-RGB encoding
// ---------------------------------------------------------------------------

export type TerrainEncoding = 'terrain-rgb' | 'terrarium';

/** Encode elevation (meters) to RGB using Mapbox terrain-rgb encoding. */
function encodeTerrainRGB(height: number): [number, number, number] {
  const value = Math.round((height + 10000) * 10);
  const clamped = Math.max(0, Math.min(2147483647, value));
  return [
    Math.floor(clamped / 65536) & 0xff,
    Math.floor((clamped % 65536) / 256) & 0xff,
    clamped % 256,
  ];
}

/** Encode elevation using Mapzen Terrarium encoding. */
function encodeTerrarium(height: number): [number, number, number] {
  const value = Math.round(height + 32768);
  const clamped = Math.max(0, Math.min(65535, value));
  return [
    Math.floor(clamped / 256),
    clamped % 256,
    0,
  ];
}

function makeEncoder(encoding: TerrainEncoding): (h: number) => [number, number, number] {
  return encoding === 'terrarium' ? encodeTerrarium : encodeTerrainRGB;
}

// ---------------------------------------------------------------------------
// Tile coordinate math (reused from vector-tile concepts)
// ---------------------------------------------------------------------------

function tileRangeForBBox(bbox: [number, number, number, number], z: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const n = 1 << z;
  const minX = Math.max(0, Math.floor(((bbox[0] + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n));
  const maxX = Math.min(n - 1, Math.floor(((bbox[2] + WEB_MERCATOR_MAX) / WEB_MERCATOR_SIZE) * n));
  const minY = Math.max(0, Math.floor(((WEB_MERCATOR_MAX - bbox[3]) / WEB_MERCATOR_SIZE) * n));
  const maxY = Math.min(n - 1, Math.floor(((WEB_MERCATOR_MAX - bbox[1]) / WEB_MERCATOR_SIZE) * n));
  return { minX, maxX, minY, maxY };
}

/** Get tile bbox in WGS84 lon/lat. */
function tileBBoxWGS84(z: number, x: number, y: number): [number, number, number, number] {
  const n = 1 << z;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latMin = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return [lonMin, latMin, lonMax, latMax];
}

/** Convert WGS84 lon/lat to Web Mercator. */
function wgs84ToWebMercator(lon: number, lat: number): [number, number] {
  const x = (lon / 180) * WEB_MERCATOR_MAX;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  return [x, (y / 180) * WEB_MERCATOR_MAX];
}

// ---------------------------------------------------------------------------
// DEM reader
// ---------------------------------------------------------------------------

export interface DEMData {
  width: number;
  height: number;
  bbox: [number, number, number, number]; // WGS84 [minX, minY, maxX, maxY]
  data: Float32Array;
  nodata: number;
  srsId: number; // EPSG code
}

export async function readDEM(filePath: string): Promise<DEMData> {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();

  // Get bounding box from image
  const bbox = image.getBoundingBox() as [number, number, number, number];

  // Get CRS info
  const geoKeys = image.getGeoKeys();
  const srsId = geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey ?? 4326;

  // Get NoData value
  const nodata = image.getGDALNoData() ?? -9999;

  // Read raster data
  const rasterData = await image.readRasters({ interleave: false });
  const data = new Float32Array(rasterData[0] as Float32Array);

  return { width, height, bbox, data, nodata, srsId };
}

// ---------------------------------------------------------------------------
// Bilinear sampling
// ---------------------------------------------------------------------------

/** Sample DEM at a given geographic coordinate using bilinear interpolation. */
export function sampleDEM(dem: DEMData, lon: number, lat: number): number {
  // Convert lon/lat to pixel coordinates
  const px = ((lon - dem.bbox[0]) / (dem.bbox[2] - dem.bbox[0])) * (dem.width - 1);
  const py = ((dem.bbox[3] - lat) / (dem.bbox[3] - dem.bbox[1])) * (dem.height - 1);

  // Integer pixel coordinates
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, dem.width - 1);
  const y1 = Math.min(y0 + 1, dem.height - 1);

  // Clamp to valid range
  const cx0 = Math.max(0, Math.min(x0, dem.width - 1));
  const cy0 = Math.max(0, Math.min(y0, dem.height - 1));

  // Fractional part
  const fx = px - x0;
  const fy = py - y0;

  // Sample 4 corners
  const v00 = getElevation(dem, cx0, cy0);
  const v10 = getElevation(dem, x1, cy0);
  const v01 = getElevation(dem, cx0, y1);
  const v11 = getElevation(dem, x1, y1);

  // Bilinear interpolation
  const v0 = v00 * (1 - fx) + v10 * fx;
  const v1 = v01 * (1 - fx) + v11 * fx;
  return v0 * (1 - fy) + v1 * fy;
}

export function getElevation(dem: DEMData, x: number, y: number): number {
  if (x < 0 || x >= dem.width || y < 0 || y >= dem.height) return 0;
  const idx = y * dem.width + x;
  const val = dem.data[idx];
  return val === dem.nodata ? 0 : val;
}

// ---------------------------------------------------------------------------
// Tile generator
// ---------------------------------------------------------------------------

export interface TerrainTileOptions {
  outputPath: string;
  minZoom?: number;
  maxZoom?: number;
  encoding?: TerrainEncoding;
  fromCrs?: string;
  tileSize?: number;
}

export interface TerrainTileSummary {
  totalTiles: number;
  emptyTilesSkipped: number;
  minZoom: number;
  maxZoom: number;
  outputPath: string;
}

export async function writeTerrainTiles(
  demPath: string,
  opts: TerrainTileOptions,
): Promise<TerrainTileSummary> {
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = opts.maxZoom ?? 12;
  const encoding = opts.encoding ?? 'terrain-rgb';
  const tileSize = opts.tileSize ?? 256;
  const encode = makeEncoder(encoding);

  log.info(`Reading DEM: ${demPath}`);
  const dem = await readDEM(demPath);
  log.info(`DEM: ${dem.width}×${dem.height}, bbox=[${dem.bbox.join(', ')}], srs=${dem.srsId}, nodata=${dem.nodata}`);

  // Convert DEM bbox to Web Mercator for tile range calculation
  const wmBbox = [
    ...wgs84ToWebMercator(dem.bbox[0], dem.bbox[1]),
    ...wgs84ToWebMercator(dem.bbox[2], dem.bbox[3]),
  ] as [number, number, number, number];

  let totalTiles = 0;
  let emptyTilesSkipped = 0;

  for (let z = minZoom; z <= maxZoom; z++) {
    const range = tileRangeForBBox(wmBbox, z);
    const tileCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    log.info(`Zoom ${z}: ${range.minX}-${range.maxX} x ${range.minY}-${range.maxY} (${tileCount} tiles)`);

    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        const tileBBox = tileBBoxWGS84(z, x, y);
        const png = generateTile(dem, tileBBox, tileSize, encode);

        if (!png) {
          emptyTilesSkipped++;
          continue;
        }

        const tileDir = path.join(opts.outputPath, String(z), String(x));
        fs.mkdirSync(tileDir, { recursive: true });
        fs.writeFileSync(path.join(tileDir, `${y}.png`), png);
        totalTiles++;
      }
    }
  }

  return { totalTiles, emptyTilesSkipped, minZoom, maxZoom, outputPath: opts.outputPath };
}

/** Generate a single terrain tile as PNG buffer. Returns null if tile is empty. */
function generateTile(
  dem: DEMData,
  tileBBox: [number, number, number, number],
  tileSize: number,
  encode: (h: number) => [number, number, number],
): Buffer | null {
  const png = new PNG({ width: tileSize, height: tileSize });
  let hasData = false;

  for (let py = 0; py < tileSize; py++) {
    for (let px = 0; px < tileSize; px++) {
      // Map pixel to lon/lat
      const lon = tileBBox[0] + ((px + 0.5) / tileSize) * (tileBBox[2] - tileBBox[0]);
      const lat = tileBBox[3] - ((py + 0.5) / tileSize) * (tileBBox[3] - tileBBox[1]);

      // Sample DEM
      const elevation = sampleDEM(dem, lon, lat);

      // Encode to RGB
      const [r, g, b] = encode(elevation);

      // Write pixel
      const idx = (py * tileSize + px) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255; // alpha

      if (elevation !== 0 || hasData) hasData = true;
    }
  }

  if (!hasData) return null;

  return PNG.sync.write(png);
}
