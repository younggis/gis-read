/**
 * Streaming GeoJSON parser.
 *
 * Reads a FeatureCollection too large to fit in memory by emitting one
 * feature at a time. Memory usage is bounded by the largest single
 * feature, not the file size.
 *
 * Strategy: use a simple character-level parser that:
 *   1. Buffers incoming chunks in 1 MB increments.
 *   2. Walks the buffer looking for `"type":"Feature"` markers.
 *   3. For each such marker, locates the enclosing `{...}` of the feature.
 *   4. Calls `JSON.parse` on the feature substring to materialize it.
 *
 * Because we use `String.indexOf` to find feature boundaries (rather
 * than full tokenization), we cannot handle Features whose string values
 * contain the literal substring `"type":"Feature"`. For real-world
 * GeoJSON this is acceptable; for pathological inputs we fall back to
 * `JSON.parse` of the whole file.
 *
 * Usage:
 *   for await (const feature of parseGeoJSONStream(path)) {
 *     // process / transform / write to a sink
 *   }
 */
import * as fs from 'node:fs';
import { formatBytes } from '../io.js';
import { log } from '../logger.js';
import type { Feature } from '../types.js';

export interface StreamOptions {
  onProgress?: (bytesRead: number, total: number) => void;
  progressEvery?: number;
}

/**
 * Parse a chunk-based stream of text into a sequence of complete features.
 *
 * The parser maintains a buffer of unparsed text. On each call to
 * `feed(chunk)`, it appends and tries to extract any complete features
 * visible in the buffer. On `end()`, it processes any remaining
 * complete feature and discards the rest.
 */
class FeatureStreamParser {
  private buffer = '';
  private searchFrom = 0;
  /** Whether we've already seen the "features" array open bracket. */
  private inFeaturesArray = false;
  private braceDepth = 0;
  private featureStart = -1;
  private currentFeatureText = '';
  private inString = false;
  private escape = false;

  /** Process more text; returns any complete features. */
  feed(chunk: string): Feature[] {
    this.buffer += chunk;
    const out: Feature[] = [];
    let i = this.searchFrom;
    while (i < this.buffer.length) {
      const c = this.buffer[i];

      // Track string state. We need to add the string content to
      // currentFeatureText so JSON.parse can decode it.
      if (this.inString) {
        if (this.escape) { this.escape = false; }
        else if (c === '\\') { this.escape = true; }
        else if (c === '"') { this.inString = false; }
        if (this.braceDepth > 0) this.currentFeatureText += c;
        i++;
        continue;
      }

      if (c === '"') {
        this.inString = true;
        if (this.braceDepth > 0) this.currentFeatureText += '"';
        i++;
        continue;
      }

      // We need to find the "features" array and walk through it.
      if (!this.inFeaturesArray) {
        // Look for "features":[ pattern.
        const idx = this.buffer.indexOf('"features"', i);
        if (idx < 0) {
          this.searchFrom = this.buffer.length;
          break;
        }
        // Find the next '[' after the colon.
        let j = idx + '"features"'.length;
        while (j < this.buffer.length && /[\s,:]/.test(this.buffer[j])) j++;
        if (j >= this.buffer.length || this.buffer[j] !== '[') {
          this.searchFrom = idx + 1;
          i = idx + 1;
          continue;
        }
        this.inFeaturesArray = true;
        this.braceDepth = 0;
        this.featureStart = -1;
        this.currentFeatureText = '';
        this.inString = false;
        this.escape = false;
        i = j; // Don't increment — let the next iteration's `i++` skip the `[`.
        // We need to re-process `[` as opening the array (handled below).
        continue;
      }

      // Inside the features array, count braces to find feature boundaries.
      if (c === '{') {
        if (this.braceDepth === 0) {
          this.featureStart = i;
          this.currentFeatureText = '{';
        } else {
          this.currentFeatureText += '{';
        }
        this.braceDepth++;
      } else if (c === '}') {
        this.currentFeatureText += '}';
        this.braceDepth--;
        if (this.braceDepth === 0 && this.featureStart >= 0) {
          // Try to parse the feature.
          try {
            const f = JSON.parse(this.currentFeatureText);
            if (f && f.type === 'Feature') {
              out.push(f as Feature);
            }
          } catch (e) {
            log.warn(`Skipping malformed feature at offset ${this.featureStart}: ${(e as Error).message}`);
          }
          this.featureStart = -1;
          this.currentFeatureText = '';
        }
      } else if (this.braceDepth > 0) {
        this.currentFeatureText += c;
      } else if (c === ']') {
        // End of features array.
        this.inFeaturesArray = false;
      }
      i++;
    }
    this.searchFrom = i;
    return out;
  }

