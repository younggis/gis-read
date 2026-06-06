/**
 * GPX (GPS Exchange Format) parser and writer.
 *
 * GPX is XML-based and stores waypoints, tracks, and routes. We map them to
 * GeoJSON features: waypoints become Point features, tracks become
 * LineString (or MultiLineString for multi-segment tracks), and routes
 * become LineString features. Elevation is preserved in the third coordinate.
 */
import * as fs from 'node:fs';
import type { Feature, Geometry, ParseResult, Properties, WriteOptions } from '../types.js';

export function parseGPX(input: string | Buffer): ParseResult {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const root = parseXML(text);
  const features: Feature[] = [];

  // Optional <metadata><name>.
  let name: string | undefined;
  const meta = findFirst(root, 'metadata');
  if (meta) {
    const n = findFirst(meta, 'name');
    if (n) name = n.text.trim() || undefined;
  }

  for (const wpt of findAll(root, 'wpt')) features.push(gpxPoint(wpt, 'wpt'));
  for (const trk of findAll(root, 'trk')) {
    const trkName = childText(findFirst(trk, 'name')) ?? '';
    for (const seg of findAll(trk, 'trkseg')) {
      const pts = findAll(seg, 'trkpt').map((p) => readPoint(p));
      if (pts.length === 0) continue;
      const props: Properties = { name: trkName, kind: 'track' };
      features.push({
        type: 'Feature',
        geometry: pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'LineString', coordinates: pts },
        properties: props,
      });
    }
  }
  for (const rte of findAll(root, 'rte')) {
    const rteName = childText(findFirst(rte, 'name')) ?? '';
    const pts = findAll(rte, 'rtept').map((p) => readPoint(p));
    if (pts.length === 0) continue;
    const props: Properties = { name: rteName, kind: 'route' };
    features.push({
      type: 'Feature',
      geometry: pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'LineString', coordinates: pts },
      properties: props,
    });
  }

  return { name, features, meta: { source: 'gpx' } };
}

function gpxPoint(node: XMLNode, kind: string): Feature {
  const pos = readPoint(node);
  const props: Properties = { name: childText(findFirst(node, 'name')) ?? '', kind };
  const ele = childText(findFirst(node, 'ele'));
  if (ele) props.ele = Number(ele);
  const time = childText(findFirst(node, 'time'));
  if (time) props.time = time;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: pos }, properties: props };
}

function readPoint(node: XMLNode): number[] {
  const lat = Number(node.attrs.lat);
  const lng = Number(node.attrs.lon);
  const out: number[] = [lng, lat];
  const ele = childText(findFirst(node, 'ele'));
  if (ele) out.push(Number(ele));
  return out;
}

function childText(node: XMLNode | null): string | undefined {
  if (!node) return undefined;
  const t = node.text.trim();
  return t.length > 0 ? t : undefined;
}

// --- Writer -------------------------------------------------------------

export function writeGPX(result: ParseResult, opts: WriteOptions = {}): string {
  const precision = opts.precision ?? 6;
  const fmt = (n: number) => n.toFixed(precision);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="gis-read" xmlns="http://www.topografix.com/GPX/1/1">');

  for (const f of result.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === 'Point') {
      const c = f.geometry.coordinates as number[];
      lines.push(`  <wpt lat="${fmt(c[1])}" lon="${fmt(c[0])}">`);
      lines.push(`    <name>${esc((f.properties?.name as string) ?? '')}</name>`);
      if (c.length > 2) lines.push(`    <ele>${fmt(c[2])}</ele>`);
      lines.push('  </wpt>');
    } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
      lines.push('  <trk>');
      const name = (f.properties?.name as string) ?? '';
      if (name) lines.push(`    <name>${esc(name)}</name>`);
      const linesList: number[][][] = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const seg of linesList) {
        lines.push('    <trkseg>');
        for (const c of seg) {
          lines.push(`      <trkpt lat="${fmt(c[1])}" lon="${fmt(c[0])}">`);
          if (c.length > 2) lines.push(`        <ele>${fmt(c[2])}</ele>`);
          lines.push('      </trkpt>');
        }
        lines.push('    </trkseg>');
      }
      lines.push('  </trk>');
    }
  }
  lines.push('</gpx>');
  return lines.join('\n');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function convertGPX(inputPath: string, outputPath?: string, opts: WriteOptions = {}): ParseResult {
  const result = parseGPX(fs.readFileSync(inputPath));
  if (outputPath) fs.writeFileSync(outputPath, writeGPX(result, opts), 'utf8');
  return result;
}

// --- Local XML reader (re-uses pattern from KML reader) ------------------

interface XMLNode {
  name: string;
  attrs: Record<string, string>;
  children: XMLNode[];
  text: string;
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

function collect(n: XMLNode, name: string, out: XMLNode[]): void {
  if (n.name === name) out.push(n);
  for (const c of n.children) collect(c, name, out);
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
      if (tail.trim()) top().text += tail;
      break;
    }
    if (lt > i) {
      top().text += text.slice(i, lt);
      i = lt;
    }
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); if (e < 0) break; i = e + 3; continue; }
    if (text.startsWith('<![CDATA[', i)) { const e = text.indexOf(']]>', i + 9); if (e < 0) break; top().text += text.slice(i + 9, e); i = e + 3; continue; }
    if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i + 2); if (e < 0) break; i = e + 2; continue; }
    if (text.startsWith('<!', i)) { const e = text.indexOf('>', i + 2); if (e < 0) break; i = e + 1; continue; }
    if (text[i + 1] === '/') {
      const e = text.indexOf('>', i + 2);
      if (e < 0) break;
      if (stack.length > 1) stack.pop();
      i = e + 1;
      continue;
    }
    const e = text.indexOf('>', i);
    if (e < 0) break;
    const raw = text.slice(i + 1, e);
    i = e + 1;
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = body.match(/^([\w:.-]+)([\s\S]*)$/);
    if (!m) continue;
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2]))) attrs[am[1]] = am[2];
    const node: XMLNode = { name: m[1], attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
