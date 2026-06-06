/**
 * KML (Keyhole Markup Language) parser and writer.
 *
 * KML is XML-based; we use a small built-in streaming parser tailored to
 * the Placemark + ExtendedData structures used by QGIS / Google Earth.
 * Coordinates are encoded as comma/whitespace-separated tuples inside
 * <coordinates> elements; we parse them into GeoJSON geometry.
 *
 * This parser is intentionally narrow: it doesn't try to handle every
 * KML feature (NetworkLink, Region, ...). It focuses on the static
 * geometry payload produced by typical GIS export tools.
 */
import * as fs from 'node:fs';
import type { Feature, Geometry, ParseResult, Properties, WriteOptions } from '../types.js';

export function parseKML(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const root = parseXML(text);

  let name: string | undefined;
  const docNode = findFirst(root, 'Document');
  if (docNode) {
    const n = findFirst(docNode, 'name');
    if (n) name = n.text.trim();
  }

  const features: Feature[] = [];
  const placemarks = findAll(root, 'Placemark');
  for (const pm of placemarks) {
    features.push(placemarkToFeature(pm));
  }

  return { name, features, meta: { source: 'kml' } };
}

function placemarkToFeature(pm: XMLNode): Feature {
  const nameNode = findFirst(pm, 'name');
  const props: Properties = {};
  if (nameNode) {
    const t = nameNode.text.trim();
    if (t) props.name = t;
  }

  // ExtendedData with SchemaData / Data — flatten into properties.
  for (const ed of findAll(pm, 'ExtendedData')) {
    for (const data of findAll(ed, 'Data')) {
      const key = data.attrs.name;
      if (!key) continue;
      const v = findFirst(data, 'value');
      props[key] = parseValue(v?.text ?? '');
    }
    for (const sd of findAll(ed, 'SchemaData')) {
      const schemaUrl = sd.attrs.schemaUrl;
      for (const sf of findAll(sd, 'SimpleField')) {
        const key = sf.attrs.name;
        if (!key) continue;
        props[key] = parseValue(sf.text);
      }
      // SimpleField under SchemaData — covered above.
      // Top-level SimpleData appears under Placemark, handled below.
      void schemaUrl;
    }
  }

  // SimpleData is sometimes placed directly under Placemark.
  for (const sd of findAll(pm, 'SimpleData')) {
    const key = sd.attrs.name;
    if (key) props[key] = parseValue(sd.text);
  }

  // Description as property if present.
  const desc = findFirst(pm, 'description');
  if (desc) {
    const t = desc.text.trim();
    if (t) props.description = t;
  }

  const geometry = parseGeometry(pm);
  return { type: 'Feature', geometry, properties: props };
}

function parseGeometry(pm: XMLNode): Geometry | null {
  for (const tag of ['Point', 'LineString', 'Polygon', 'MultiGeometry']) {
    const node = findFirst(pm, tag);
    if (!node) continue;

    if (tag === 'Point') {
      const c = readCoordinates(node);
      if (!c.length) return null;
      return { type: 'Point', coordinates: c[0] };
    }
    if (tag === 'LineString') {
      return { type: 'LineString', coordinates: readCoordinates(node) };
    }
    if (tag === 'Polygon') {
      return parsePolygon(node);
    }
    if (tag === 'MultiGeometry') {
      return parseMulti(node);
    }
  }
  return null;
}

function parsePolygon(node: XMLNode): Geometry {
  const rings: number[][][] = [];
  const outer = findFirst(node, 'outerBoundaryIs');
  if (outer) {
    const ls = findFirst(outer, 'LinearRing');
    if (ls) rings.push(readCoordinates(ls));
  }
  for (const inner of findAll(node, 'innerBoundaryIs')) {
    const ls = findFirst(inner, 'LinearRing');
    if (ls) rings.push(readCoordinates(ls));
  }
  return { type: 'Polygon', coordinates: rings };
}

function parseMulti(node: XMLNode): Geometry {
  const polygons: number[][][][] = [];
  const lines: number[][][] = [];
  const points: number[][] = [];

  for (const child of node.children) {
    if (child.name === 'Point') {
      const c = readCoordinates(child);
      if (c.length) points.push(c[0]);
    } else if (child.name === 'LineString') {
      lines.push(readCoordinates(child));
    } else if (child.name === 'Polygon') {
      polygons.push((parsePolygon(child) as any).coordinates);
    } else if (child.name === 'MultiGeometry') {
      const sub = parseMulti(child);
      if (sub.type === 'MultiPolygon') polygons.push(...(sub.coordinates as any));
      else if (sub.type === 'MultiLineString') lines.push(...(sub.coordinates as any));
      else if (sub.type === 'MultiPoint') points.push(...(sub.coordinates as any));
    }
  }

  if (polygons.length) return { type: 'MultiPolygon', coordinates: polygons };
  if (lines.length) {
    return lines.length === 1
      ? { type: 'LineString', coordinates: lines[0] }
      : { type: 'MultiLineString', coordinates: lines };
  }
  if (points.length) {
    return points.length === 1
      ? { type: 'Point', coordinates: points[0] }
      : { type: 'MultiPoint', coordinates: points };
  }
  return { type: 'GeometryCollection', coordinates: [] };
}