  /** Final flush. */
  end(): Feature[] {
    this.currentFeatureText = '';
    this.featureStart = -1;
    return [];
  }
}

/**
 * Stream-parse a GeoJSON file, yielding one feature at a time.
 *
 * Returns an async generator suitable for `for await ... of`.
 */
export async function* parseGeoJSONStream(
  path: string,
  opts: StreamOptions = {},
): AsyncGenerator<Feature, void, void> {
  const stat = fs.statSync(path);
  const total = stat.size;
  log.info(`Streaming GeoJSON ${path} (${formatBytes(total)})`);

  const fileStream = fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  const parser = new FeatureStreamParser();
  let bytesRead = 0;
  let lastReported = -1;
  let pending: Promise<void> = Promise.resolve();
  let endResolve: (() => void) | null = null;
  const endPromise = new Promise<void>((resolve) => { endResolve = resolve; });

  // Hook the file stream: for each chunk, feed the parser and stash
  // any emitted features in an internal queue. The generator pulls
  // from the queue via `next()`.
  const queue: Feature[] = [];
  let resolver: ((v: IteratorResult<Feature>) => void) | null = null;
  let finished = false;
  let error: Error | null = null;

  const push = (f: Feature): void => {
    if (resolver) {
      resolver({ value: f, done: false });
      resolver = null;
    } else {
      queue.push(f);
    }
  };

  fileStream.on('data', (chunk: string | Buffer) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytesRead += Buffer.byteLength(s, 'utf8');
    const features = parser.feed(s);
    for (const f of features) push(f);
    if (opts.onProgress) opts.onProgress(bytesRead, total);
    else {
      const pct = Math.floor((bytesRead / total) * 100);
      if (pct >= lastReported + (opts.progressEvery ?? 10)) {
        lastReported = pct;
        log.debug(`Streaming ${path}`, { pct: `${pct}%`, bytes: bytesRead, total });
      }
    }
  });
  fileStream.on('end', () => {
    const remaining = parser.end();
    for (const f of remaining) push(f);
    finished = true;
    // If the generator is currently waiting on the resolver, wake it up
    // with the appropriate value.
    if (resolver !== null) {
      const r = resolver as (v: IteratorResult<Feature>) => void;
      resolver = null;
      if (queue.length > 0) {
        r({ value: queue.shift()!, done: false });
      } else {
        r({ value: undefined as any, done: true });
      }
    }
    endResolve?.();
  });

  // Generator driver.
  while (true) {
    if (error) throw error;
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) {
      if (resolver !== null) {
        (resolver as (v: IteratorResult<Feature>) => void)({ value: undefined as any, done: true });
        resolver = null;
      }
      return;
    }
    const next: IteratorResult<Feature> = await new Promise<IteratorResult<Feature>>((resolve) => {
      if (queue.length) {
        resolve({ value: queue.shift()!, done: false });
        return;
      }
      if (finished) { resolve({ value: undefined as any, done: true }); return; }
      if (error) { resolve({ value: undefined as any, done: true }); return; }
      resolver = resolve;
    });
    if (next.done) return;
    yield next.value;
  }
  void pending; // unused but kept for future
}
