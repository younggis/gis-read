# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript GIS parser/converter CLI. Source code lives in `src/`: `cli.ts` defines the `gis` command, shared types and utilities are in `types.ts`, `io.ts`, `crs.ts`, `encoding.ts`, and format detection is in `format-detect.ts`. Format implementations live under `src/parsers/`, with one parser per GIS format plus `index.ts` as the parser facade. Tests live in `test/`; sample datasets used by tests and manual CLI checks live in `data/`. Build output is written to `dist/` and should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install runtime and development dependencies.
- `npm run dev -- <command>`: run the CLI from TypeScript via `ts-node`, for example `npm run dev -- detect data/lakes.geojson`.
- `npm run build`: compile TypeScript to `dist/` with declarations and source maps.
- `npm start -- <command>`: run the built CLI from `dist/cli.js`.
- `npm test`: run all `test/*.test.ts` files with Node's built-in test runner and `tsx`.
- `npm run lint`: run `tsc --noEmit` for type-checking without generating files.

## Coding Style & Naming Conventions

Use ES modules and explicit `.js` extensions in local imports, matching the existing TypeScript setup. Keep strict typing: avoid implicit `any`, prefer exported interfaces from `src/types.ts`, and keep parser return values normalized to `ParseResult`. Use two-space indentation, single quotes, semicolons, and descriptive camelCase names for functions and variables. Parser files should be named after their format, such as `geojson.ts` or `shapefile.ts`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Add tests under `test/` with the `*.test.ts` suffix. Parser tests should cover format detection, feature counts, representative geometry types, metadata/CRS handling, and round-trip writers when available. Reuse `data/` fixtures when possible; if new fixtures are large, document why they are needed.

## Commit & Pull Request Guidelines

No repository-specific git history is available in this checkout. Use concise, imperative commit subjects such as `Add GPX parser tests` or `Fix KML coordinate parsing`. Pull requests should describe the changed formats or CLI behavior, list validation commands run (`npm test`, `npm run lint`, `npm run build`), and include sample CLI input/output when user-visible behavior changes.

## Security & Configuration Tips

Do not commit generated `dist/`, logs, `.env`, or `output/` files. Treat GIS inputs as untrusted: validate file formats, keep error messages actionable, and avoid loading very large files into memory when a streaming path exists.
