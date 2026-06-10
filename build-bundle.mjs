/**
 * Bundle all pure-JS dependencies into dist/ for offline deployment.
 * mssql/pg are excluded (optional database features).
 * sql.js WASM file is copied separately.
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const external = [
  // Database drivers — optional, only for db-import/export
  'mssql',
  'pg',
  // Node.js built-in modules (must be external for ESM bundle)
  'node:events', 'node:path', 'node:fs', 'node:os', 'node:url', 'node:util',
  'node:crypto', 'node:stream', 'node:buffer', 'node:http', 'node:https',
  'node:net', 'node:tls', 'node:child_process', 'node:worker_threads',
  'node:assert', 'node:zlib', 'node:string_decoder', 'node:process',
  'node:module', 'node:perf_hooks', 'node:diagnostics_channel',
  'node:querystring', 'node:dns',
];

// Node.js built-in modules that should not be bundled
const builtins = [
  'node:events', 'node:path', 'node:fs', 'node:os', 'node:url', 'node:util',
  'node:crypto', 'node:stream', 'node:buffer', 'node:http', 'node:https',
  'node:net', 'node:tls', 'node:child_process', 'node:worker_threads',
  'node:assert', 'node:zlib', 'node:string_decoder', 'node:process',
  'node:module', 'node:perf_hooks', 'node:diagnostics_channel',
  'node:worker_threads', 'node:querystring', 'node:dns',
  // Also bare names (some packages use require('events') etc.)
  'events', 'path', 'fs', 'os', 'url', 'util', 'crypto',
  'stream', 'buffer', 'http', 'https', 'net', 'tls', 'child_process',
  'worker_threads', 'assert', 'zlib', 'string_decoder', 'process', 'module',
];

// Bundle CLI
await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/cli.cjs',
  external,
  sourcemap: true,
  minify: false,
});

// Bundle library entry
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  external,
  sourcemap: true,
  minify: false,
  // Mark sql.js WASM as external asset (loaded at runtime)
  loader: { '.wasm': 'file' },
});

// Copy sql.js WASM file to dist/
const sqlJsWasm = path.join('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
if (fs.existsSync(sqlJsWasm)) {
  fs.copyFileSync(sqlJsWasm, path.join('dist', 'sql-wasm.wasm'));
  console.log('Copied sql-wasm.wasm to dist/');
}

console.log('Bundle complete. dist/ is self-contained (except mssql/pg for database features).');
