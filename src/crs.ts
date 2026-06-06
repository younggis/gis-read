/**
 * Coordinate Reference System handling.
 *
 * Two categories of CRS are supported:
 *
 * 1. Standard, well-defined geographic / projected systems, transformed via
 *    proj4. These include WGS84 (EPSG:4326), Web Mercator (EPSG:3857),
 *    CGCS2000 (EPSG:4490, treated as WGS84 because the two datums are
 *    identical to within ~1 cm for civilian use), and arbitrary user-supplied
 *    EPSG / WKT codes.
 *
 * 2. Encrypted / obfuscated Chinese systems:
 *    - GCJ-02 (火星坐标系, "Mars Coordinates"): used by AutoNavi / Tencent
 *      maps in mainland China. Adds a non-linear offset to WGS84.
 *    - BD-09 (百度坐标系, "Baidu Coordinates"): used by Baidu Maps. Adds
 *      an additional offset on top of GCJ-02, plus an internal BD-09
 *      to/from GCJ-02 transform.
 *
 * Reference for GCJ-02 / BD-09 algorithms: China's "互联网地图服务" standard
 * (CGA 02-2014, also widely published as e.g. "eviltransform"). The
 * implementation here follows the canonical formulas.
 */
import proj4 from 'proj4';

// Register well-known projections with proj4.
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs +type=crs');
proj4.defs('EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs');
proj4.defs('EPSG:4490', '+proj=longlat +datum=CGCS2000 +no_defs +type=crs');
proj4.defs('EPSG:32650', '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs');

/** Built-in coordinate system identifiers. */
export type BuiltinCRS =
  | 'WGS84'
  | 'WebMercator' // EPSG:3857
  | 'CGCS2000'    // EPSG:4490 — same as WGS84 for civilian use
  | 'GCJ02'       // 火星坐标系
  | 'BD09';       // 百度坐标系

export interface CRSInfo {
  id: BuiltinCRS | string;
  name: string;
  /** True for the obfuscated Chinese systems that need a special transform. */
  encrypted: boolean;
  /** proj4 source definition, if applicable. */
  proj4?: string;
}

const KNOWN: Record<BuiltinCRS, CRSInfo> = {
  WGS84: { id: 'WGS84', name: 'WGS 84 (EPSG:4326)', encrypted: false, proj4: 'EPSG:4326' },
  WebMercator: { id: 'WebMercator', name: 'Web Mercator (EPSG:3857)', encrypted: false, proj4: 'EPSG:3857' },
  CGCS2000: { id: 'CGCS2000', name: 'CGCS2000 (EPSG:4490)', encrypted: false, proj4: 'EPSG:4490' },
  GCJ02: { id: 'GCJ02', name: 'GCJ-02 (火星坐标系)', encrypted: true },
  BD09: { id: 'BD09', name: 'BD-09 (百度坐标系)', encrypted: true },
};

/** Resolve a CRS by name. Built-ins or arbitrary proj4 codes (EPSG:xxxx). */
export function getCRS(id: string): CRSInfo {
  const norm = normalizeId(id);
  const builtin = KNOWN[norm as BuiltinCRS];
  if (builtin) return builtin;
  if (/^EPSG:\d+$/i.test(id) || /^EPSG:.+$/i.test(id)) {
    return { id, name: id, encrypted: false, proj4: id };
  }
  throw new Error(`Unknown CRS: ${id}`);
}

/** Normalize a CRS id like "wgs84" / "WGS 84" / "epsg:4326" to a canonical form. */
export function normalizeId(id: string): string {
  const lower = id.toLowerCase().replace(/[\s_-]/g, '');
  if (lower === 'wgs84' || lower === 'epsg4326' || lower === '4326') return 'WGS84';
  if (lower === 'webmercator' || lower === 'webmerca' || lower === 'epsg3857' || lower === '3857' || lower === 'psmercator') return 'WebMercator';
  if (lower === 'cgcs2000' || lower === 'epsg4490' || lower === '4490' || lower === '国家2000' || lower === '国家2000坐标系') return 'CGCS2000';
  if (lower === 'gcj02' || lower === 'gcj' || lower === '火星坐标系' || lower === '火星') return 'GCJ02';
  if (lower === 'bd09' || lower === 'bd' || lower === '百度坐标系' || lower === '百度') return 'BD09';
  return id;
}

// --- proj4-backed transforms (WGS84 <-> WebMercator <-> CGCS2000) --------

