/**
 * GML (Geography Markup Language) parser and writer.
 *
 * GML is an OGC XML-based format for geographic data. This parser handles
 * common GML 3.x geometry types used in GIS data exchange:
 *   gml:Point, gml:LineString, gml:Polygon, gml:MultiPoint,
 *   gml:MultiLineString, gml:MultiPolygon, gml:GeometryCollection
 *
 * Coordinates are read from gml:pos, gml:posList, or gml:coordinates elements.
 *
 * The writer produces GML 3.2 FeatureCollection with gml:featureMember elements.
 */
import type { Feature, Geometry, ParseResult, Properties, WriteOptions } from '../types.js';

// ---------------------------------------------------------------------------
// XML Node (same lightweight parser as KML)
// ---------------------------------------------------------------------------

interface XMLNode {
  name: string;
  attrs: Record<string, string>;
  children: XMLNode[];
  text: string;
}

function findFirst(node: XMLNode, name: string): XMLNode | null {
  for (const c of node.children) if (stripNS(c.name) === name) return c;
  return null;
}

function findAll(node: XMLNode, name: string): XMLNode[] {
  const out: XMLNode[] = [];
  for (const c of node.children) {
    if (stripNS(c.name) === name) out.push(c);
    for (const cc of c.children) collect(cc, name, out);
  }
  return out;
}

function collect(node: XMLNode, name: string, out: XMLNode[]): void {
  if (stripNS(node.name) === name) out.push(node);
  for (const c of node.children) collect(c, name, out);
}

