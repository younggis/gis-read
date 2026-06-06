/**
 * Tests for large-file streaming, logger, and error boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Logger, log } from '../src/logger.js';
import { withErrorBoundary, formatBytes, formatDuration, streamTextLines } from '../src/io.js';
import { parseGeoJSONStream, parseGeoJSONAuto } from '../src/parsers/geojson.js';

function tmpFile(name: string, content: string | Buffer): string {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content);
  return p;
}

test('Logger formats lines with timestamp and level', () => {
  const lines: string[] = [];
  const logger = new Logger('test');
  // Capture stderr directly.
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { lines.push(s); return true; };
  try {
    logger.setLevel('debug');
    logger.info('hello', { x: 1 });
    logger.error('eek', { code: 42 });
  } finally {
    (process.stderr as any).write = origWrite;
  }
  // 2 lines emitted.
  assert.equal(lines.length, 2);
  assert.match(lines[0], /INFO.*\[test\] hello/);
  assert.match(lines[0], /x=1/);
  assert.match(lines[1], /ERROR.*\[test\] eek/);
  assert.match(lines[1], /code=42/);
});

test('Logger respects level filter', () => {
  const logger = new Logger('test');
  const lines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { lines.push(s); return true; };
  try {
    logger.setLevel('warn');
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');
  } finally {
    (process.stderr as any).write = origWrite;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /WARN/);
  assert.match(lines[1], /ERROR/);
});

test('Logger startTimer logs elapsed_ms', async () => {
  const logger = new Logger('test');
  const lines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { lines.push(s); return true; };
  try {
    logger.setLevel('info');
    const done = logger.startTimer('op');
    await new Promise((r) => setTimeout(r, 30));
    done('finished');
  } finally {
    (process.stderr as any).write = origWrite;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /finished/);
  assert.match(lines[0], /elapsed_ms=\d+/);
});

test('withErrorBoundary returns 0 on success', async () => {
  // Suppress logger output during this test.
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  try {
    const code = await withErrorBoundary('test', async () => {});
    assert.equal(code, 0);
  } finally {
    (process.stderr as any).write = orig;
  }
});

test('withErrorBoundary returns 1 on throw + logs', async () => {
  const lines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { lines.push(s); return true; };
  let code: number;
  try {
    code = await withErrorBoundary('test', () => {
      throw new Error('boom');
    });
  } finally {
    (process.stderr as any).write = origWrite;
  }
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /test failed/);
  assert.match(lines[0], /boom/);
});

test('formatBytes / formatDuration produce sensible strings', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
  assert.match(formatDuration(500), /ms/);
  assert.match(formatDuration(5000), /s/);
  assert.match(formatDuration(120000), /m/);
  assert.match(formatDuration(7200000), /h/);
});

// --- Streaming GeoJSON -----------------------------------------------------

test('parseGeoJSONStream yields features from a small file', async () => {
  const content = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature', properties: { n: 2 }, geometry: { type: 'Point', coordinates: [1, 1] } },
      { type: 'Feature', properties: { n: 3 }, geometry: { type: 'Point', coordinates: [2, 2] } },
    ],
  });
  const p = tmpFile('stream-test-1.geojson', content);
  const out: any[] = [];
  for await (const f of parseGeoJSONStream(p)) out.push(f);
  assert.equal(out.length, 3);
  assert.equal(out[0].properties.n, 1);
  assert.equal(out[2].geometry.coordinates[0], 2);
  fs.unlinkSync(p);
});

test('parseGeoJSONStream handles polygons with coordinates arrays', async () => {
  const content = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'poly' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        },
      },
    ],
  });
  const p = tmpFile('stream-test-2.geojson', content);
  const out: any[] = [];
  for await (const f of parseGeoJSONStream(p)) out.push(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].geometry.type, 'Polygon');
  assert.equal(out[0].geometry.coordinates[0].length, 5);
  fs.unlinkSync(p);
});

test('parseGeoJSONStream handles features with id and non-ASCII names', async () => {
  const content = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'foo-1', properties: { name: '北京' }, geometry: { type: 'Point', coordinates: [116, 39] } },
      { type: 'Feature', id: 42, properties: { name: '上海' }, geometry: { type: 'Point', coordinates: [121, 31] } },
    ],
  });
  const p = tmpFile('stream-test-3.geojson', content);
  const out: any[] = [];
  for await (const f of parseGeoJSONStream(p)) out.push(f);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'foo-1');
  assert.equal(out[0].properties.name, '北京');
  assert.equal(out[1].id, 42);
  fs.unlinkSync(p);
});

test('parseGeoJSONStream handles MultiPolygon and nested coordinates', async () => {
  const content = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]],
        },
      },
    ],
  });
  const p = tmpFile('stream-test-4.geojson', content);
  const out: any[] = [];
  for await (const f of parseGeoJSONStream(p)) out.push(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].geometry.type, 'MultiPolygon');
  assert.equal(out[0].geometry.coordinates.length, 2);
  fs.unlinkSync(p);
});

test('parseGeoJSONAuto uses in-memory path for small files', async () => {
  const content = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
  });
  const p = tmpFile('auto-test-1.geojson', content);
  const r = await parseGeoJSONAuto(p);
  assert.equal(r.features.length, 1);
  assert.equal(r.meta?.streaming, undefined);
  fs.unlinkSync(p);
});

test('parseGeoJSONStream handles large line count without OOM', async () => {
  // Generate a synthetic ~500 KB GeoJSON with 2k features (fast enough for tests).
  const features: string[] = [];
  features.push('"type":"FeatureCollection","features":[');
  for (let i = 0; i < 2_000; i++) {
    if (i > 0) features.push(',');
    features.push(JSON.stringify({
      type: 'Feature',
      properties: { n: i, name: `feature-${i}` },
      geometry: { type: 'Point', coordinates: [i * 0.0001, i * 0.0001] },
    }));
  }
  features.push(']}');
  const p = tmpFile('stream-large.geojson', '{' + features.join('') + '}');
  const stat = fs.statSync(p);
  let count = 0;
  for await (const f of parseGeoJSONStream(p)) {
    count++;
    if (count === 1) {
      assert.equal(f.type, 'Feature');
      assert.equal(f.properties.n, 0);
    }
    if (count === 2_000) {
      assert.equal(f.properties.n, 1999);
    }
  }
  assert.equal(count, 2_000);
  // Sanity: file should be reasonably large.
  assert.ok(stat.size > 100_000, `expected > 100 KB, got ${stat.size}`);
  fs.unlinkSync(p);
});

test('streamTextLines reads a file line by line', async () => {
  const p = tmpFile('lines-test.txt', 'a\nb\nc\nd\n');
  const lines: string[] = [];
  const result = await streamTextLines(p, (line) => { lines.push(line); });
  assert.deepEqual(lines, ['a', 'b', 'c', 'd']);
  assert.equal(result.lines, 4);
  fs.unlinkSync(p);
});
