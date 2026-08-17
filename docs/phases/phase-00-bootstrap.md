# Phase 0 — Repository bootstrap and toolchain

**Goal:** an empty but production-shaped extension that compiles, lints, bundles, runs
in the Extension Development Host, and is checked by CI.

**Depends on:** nothing.

## Steps

### 0.1 Scaffold the extension into the existing repository ✅
- Generate a standard `yo code` TypeScript extension **in place**, keeping `plan.md`,
  `README.md` and `docs/` untouched.
- Resulting root files: `package.json`, `tsconfig.json`, `.vscodeignore`, `.gitignore`,
  `eslint.config.mjs`, `src/extension.ts`.
- `package.json` identity fields are filled properly in phase 1; here only what is
  needed to compile.

### 0.2 Pin the platform baseline ✅
- `engines.vscode`: `^1.95.0`; `@types/vscode`: `~1.95.0`.
  The tilde range matters: `^1.95.0` also matches 1.125.0, which would let code compile
  against APIs that do not exist in the declared baseline.
- TypeScript 5.x, `@types/node` matching the Node version shipped with VS Code 1.95.
- `tsconfig.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`,
  `"target": "ES2022"`, `"module": "Node16"`, `"moduleResolution": "Node16"`,
  `"sourceMap": true`, `outDir` `out`.

### 0.3 Bundling and scripts ✅
- Add `esbuild.js` producing a single CommonJS bundle at `dist/extension.js`,
  `external: ["vscode"]`, sourcemaps in dev, minify in production.
- `package.json` `main`: `./dist/extension.js`.
- Scripts: `compile`, `watch`, `package` (production bundle), `lint`, `typecheck`,
  `test:unit`, `test:integration`, `test` (runs both).
- Plus `compile:tests` (`tsc -p ./` into `out/`), because the test runners execute
  compiled JavaScript while `compile` produces the bundle. `lint` and the test scripts
  only become functional once steps 0.4 and 0.5 install their tooling.

### 0.4 Test harness ✅
- Unit tests: Mocha over compiled pure modules in `src/**/*.unit.test.ts`, no `vscode`
  import allowed. Add a lint rule or a test that fails if a unit test imports `vscode`.
- Integration tests: `@vscode/test-cli` + `@vscode/test-electron`, specs in
  `src/test/integration/**`, launched against a temporary user data dir.
- Add one trivial test of each kind so both runners are proven green.

### 0.5 Linting and formatting ✅
- ESLint with `typescript-eslint`, rules for: no floating promises, no unused vars,
  explicit module boundary types off, `curly`, `eqeqeq`.
- Add a custom check script `scripts/check-language.mjs` that fails when non-ASCII
  letters appear in `src/**`, `README.md`, `docs/**` or `package.json` (allowing a small
  explicit exception list, e.g. the em dash in the display name). This enforces the
  English-only rule mechanically.
- Add a check that `package.json` `dependencies` contains no LLM SDK: fail on any
  package matching `openai|anthropic|@google|langchain|llamaindex|cohere|mistral`.
- All three guards are wired into `npm run check` and were each verified to exit non-zero
  on a deliberate violation. The language check scans `AGENTS.md`, `CLAUDE.md`, `plan.md`
  and `.github/**` as well, and flags letters rather than symbols so that arrows, dashes
  and emoji stay allowed.

### 0.6 Runtime dependencies (keep the list minimal) ✅
- `cron-parser` — next-run computation with timezone support. Version 5 exposes
  `CronExpressionParser.parse(expression, { tz })`; the older `parseExpression` helper is
  gone, so follow the v5 API in phase 9.
- `cronstrue` — human-readable schedule descriptions for the UI.
- `proper-lockfile` — leader election lock file.
- Nothing else in `dependencies` without a note in `CONTRIBUTING.md` explaining why.

### 0.7 Continuous integration ✅
- GitHub Actions workflow `.github/workflows/ci.yml`: matrix on ubuntu + windows,
  steps `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`,
  `xvfb-run -a npm run test:integration` (Linux), `npm run package`.
- Run the language check and the dependency check from 0.5 in CI.

### 0.8 Repository hygiene
- `.gitignore` for `node_modules`, `out`, `dist`, `*.vsix`, `.vscode-test`.
- `LICENSE` (MIT unless the owner decides otherwise), `CHANGELOG.md` with an
  `## [Unreleased]` section.
- `.vscode/launch.json` and `tasks.json` for F5 debugging with the watch build.

## Exit criteria

- [ ] `npm run compile`, `npm run lint`, `npm run typecheck` all pass.
- [ ] `npm run test:unit` and `npm run test:integration` both run and pass.
- [ ] F5 opens an Extension Development Host with the extension activated and no errors.
- [ ] `npm run package` produces `dist/extension.js`.
- [ ] CI is green on a pull request.
- [ ] The language check fails on purpose when a non-English string is added (verified
      once, then reverted).

## Notes

- Do not add a webview toolchain. v1 has no custom UI styling.
- Keep the bundle free of Node-only APIs that break in remote/web hosts only if web
  support is ever considered; v1 targets desktop (`runScript` requires it) and should
  declare `"extensionKind": ["workspace"]` intent explicitly in phase 1.
