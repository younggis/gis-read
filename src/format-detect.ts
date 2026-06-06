/**
 * Format detection helpers.
 *
 * Each detector inspects file content / extension and returns a canonical
 * format key used by the CLI to pick a parser.
 */
import * as fs from 'node:fs';

export type Format =
  | 'shapefile'
  | 'geojson'
  | 'kml'
  | 'tab'
  | 'gpx'
  | 'topojson'
  | 'czml'
  | 'csv'
  | 'esrijson'
  | 'mif'
  | 'unknown';

/** Detect format from a file path. Inspects .tab and .shp companions when relevant. */
export function detectFormat(filePath: string): Format {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.shp')) return 'shapefile';
  if (lower.endsWith('.geojson')) return 'geojson';
  if (lower.endsWith('.kml')) return 'kml';
  if (lower.endsWith('.tab')) return 'tab';
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.topojson')) return 'topojson';
  if (lower.endsWith('.czml')) return 'czml';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.mif')) return 'mif';
  if (lower.endsWith('.json')) {
    // Disambiguate plain .json between geojson / topojson / esrijson / czml.
    return detectJsonVariant(filePath);
  }

  // Fallback: read first bytes for binary format detection.
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return detectFormatFromBuffer(buf);
  } catch {
    return 'unknown';
  }
}

function detectJsonVariant(filePath: string): Format {
  try {
    const text = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
    if (/"type"\s*:\s*"Topology"/.test(text)) return 'topojson';
    if (/"spatialReference"/.test(text) || /"esriGeometry/.test(text)) return 'esrijson';
    if (/"czml"|^[\s*\[\{]/.test(text) && /"packet"/.test(text)) return 'czml';
    if (/^\s*\[/.test(text) && /"id"\s*:/.test(text)) return 'czml';
    return 'geojson';
  } catch {
    return 'geojson';
  }
}

/** Detect format from a buffer. */
export function detectFormatFromBuffer(buf: Buffer): Format {
  if (buf.length < 4) return 'unknown';

  // Shapefile magic number is 9994 (0x0000270A) at offset 0.
  if (buf.readUInt32BE(0) === 9994) return 'shapefile';

  // MapInfo .tab is a plain-text INI-ish file starting with "!table".
  const head = buf.toString('utf8', 0, Math.min(buf.length, 32));
  if (head.startsWith('!table')) return 'tab';

  // GPX starts with "<?xml" + <gpx, or just <gpx.
  if (/<gpx[\s>]/i.test(head)) return 'gpx';

  // KML begins with "<?xml" or "<kml".
  if (head.startsWith('<?xml') || /<kml[\s>]/.test(head)) return 'kml';

  // MIF begins with "Version" header.
  if (/^Version\s+\d+/i.test(head)) return 'mif';

  // JSON-based formats.
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{')) {
    if (/"type"\s*:\s*"Topology"/.test(trimmed)) return 'topojson';
    if (/"spatialReference"/.test(trimmed) || /"esriGeometry/.test(trimmed)) return 'esrijson';
    return 'geojson';
  }
  if (trimmed.startsWith('[')) {
    if (/"packet"|"id"\s*:|"czml"/.test(trimmed)) return 'czml';
    return 'geojson';
  }

  return 'unknown';
}

/** Sibling files that accompany a primary file. */
export const SHAPEFILE_SIBLINGS = ['.shp', '.shx', '.dbf', '.prj', '.cpg'] as const;
export const TAB_SIBLINGS = ['.tab', '.map', '.dat', '.id'] as const;
export const MIF_SIBLINGS = ['.mif', '.mid'] as const;
