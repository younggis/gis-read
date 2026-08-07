# Errors

Command failures and integration errors.

---

## [ERR-20260706-004] npm-run-dev

**Logged**: 2026-07-06T16:42:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary
The ts-node development command cannot resolve explicit .js imports under the current Node 24 ESM runtime.

### Error
```
Cannot find module 'src/parsers/index.js' imported from src/cli.ts
```

### Context
- `npm run dev` uses `ts-node src/cli.ts`.
- The project source intentionally uses explicit `.js` local import extensions.

### Suggested Fix
Use the compiled CLI for release verification; assess switching the dev script to `tsx` separately.

### Metadata
- Reproducible: yes
- Related Files: package.json, src/cli.ts

### Resolution
- **Resolved**: 2026-07-06T16:42:00+08:00
- **Notes**: Switched the verification path to `npm run build` followed by `node dist/cli.js`.

---

## [ERR-20260706-003] npm-test

**Logged**: 2026-07-06T16:41:00+08:00
**Priority**: medium
**Status**: pending
**Area**: tests

### Summary
The full test suite is blocked by a pre-existing TypeScript syntax error in cli.test.ts.

### Error
```
test/cli.test.ts:562:0: ERROR: Unexpected "}"
```

### Context
- Type checking passed.
- All TAB writer tests passed, including the new MultiLineString preservation assertion.
- The failing file was not modified by this TAB writer change.

### Suggested Fix
Repair the unmatched brace in test/cli.test.ts separately, then rerun the full suite.

### Metadata
- Reproducible: yes
- Related Files: test/cli.test.ts

---

## [ERR-20260706-002] apply_patch

**Logged**: 2026-07-06T16:38:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
A large patch did not match a source comment containing mojibake characters.

### Error
```
Failed to find expected lines in src/parsers/tab-writer.ts
```

### Context
- The functional code was unchanged.
- The failed context included a corrupted punctuation sequence in the file header.

### Suggested Fix
Split the edit into smaller patches anchored on stable ASCII function bodies.

### Metadata
- Reproducible: yes
- Related Files: src/parsers/tab-writer.ts

### Resolution
- **Resolved**: 2026-07-06T16:38:00+08:00
- **Notes**: Continued with narrow, stable-context patches.

---

## [ERR-20260706-001] Invoke-WebRequest

**Logged**: 2026-07-06T16:30:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
PowerShell failed to download GDAL MITAB source from raw.githubusercontent.com.

### Error
```
The underlying connection was closed while sending the request.
```

### Context
- Attempted to fetch official GDAL MITAB source for TAB binary-format reference.
- Local QGIS 3.44.8 includes GDAL tools that can generate interoperable reference files.

### Suggested Fix
Use locally installed GDAL output as the format oracle when GitHub raw downloads are unavailable.

### Metadata
- Reproducible: unknown
- Related Files: src/parsers/tab-writer.ts

### Resolution
- **Resolved**: 2026-07-06T16:30:00+08:00
- **Notes**: Switched to local GDAL-generated TAB reference bundles.

---