/** Transform a single coordinate between two CRSes (returns [x, y]). */
export function transformCoord(x: number, y: number, from: string, to: string): [number, number] {
  if (from === to) return [x, y];
  const a = normalizeId(from);
  const b = normalizeId(to);
  if (a === b) return [x, y];
  const aEnc = KNOWN[a as BuiltinCRS]?.encrypted;
  const bEnc = KNOWN[b as BuiltinCRS]?.encrypted;
  if (aEnc || bEnc) {
    // Encrypted systems go through WGS84 internally.
    return transformThroughWGS84(x, y, a, b);
  }
  const aDef = KNOWN[a as BuiltinCRS]?.proj4 ?? a;
  const bDef = KNOWN[b as BuiltinCRS]?.proj4 ?? b;
  return proj4(aDef, bDef, [x, y]) as [number, number];
}

/** Transform a coordinate through WGS84 (since encrypted systems are defined relative to WGS84). */
function transformThroughWGS84(x: number, y: number, from: string, to: string): [number, number] {
  // Step 1: from -> WGS84.
  let wgs: [number, number];
  const a = KNOWN[from as BuiltinCRS];
  if (from === 'WGS84' || from === 'CGCS2000') {
    wgs = [x, y];
  } else if (from === 'GCJ02') {
    wgs = gcj02ToWGS84(x, y);
  } else if (from === 'BD09') {
    wgs = bd09ToWGS84(x, y);
  } else if (a?.proj4) {
    wgs = proj4(a.proj4, 'EPSG:4326', [x, y]) as [number, number];
  } else {
    throw new Error(`Unknown source CRS: ${from}`);
  }
  // Step 2: WGS84 -> to.
  if (to === 'WGS84' || to === 'CGCS2000') return wgs;
  if (to === 'GCJ02') return wgs84ToGCJ02(wgs[0], wgs[1]);
  if (to === 'BD09') return wgs84ToBD09(wgs[0], wgs[1]);
  const bDef = KNOWN[to as BuiltinCRS]?.proj4 ?? to;
  return proj4('EPSG:4326', bDef, wgs) as [number, number];
}

// --- GCJ-02 (Mars) transform ---------------------------------------------

const GCJ_A = 6378245.0;            // Semi-major axis (Krassovsky 1940)
const GCJ_EE = 0.00669342162296594323; // Eccentricity squared

function outOfChina(lng: number, lat: number): boolean {
  // GCJ-02 is only defined for mainland China + a small buffer.
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84 -> GCJ-02. */
export function wgs84ToGCJ02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ-02 -> WGS84. Iterative to undo the encryption (the forward transform is non-linear). */
export function gcj02ToWGS84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  // Iterate: GCJ = F(WGS). We want WGS, so WGS_{n+1} = WGS_n - (F(WGS_n) - GCJ).
  let wgsLng = lng, wgsLat = lat;
  for (let i = 0; i < 5; i++) {
    const [gLng, gLat] = wgs84ToGCJ02(wgsLng, wgsLat);
    wgsLng += lng - gLng;
    wgsLat += lat - gLat;
  }
  return [wgsLng, wgsLat];
}

// --- BD-09 transform ----------------------------------------------------

const BD_X_PI = (Math.PI * 3000.0) / 180.0;

/** GCJ-02 -> BD-09. */
export function gcj02ToBD09(lng: number, lat: number): [number, number] {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * BD_X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * BD_X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

/** BD-09 -> GCJ-02. */
export function bd09ToGCJ02(lng: number, lat: number): [number, number] {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * BD_X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * BD_X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

/** WGS84 -> BD-09. */
export function wgs84ToBD09(lng: number, lat: number): [number, number] {
  const [gLng, gLat] = wgs84ToGCJ02(lng, lat);
  return gcj02ToBD09(gLng, gLat);
}

/** BD-09 -> WGS84. */
export function bd09ToWGS84(lng: number, lat: number): [number, number] {
  const [gLng, gLat] = bd09ToGCJ02(lng, lat);
  return gcj02ToWGS84(gLng, gLat);
}

// --- Recursive geometry transform ---------------------------------------

/** Transform a GeoJSON geometry between CRSes. */
export function transformGeometry(
  geom: { type: string; coordinates: any } | null,
  from: string,
  to: string,
): { type: string; coordinates: any } | null {
  if (!geom) return geom;
  if (from === to) return geom;
  const walk = (coords: any): any => {
    if (typeof coords[0] === 'number') {
      const [x, y] = transformCoord(coords[0], coords[1], from, to);
      return coords.length > 2 ? [x, y, ...coords.slice(2)] : [x, y];
    }
    return coords.map(walk);
  };
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

/** Transform a FeatureCollection's geometries in-place. */
export function transformFeatures(
  features: { geometry: any; properties: any; type: string; id?: any }[],
  from: string,
  to: string,
): void {
  for (const f of features) {
    f.geometry = transformGeometry(f.geometry, from, to);
  }
}
