/**
 * Create a self-contained npm package for offline deployment.
 *
 * Usage:
 *   node pack-offline.mjs
 *   # Creates gis-read-1.0.8-offline.tgz
 *   # Transfer to server and install: npm install -g gis-read-1.0.8-offline.tgz
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// 1. Build TypeScript
console.log('Building TypeScript...');
execSync('npm run build', { stdio: 'inherit' });

// 2. Bundle with esbuild
console.log('Bundling dependencies...');
execSync('node build-bundle.mjs', { stdio: 'inherit' });

// 3. Prepare package.json for offline package
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const offlinePkg = { ...pkg };

// Point to bundled CJS files
offlinePkg.main = 'dist/index.cjs';
offlinePkg.types = 'dist/index.d.ts';
offlinePkg.bin = { gis: 'dist/cli.cjs' };

// Remove runtime dependencies (they're bundled)
// Keep mssql/pg as optional peer dependencies
offlinePkg.dependencies = {
  'mssql': '^11.0.1',
  'pg': '^8.13.1',
};
offlinePkg.peerDependencies = {
  'mssql': '^11.0.1',
  'pg': '^8.13.1',
};
offlinePkg.peerDependenciesMeta = {
  'mssql': { optional: true },
  'pg': { optional: true },
};

// Add exports for both ESM and CJS
offlinePkg.exports = {
  '.': {
    import: './dist/index.js',
    require: './dist/index.cjs',
    types: './dist/index.d.ts',
  },
};

// 4. Write temporary package.json
const origPkg = fs.readFileSync('package.json', 'utf8');
fs.writeFileSync('package.json', JSON.stringify(offlinePkg, null, 2));

try {
  // 5. Pack
  console.log('Creating offline package...');
  execSync('npm pack', { stdio: 'inherit' });

  const tarball = `gis-read-${pkg.version}.tgz`;
  const offlineTarball = `gis-read-${pkg.version}-offline.tgz`;
  if (fs.existsSync(tarball)) {
    fs.renameSync(tarball, offlineTarball);
    console.log(`\nOffline package created: ${offlineTarball}`);
    console.log(`\nTo deploy on offline server:`);
    console.log(`  1. Copy ${offlineTarball} to the server`);
    console.log(`  2. npm install -g ${offlineTarball}`);
    console.log(`  3. gis --help`);
  }
} finally {
  // Restore original package.json
  fs.writeFileSync('package.json', origPkg);
}
