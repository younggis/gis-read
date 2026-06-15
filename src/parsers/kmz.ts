/**
 * KMZ (Keyhole Markup Language Zipped) parser and writer.
 *
 * KMZ is a ZIP archive that bundles a `doc.kml` file (the root KML document)
 * with optional overlay images and resources. We extract the KML payload and
 * delegate to the existing parseKML implementation, so all geometry, network
 * links, schemas, and other KML features supported by `parseKML` work in KMZ
 * without duplication.
 *
 * Reference: https://developers.google.com/kml/documentation/kmzarchives
 */
import * as fs from 'node:fs';
import AdmZip from 'adm-zip';
import type { Feature, Geometry, ParseResult, Properties, WriteOptions } from '../types.js';
import { parseKML, writeKML } from './kml.js';

const ROOT_KML_NAME = 'doc.kml';

export function parseKMZ(filePath: string | Buffer): ParseResult {
  const buf = typeof filePath === 'string' ? fs.readFileSync(filePath) : filePath;
  const zip = new AdmZip(buf);

  // Prefer the canonical `doc.kml` entry; otherwise fall back to the first
  // .kml entry found. This matches the OGC KMZ convention while still
  // handling archives produced by tools that name the root differently.
  let kmlEntry = zip.getEntry(ROOT_KML_NAME);
  if (!kmlEntry) {
    for (const e of zip.getEntries()) {
      if (!e.isDirectory && e.entryName.toLowerCase().endsWith('.kml')) {
        kmlEntry = e;
        break;
      }
    }
  }
  if (!kmlEntry) {
    throw new Error('KMZ archive does not contain a .kml entry (expected doc.kml)');
  }

  const kmlText = zip.readAsText(kmlEntry);
  if (kmlText == null) {
    throw new Error(`Failed to read KML entry from KMZ: ${kmlEntry.entryName}`);
  }

  const result = parseKML(kmlText);
  // Override the source so callers can tell which container the data came from.
  result.meta = { ...(result.meta ?? {}), source: 'kmz' };
  return result;
}

export function writeKMZ(result: ParseResult, opts: WriteOptions = {}): Buffer {
  const kmlText = writeKML(result, opts);
  const zip = new AdmZip();
  zip.addFile(ROOT_KML_NAME, Buffer.from(kmlText, 'utf8'));
  return zip.toBuffer();
}