/** Strip namespace prefix: "gml:Point" → "Point" */
function stripNS(name: string): string {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

function parseXML(text: string): XMLNode {
  const root: XMLNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XMLNode[] = [root];
  let i = 0;
  const top = (): XMLNode => stack[stack.length - 1] ?? root;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      const tail = text.slice(i);
      if (tail.trim().length) top().text += tail;
      break;
    }
    if (lt > i) {
      top().text += text.slice(i, lt);
      i = lt;
    }

    // Comment
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    // CDATA
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) break;
      top().text += text.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    // Processing instruction
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    // DOCTYPE
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    // Closing tag
    if (text[i + 1] === '/') {
      const end = text.indexOf('>', i + 2);
      if (end < 0) break;
      const name = text.slice(i + 2, end).trim();
      if (stack.length > 1) stack.pop();
      else if (stack[stack.length - 1].name !== name) {
        while (stack.length > 1 && stack[stack.length - 1].name !== name) stack.pop();
        if (stack.length > 1 && stack[stack.length - 1].name === name) stack.pop();
      }
      i = end + 1;
      continue;
    }

    // Opening tag
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

    const node: XMLNode = { name: tagName, attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// GML Coordinate Parsing
// ---------------------------------------------------------------------------

/** Parse gml:pos or gml:posList — space-separated coordinates, each 2-3 numbers. */
function parsePosList(text: string): number[][] {
  if (!text) return [];
  const nums = text.trim().split(/\s+/).map(Number);
  const dim = 2; // assume 2D; 3D support could detect from gml:dimension attr
  const coords: number[][] = [];
  for (let i = 0; i + dim <= nums.length; i += dim) {
    coords.push([nums[i], nums[i + 1]]);
  }
  return coords;
}

/** Parse gml:coordinates — comma-separated tuples (older GML 2 style). */
function parseCoordinates(text: string): number[][] {
  if (!text) return [];
  return text
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((tuple) => tuple.split(',').map(Number).slice(0, 2));
}

/** Read coordinates from a geometry node (posList, pos, or coordinates). */
function readCoords(node: XMLNode): number[][] {
  const posList = findFirst(node, 'posList');
  if (posList) return parsePosList(posList.text);
  const pos = findFirst(node, 'pos');
  if (pos) return parsePosList(pos.text);
  const coords = findFirst(node, 'coordinates');
  if (coords) return parseCoordinates(coords.text);
  // Also check for gml:coordinates (with namespace in name)
  for (const c of node.children) {
    if (c.name === 'gml:coordinates' || c.name === 'coordinates') {
      return parseCoordinates(c.text);
    }
  }
  return [];
}

/** Read a single coordinate (for gml:Point). */
function readSingleCoord(node: XMLNode): number[] | null {
  const coords = readCoords(node);
  return coords.length > 0 ? coords[0] : null;
}

// ---------------------------------------------------------------------------
// GML Geometry Parsing
// ---------------------------------------------------------------------------

function parseGmlGeometry(node: XMLNode): Geometry | null {
  const tag = stripNS(node.name);

  switch (tag) {
    case 'Point': {
      const c = readSingleCoord(node);
      return c ? { type: 'Point', coordinates: c } : null;
    }
    case 'LineString': {
      const coords = readCoords(node);
      return coords.length >= 2 ? { type: 'LineString', coordinates: coords } : null;
    }
    case 'LinearRing': {
      const coords = readCoords(node);
      return coords.length >= 3 ? { type: 'LinearRing', coordinates: coords } : null;
    }
    case 'Polygon': {
      const rings: number[][][] = [];
      const exterior = findFirst(node, 'exterior');
      if (exterior) {
        const ring = findFirst(exterior, 'LinearRing');
        if (ring) {
          const coords = readCoords(ring);
          if (coords.length >= 3) rings.push(coords);
        }
      }
      for (const interior of findAll(node, 'interior')) {
        const ring = findFirst(interior, 'LinearRing');
        if (ring) {
          const coords = readCoords(ring);
          if (coords.length >= 3) rings.push(coords);
        }
      }
      return rings.length > 0 ? { type: 'Polygon', coordinates: rings } : null;
    }
    case 'MultiPoint': {
      const points: number[][] = [];
      for (const mp of findAll(node, 'Point')) {
        const c = readSingleCoord(mp);
        if (c) points.push(c);
      }
      // Also check gml:pointMember
      for (const pm of findAll(node, 'pointMember')) {
        const pt = findFirst(pm, 'Point');
        if (pt) {
          const c = readSingleCoord(pt);
          if (c) points.push(c);
        }
      }
      return points.length > 0 ? { type: 'MultiPoint', coordinates: points } : null;
    }
    case 'MultiLineString': {
      const lines: number[][][] = [];
      for (const ls of findAll(node, 'LineString')) {
        const coords = readCoords(ls);
        if (coords.length >= 2) lines.push(coords);
      }
      for (const lm of findAll(node, 'lineStringMember')) {
        const ls = findFirst(lm, 'LineString');
        if (ls) {
          const coords = readCoords(ls);
          if (coords.length >= 2) lines.push(coords);
        }
      }
      return lines.length > 0 ? { type: 'MultiLineString', coordinates: lines } : null;
    }
    case 'MultiPolygon': {
      const polys: number[][][][] = [];
      for (const pg of findAll(node, 'Polygon')) {
        const geom = parseGmlGeometry(pg);
        if (geom?.type === 'Polygon') polys.push(geom.coordinates as number[][][]);
      }
      for (const pm of findAll(node, 'polygonMember')) {
        const pg = findFirst(pm, 'Polygon');
        if (pg) {
          const geom = parseGmlGeometry(pg);
          if (geom?.type === 'Polygon') polys.push(geom.coordinates as number[][][]);
        }
      }
      return polys.length > 0 ? { type: 'MultiPolygon', coordinates: polys } : null;
    }
    case 'MultiSurface': {
      // GML 3 uses MultiSurface instead of MultiPolygon
      const polys: number[][][][] = [];
      for (const sf of findAll(node, 'surfaceMember')) {
        const pg = findFirst(sf, 'Polygon');
        if (pg) {
          const geom = parseGmlGeometry(pg);
          if (geom?.type === 'Polygon') polys.push(geom.coordinates as number[][][]);
        }
      }
      // Also direct Polygon children
      for (const pg of findAll(node, 'Polygon')) {
        const geom = parseGmlGeometry(pg);
        if (geom?.type === 'Polygon') polys.push(geom.coordinates as number[][][]);
      }
      if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
      return polys.length > 1 ? { type: 'MultiPolygon', coordinates: polys } : null;
    }
    case 'MultiCurve': {
      // GML 3 uses MultiCurve instead of MultiLineString
      const lines: number[][][] = [];
      for (const cm of findAll(node, 'curveMember')) {
        const ls = findFirst(cm, 'LineString');
        if (ls) {
          const coords = readCoords(ls);
          if (coords.length >= 2) lines.push(coords);
        }
      }
      for (const ls of findAll(node, 'LineString')) {
        const coords = readCoords(ls);
        if (coords.length >= 2) lines.push(coords);
      }
      if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
      return lines.length > 1 ? { type: 'MultiLineString', coordinates: lines } : null;
    }
    case 'GeometryCollection':
    case 'MultiGeometry': {
      const geoms: Geometry[] = [];
      for (const child of node.children) {
        const gTag = stripNS(child.name);
        if (['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString',
          'MultiPolygon', 'MultiSurface', 'MultiCurve', 'GeometryCollection'].includes(gTag)) {
          const g = parseGmlGeometry(child);
          if (g) geoms.push(g);
        }
      }
      return geoms.length > 0 ? { type: 'GeometryCollection', coordinates: geoms } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// GML Feature Parsing
// ---------------------------------------------------------------------------

function parseGmlFeature(member: XMLNode): Feature | null {
  // gml:featureMember contains a feature element (e.g., <gml:MyFeature>...</gml:MyFeature>)
  // The feature element's children are properties; geometry children are parsed as geometry.
  const featureElem = member.children.find((c) => {
    const tag = stripNS(c.name);
    return tag !== 'name' && tag !== 'description' && tag !== 'boundedBy';
  });
  if (!featureElem) return null;

  const props: Properties = {};
  let geometry: Geometry | null = null;

  // Extract feature name if present
  const nameNode = findFirst(featureElem, 'name');
  if (nameNode?.text?.trim()) props.name = nameNode.text.trim();

  const descNode = findFirst(featureElem, 'description');
  if (descNode?.text?.trim()) props.description = descNode.text.trim();

  for (const child of featureElem.children) {
    const tag = stripNS(child.name);

    // Skip known non-property elements
    if (['name', 'description', 'boundedBy', 'geometryProperty', 'geometry'].includes(tag)) {
      // Check if it's a geometry property
      if (tag === 'geometryProperty' || tag === 'geometry') {
        const gNode = child.children.find((c) => {
          const gTag = stripNS(c.name);
          return ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString',
            'MultiPolygon', 'MultiSurface', 'MultiCurve', 'GeometryCollection'].includes(gTag);
        });
        if (gNode) geometry = parseGmlGeometry(gNode);
      }
      continue;
    }

    // Check if child is a geometry element directly
    const gTags = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString',
      'MultiPolygon', 'MultiSurface', 'MultiCurve', 'GeometryCollection'];
    if (gTags.includes(tag)) {
      if (!geometry) geometry = parseGmlGeometry(child);
      continue;
    }

    // Property element — extract text value
    const text = child.text?.trim();
    if (text) {
      props[tag] = parseValue(text);
    } else {
      // Check for nested value elements
      const valNode = findFirst(child, 'value') || findFirst(child, 'Value');
      if (valNode?.text?.trim()) {
        props[tag] = parseValue(valNode.text.trim());
      }
    }
  }

  return { type: 'Feature', geometry, properties: props };
}

function parseValue(s: string): unknown {
  if (s === '' || s === 'null') return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return s;
}

// ---------------------------------------------------------------------------
// Parser Entry Point
// ---------------------------------------------------------------------------

export function parseGML(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const root = parseXML(text);

  // Find the root FeatureCollection or feature member
  let name: string | undefined;
  const fc = findFirst(root, 'FeatureCollection');
  const target = fc ?? root;

  // Try to get collection name
  const nameNode = findFirst(target, 'name');
  if (nameNode?.text?.trim()) name = nameNode.text.trim();

  const features: Feature[] = [];

  // Collect all featureMember and featureMembers
  for (const fm of findAll(target, 'featureMember')) {
    const f = parseGmlFeature(fm);
    if (f) features.push(f);
  }
  for (const fm of findAll(target, 'featureMembers')) {
    // featureMembers can contain multiple features directly
    for (const child of fm.children) {
      const f = parseGmlFeature({ name: 'featureMember', attrs: {}, children: [child], text: '' });
      if (f) features.push(f);
    }
  }

  // Fallback: if no featureMembers found, try parsing top-level geometry elements
  if (features.length === 0) {
    for (const tag of ['Point', 'LineString', 'Polygon', 'MultiPoint',
      'MultiLineString', 'MultiPolygon', 'MultiSurface', 'MultiCurve']) {
      for (const node of findAll(target, tag)) {
        const geom = parseGmlGeometry(node);
        if (geom) {
          features.push({ type: 'Feature', geometry: geom, properties: {} });
        }
      }
    }
  }

  return { name, features, meta: { source: 'gml' } };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export function writeGML(result: ParseResult, opts: WriteOptions = {}): string {
  const precision = opts.precision ?? 6;
  const docName = opts.name ?? result.name;
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2"');
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  lines.push('  xsi:schemaLocation="http://www.opengis.net/gml/3.2 http://schemas.opengis.net/gml/3.2.1/gml.xsd">');

  if (docName) {
    lines.push(`  <gml:name>${esc(docName)}</gml:name>`);
  }

  for (const f of result.features) {
    lines.push('  <gml:featureMember>');
    lines.push('    <gml:_feature>');
    if (f.properties) {
      for (const [k, v] of Object.entries(f.properties)) {
        if (v !== null && v !== undefined) {
          lines.push(`      <gml:${esc(k)}>${esc(String(v))}</gml:${esc(k)}>`);
        }
      }
    }
    if (f.geometry) {
      lines.push('      <gml:geometryProperty>');
      lines.push(formatGmlGeometry(f.geometry, '        ', precision));
      lines.push('      </gml:geometryProperty>');
    }
    lines.push('    </gml:_feature>');
    lines.push('  </gml:featureMember>');
  }

  lines.push('</gml:FeatureCollection>');
  return lines.join('\n');
}

function formatGmlGeometry(g: Geometry, indent: string, precision: number): string {
  const fmt = (n: number) => n.toFixed(precision);
  const fmtPos = (p: number[]) => p.map(fmt).join(' ');
  const fmtPosList = (coords: number[][]) => coords.map(fmtPos).join(' ');

  switch (g.type) {
    case 'Point':
      return `${indent}<gml:Point><gml:pos>${fmtPos(g.coordinates)}</gml:pos></gml:Point>`;
    case 'MultiPoint': {
      const inner = (g.coordinates as number[][])
        .map((c) => `${indent}  <gml:pointMember><gml:Point><gml:pos>${fmtPos(c)}</gml:pos></gml:Point></gml:pointMember>`)
        .join('\n');
      return `${indent}<gml:MultiPoint>\n${inner}\n${indent}</gml:MultiPoint>`;
    }
    case 'LineString':
      return `${indent}<gml:LineString><gml:posList>${fmtPosList(g.coordinates as number[][])}</gml:posList></gml:LineString>`;
    case 'MultiLineString': {
      const inner = (g.coordinates as number[][][])
        .map((line) => `${indent}  <gml:curveMember><gml:LineString><gml:posList>${fmtPosList(line)}</gml:posList></gml:LineString></gml:curveMember>`)
        .join('\n');
      return `${indent}<gml:MultiCurve>\n${inner}\n${indent}</gml:MultiCurve>`;
    }
    case 'Polygon': {
      const rings = g.coordinates as number[][][];
      const outer = rings[0];
      const holes = rings.slice(1);
      let s = `${indent}<gml:Polygon>`;
      s += `\n${indent}  <gml:exterior><gml:LinearRing><gml:posList>${fmtPosList(outer)}</gml:posList></gml:LinearRing></gml:exterior>`;
      for (const hole of holes) {
        s += `\n${indent}  <gml:interior><gml:LinearRing><gml:posList>${fmtPosList(hole)}</gml:posList></gml:LinearRing></gml:interior>`;
      }
      s += `\n${indent}</gml:Polygon>`;
      return s;
    }
    case 'MultiPolygon': {
      const inner = (g.coordinates as number[][][][])
        .map((poly) => {
          const polyNode = { type: 'Polygon', coordinates: poly } as Geometry;
          return `${indent}  <gml:surfaceMember>${formatGmlGeometry(polyNode, indent + '    ', precision)}</gml:surfaceMember>`;
        })
        .join('\n');
      return `${indent}<gml:MultiSurface>\n${inner}\n${indent}</gml:MultiSurface>`;
    }
    default:
      return `${indent}<!-- unsupported geometry: ${g.type} -->`;
  }
}