/** Read a <coordinates> child (or self, for KML2-coordinate nodes). */
function readCoordinates(node: XMLNode): number[][] {
  const c = findFirst(node, 'coordinates');
  const raw = c ? c.text : '';
  return parseCoordString(raw);
}

/** Parse a <coordinates> string into Position[]. */
export function parseCoordString(raw: string): number[][] {
  if (!raw) return [];
  return raw
    .trim()
    .split(/[\s]+/)
    .filter((s) => s.length > 0)
    .map((tuple) =>
      tuple.split(',').map((p) => {
        const n = Number(p);
        if (!Number.isFinite(n)) throw new Error(`Invalid coordinate: ${p}`);
        return n;
      })
    );
}

function parseValue(s: string): unknown {
  const trimmed = (s ?? '').trim();
  if (trimmed === '' || trimmed === 'null') return null;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  return trimmed;
}

// --- XML reader (no dependency, narrow scope) ---------------------------

interface XMLNode {
  name: string;
  attrs: Record<string, string>;
  children: XMLNode[];
  text: string;
  /** line/column for debugging */
  start: number;
}

function findFirst(node: XMLNode, name: string): XMLNode | null {
  for (const c of node.children) if (c.name === name) return c;
  return null;
}

function findAll(node: XMLNode, name: string): XMLNode[] {
  const out: XMLNode[] = [];
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    for (const cc of c.children) collect(cc, name, out);
  }
  return out;
}

function collect(node: XMLNode, name: string, out: XMLNode[]): void {
  if (node.name === name) out.push(node);
  for (const c of node.children) collect(c, name, out);
}

function parseXML(text: string): XMLNode {
  const root: XMLNode = { name: '#document', attrs: {}, children: [], text: '', start: 0 };
  const stack: XMLNode[] = [root];
  let i = 0;
  const top = (): XMLNode => stack[stack.length - 1] ?? root;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      // Trailing text.
      const tail = text.slice(i);
      if (tail.trim().length) top().text += tail;
      break;
    }
    if (lt > i) {
      top().text += text.slice(i, lt);
      i = lt;
    }

    // Comment.
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    // CDATA.
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) break;
      top().text += text.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    // Processing instruction.
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    // DOCTYPE.
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    // Closing tag.
    if (text[i + 1] === '/') {
      const end = text.indexOf('>', i + 2);
      if (end < 0) break;
      const name = text.slice(i + 2, end).trim();
      if (stack.length > 1) stack.pop();
      // If name doesn't match the top's name (malformed), pop until match.
      else if (stack[stack.length - 1].name !== name) {
        while (stack.length > 1 && stack[stack.length - 1].name !== name) stack.pop();
        if (stack.length > 1 && stack[stack.length - 1].name === name) stack.pop();
      }
      i = end + 1;
      continue;
    }

    // Opening tag.
    const end = text.indexOf('>', i);
    if (end < 0) break;
    const raw = text.slice(i + 1, end);
    i = end + 1;

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = body.match(/^([\w:.-]+)([\s\S]*)$/);
    if (!m) continue;
    const tagName = m[1];
    const attrStr = m[2];
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrStr))) attrs[am[1]] = decodeEntities(am[2]);

    const node: XMLNode = { name: tagName, attrs, children: [], text: '', start: i };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// --- Writer -------------------------------------------------------------

export function writeKML(result: ParseResult, opts: WriteOptions = {}): string {
  const precision = opts.precision ?? 6;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
  const docName = opts.name ?? result.name;
  if (docName) lines.push(`  <Document><name>${esc(docName)}</name>`);
  for (const f of result.features) {
    lines.push(...featureToKML(f, '  ', precision));
  }
  if (docName) lines.push('  </Document>');
  lines.push('</kml>');
  return lines.join('\n');
}

function featureToKML(f: Feature, indent: string, precision: number): string[] {
  return formatKMLPlacemarkLines(f, indent, precision);
}

