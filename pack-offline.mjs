/**
 * Create a self-contained npm package for offline deployment.
 *
 * Database drivers (pg, mssql) are installed into node_modules inside the
 * package so the offline server needs no network access.
 *
 * Usage:
 *   node pack-offline.mjs
 *   # Creates gis-read-<version>-offline.tgz
 *   # Transfer to server and install: npm install -g gis-read-<version>-offline.tgz
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

// Remove ALL runtime dependencies — they're either bundled into the CJS files
// or copied as node_modules below.
offlinePkg.dependencies = {};
offlinePkg.devDependencies = {};
delete offlinePkg.peerDependencies;
delete offlinePkg.peerDependenciesMeta;

// Add exports for both ESM and CJS
offlinePkg.exports = {
  '.': {
    import: './dist/index.js',
    require: './dist/index.cjs',
    types: './dist/index.d.ts',
  },
};

// 4. Create staging directory with "package/" sub-directory.
//    npm install -g <tarball> expects the tarball root to contain a directory
//    named "package" that holds the package contents.
const stagingDir = path.join('.offline-staging');
const packageDir = path.join(stagingDir, 'package');
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true });
}
fs.mkdirSync(packageDir, { recursive: true });

// 5. Copy package contents into staging/package/
console.log('Copying package files to staging...');
for (const file of ['dist', 'README.md', 'read.md', '操作手册.md', 'LICENSE']) {
  const src = path.join('.', file);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(packageDir, file);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Write offline package.json into staging/package/
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(offlinePkg, null, 2));

// 6. Install database drivers (pg, mssql) into staging/package/node_modules
//    so they ship inside the tarball — no network needed on the server.
const dbDrivers = Object.entries(pkg.dependencies ?? {})
  .filter(([name]) => name === 'pg' || name === 'mssql')
  .map(([name, ver]) => `${name}@${ver}`);

if (dbDrivers.length > 0) {
  console.log(`Installing database drivers into staging: ${dbDrivers.join(', ')}`);
  execSync(`npm install --omit=dev ${dbDrivers.join(' ')}`, {
    cwd: packageDir,
    stdio: 'inherit',
  });
}

// 6b. Add bundleDependencies to package.json so npm knows these packages
//     are already bundled in the tarball and should NOT be fetched from registry.
const nmDir = path.join(packageDir, 'node_modules');
if (fs.existsSync(nmDir)) {
  const bundled = fs.readdirSync(nmDir).filter(name => !name.startsWith('.'));
  offlinePkg.bundleDependencies = bundled;
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(offlinePkg, null, 2));
  console.log(`Bundled dependencies (${bundled.length}): ${bundled.join(', ')}`);
}

// 7. Pack manually — npm pack strips node_modules, so we use tar directly.
console.log('Creating offline package...');
const version = pkg.version;
const offlineTarball = `gis-read-${version}-offline.tgz`;

// tar -czf creates a .tgz from the staging directory.
// The archive contains "package/" at the root, which npm expects.
execSync(`tar -czf "${offlineTarball}" -C "${stagingDir}" package`, {
  stdio: 'inherit',
});

console.log(`\nOffline package created: ${offlineTarball}`);
console.log(`  Includes database drivers: ${dbDrivers.join(', ') || '(none)'}`);
console.log(`\nTo deploy on offline server:`);
console.log(`  1. Copy ${offlineTarball} to the server`);
console.log(`  2. npm install -g ${offlineTarball}`);
console.log(`  3. gis --help`);

// 8. Clean up staging
fs.rmSync(stagingDir, { recursive: true });
