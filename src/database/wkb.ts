import type { Geometry } from '../types.js';

const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;

export function encodeWKB(geometry: Geometry): Buffer {
  const writer = new WkbWriter();
  writeGeometry(writer, geometry);
  return writer.finish();
}

export function decodeWKB(input: Buffer | Uint8Array): Geometry {
  const reader = new WkbReader(Buffer.from(input));
  return reader.geometry();
}

function writeGeometry(writer: WkbWriter, geometry: Geometry): void {
  writer.byte(1);
  switch (geometry.type) {
    case 'Point':
      writer.uint32(WKB_POINT);
      writer.point(geometry.coordinates as number[]);
      return;
    case 'LineString':
      writer.uint32(WKB_LINESTRING);
      writer.points(geometry.coordinates as number[][]);
      return;
    case 'Polygon':
      writer.uint32(WKB_POLYGON);
      writer.rings(geometry.coordinates as number[][][]);
      return;
    case 'MultiPoint':
      writer.uint32(WKB_MULTIPOINT);
      writer.uint32((geometry.coordinates as number[][]).length);
      for (const point of geometry.coordinates as number[][]) writeGeometry(writer, { type: 'Point', coordinates: point });
      return;
    case 'MultiLineString':
      writer.uint32(WKB_MULTILINESTRING);
      writer.uint32((geometry.coordinates as number[][][]).length);
      for (const line of geometry.coordinates as number[][][]) writeGeometry(writer, { type: 'LineString', coordinates: line });
      return;
    case 'MultiPolygon':
      writer.uint32(WKB_MULTIPOLYGON);
      writer.uint32((geometry.coordinates as number[][][][]).length);
      for (const polygon of geometry.coordinates as number[][][][]) writeGeometry(writer, { type: 'Polygon', coordinates: polygon });
      return;
    default:
      throw new Error(`Unsupported WKB geometry type: ${geometry.type}`);
  }
}

class WkbWriter {
  private chunks: Buffer[] = [];

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }

  byte(value: number): void {
    this.chunks.push(Buffer.from([value]));
  }

  uint32(value: number): void {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(value, 0);
    this.chunks.push(buf);
  }

  double(value: number): void {
    const buf = Buffer.allocUnsafe(8);
    buf.writeDoubleLE(value, 0);
    this.chunks.push(buf);
  }

  point(point: number[]): void {
    this.double(point[0]);
    this.double(point[1]);
  }

  points(points: number[][]): void {
    this.uint32(points.length);
    for (const point of points) this.point(point);
  }

  rings(rings: number[][][]): void {
    this.uint32(rings.length);
    for (const ring of rings) this.points(ring);
  }
}

class WkbReader {
  private offset = 0;
  private littleEndian = true;

  constructor(private readonly buf: Buffer) {}

  geometry(): Geometry {
    const endian = this.byte();
    this.littleEndian = endian === 1;
    const type = this.uint32();
    if (type === WKB_POINT) return { type: 'Point', coordinates: this.point() };
    if (type === WKB_LINESTRING) return { type: 'LineString', coordinates: this.points() };
    if (type === WKB_POLYGON) return { type: 'Polygon', coordinates: this.rings() };
    if (type === WKB_MULTIPOINT) return { type: 'MultiPoint', coordinates: this.collection().map((g) => g.coordinates) };
    if (type === WKB_MULTILINESTRING) return { type: 'MultiLineString', coordinates: this.collection().map((g) => g.coordinates) };
    if (type === WKB_MULTIPOLYGON) return { type: 'MultiPolygon', coordinates: this.collection().map((g) => g.coordinates) };
    throw new Error(`Unsupported WKB geometry type: ${type}`);
  }

  private collection(): Geometry[] {
    const count = this.uint32();
    const geometries: Geometry[] = [];
    for (let i = 0; i < count; i++) geometries.push(this.geometry());
    return geometries;
  }

  private byte(): number {
    return this.buf[this.offset++];
  }

  private uint32(): number {
    const value = this.littleEndian ? this.buf.readUInt32LE(this.offset) : this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private double(): number {
    const value = this.littleEndian ? this.buf.readDoubleLE(this.offset) : this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  private point(): number[] {
    return [this.double(), this.double()];
  }

  private points(): number[][] {
    const count = this.uint32();
    const points: number[][] = [];
    for (let i = 0; i < count; i++) points.push(this.point());
    return points;
  }

  private rings(): number[][][] {
    const count = this.uint32();
    const rings: number[][][] = [];
    for (let i = 0; i < count; i++) rings.push(this.points());
    return rings;
  }
}