/**
 * Serialize a single Feature to a complete `<Placemark>...</Placemark>` block.
 *
 * Returns one string per XML line (no trailing newline). Used by both the
 * in-memory `writeKML` writer and the streaming CLI writer — keeping this
 * in one place prevents geometry types from being silently dropped (which
 * was the bug for the `stream` subcommand before this refactor).
 */
export function formatKMLPlacemarkLines(
  f: Feature,
  indent: string,
  precision: number,
): string[] {
  const out: string[] = [`${indent}<Placemark>`];
  const props = f.properties ?? {};
  const name = props.name;
  if (typeof name === 'string' && name.length) out.push(`${indent}  <name>${esc(name)}</name>`);
  const ext = Object.entries(props).filter(([k, v]) => k !== 'name' && v !== undefined && v !== null);
  if (ext.length) {
    out.push(`${indent}  <ExtendedData>`);
    for (const [k, v] of ext) {
      out.push(`${indent}    <Data name="${esc(k)}"><value>${esc(String(v))}</value></Data>`);
    }
    out.push(`${indent}  </ExtendedData>`);
  }
  if (f.geometry) {
    out.push(`${indent}  ${formatKMLGeometry(f.geometry, indent + '  ', precision)}`);
  }
  out.push(`${indent}</Placemark>`);
  return out;
}

/**
 * Serialize a single GeoJSON Geometry as the inner XML of a `<Placemark>`.
 * Handles every GeoJSON geometry type: Point, MultiPoint, LineString,
 * MultiLineString, Polygon, MultiPolygon. Unknown / unsupported types
 * return an empty string (caller skips the Placemark).
 */
export function formatKMLGeometry(g: Geometry, indent: string, precision: number): string {
  const fmt = (n: number) => n.toFixed(precision);
  const fmtPoint = (p: number[]) => p.map(fmt).join(',');
  const fmtRing = (ring: number[][]) => ring.map(fmtPoint).join(' ');

  if (g.type === 'Point') {
    return `<Point><coordinates>${fmtPoint(g.coordinates)}</coordinates></Point>`;
  }
  if (g.type === 'LineString') {
    return `<LineString><coordinates>${fmtRing(g.coordinates as number[][])}</coordinates></LineString>`;
  }
  if (g.type === 'Polygon') {
    const rings = g.coordinates as number[][][];
    const parts: string[] = ['<Polygon>'];
    if (rings[0]) {
      parts.push(`${indent}  <outerBoundaryIs><LinearRing><coordinates>${fmtRing(rings[0])}</coordinates></LinearRing></outerBoundaryIs>`);
    }
    for (let i = 1; i < rings.length; i++) {
      parts.push(`${indent}  <innerBoundaryIs><LinearRing><coordinates>${fmtRing(rings[i])}</coordinates></LinearRing></innerBoundaryIs>`);
    }
    parts.push(`${indent}</Polygon>`);
    return parts.join('\n');
  }
  if (g.type === 'MultiPolygon') {
    const polys = g.coordinates as number[][][][];
    const out: string[] = ['<MultiGeometry>'];
    for (const p of polys) {
      out.push(`${indent}  <Polygon>`);
      if (p[0]) {
        out.push(`${indent}    <outerBoundaryIs><LinearRing><coordinates>${fmtRing(p[0])}</coordinates></LinearRing></outerBoundaryIs>`);
      }
      for (let i = 1; i < p.length; i++) {
        out.push(`${indent}    <innerBoundaryIs><LinearRing><coordinates>${fmtRing(p[i])}</coordinates></LinearRing></innerBoundaryIs>`);
      }
      out.push(`${indent}  </Polygon>`);
    }
    out.push(`${indent}</MultiGeometry>`);
    return out.join('\n');
  }
  if (g.type === 'MultiLineString') {
    const lines = g.coordinates as number[][][];
    const out: string[] = ['<MultiGeometry>'];
    for (const l of lines) {
      out.push(`${indent}  <LineString><coordinates>${fmtRing(l)}</coordinates></LineString>`);
    }
    out.push(`${indent}</MultiGeometry>`);
    return out.join('\n');
  }
  if (g.type === 'MultiPoint') {
    const pts = g.coordinates as number[][];
    const out: string[] = ['<MultiGeometry>'];
    for (const p of pts) {
      out.push(`${indent}  <Point><coordinates>${fmtPoint(p)}</coordinates></Point>`);
    }
    out.push(`${indent}</MultiGeometry>`);
    return out.join('\n');
  }
  return '';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function convertKML(inputPath: string, outputPath?: string, opts: WriteOptions = {}): ParseResult {
  const result = parseKML(fs.readFileSync(inputPath));
  if (outputPath) fs.writeFileSync(outputPath, writeKML(result, opts), 'utf8');
  return result;
}
