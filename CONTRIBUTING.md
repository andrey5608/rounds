# Contributing to Rounds

Read [`AGENTS.md`](./AGENTS.md) first: it holds the rules that apply to every change, and several of
them are enforced by scripts that will fail your build. [`plan.md`](./plan.md) is the specification
and wins over anything written here.

## Getting the project running

```sh
npm ci
npm run watch          # esbuild in watch mode
# then press F5 to open an Extension Development Host
```

| Command | What it does |
| --- | --- |
| `npm run check` | The four guard scripts. Run this before anything else; it is fast. |
| `npm run lint` | ESLint with type-aware rules. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test:unit` | Mocha over the compiled output, no editor involved. |
| `npm run test:integration` | Builds the bundle and runs specs inside a real extension host. |
| `npm run package` | The production bundle. |

Run each one separately and look at its exit code. Chaining them with `&&` hides a failure behind
whatever ran next — that mistake has already been made once here.

## How the code is laid out

```
src/extension.ts     activation, the service container, command registration
src/state/           agent model, revisioned store, secrets, history, counters, logging
src/scheduler/       leader lock, claims, cron, the ticker
src/setup/           setup checks, consent gate, model catalog
src/connectors/      HTTP client, issue tracker, repository host, factory
src/agents/          prompt resolution, placeholders, the run pipeline, result writer
src/model/           language model gateway, the agentic loop, chat handoff
src/tools/           the tool registry and the v1 tools
src/ui/              tree view, commands, the wizard, status bar
```

Dependencies point one way: `ui` → `agents`/`scheduler` → `model`/`connectors`/`tools` → `state`.
Nothing imports upward. Anything that touches the editor API sits behind a small interface so the
logic underneath can be unit tested without an extension host — that is why the store takes a
`MementoLike`, the connectors take a `FetchLike`, the tools take a `FileFinder` and a
`ProcessRunner`, and the model lives behind a `LanguageModelGateway`.

## Adding a tool

A tool is one object. Everything about it — its schema, how it validates input, whether a given input
is allowed, and what it does — lives in that object, so adding one is a file plus a line.

1. Create `src/tools/<name>.ts` exporting a factory that returns a `RoundsTool<TInput>`:

   ```ts
   export function createThingTool(): RoundsTool<ThingInput> {
     return {
       name: 'doThing',
       description: 'English. The model reads this, and so does the user in the wizard.',
       inputSchema: { type: 'object', properties: { … }, required: […], additionalProperties: false },
       parseInput(raw) { /* throw ToolInputError with a message the model can act on */ },
       checkPermission(input, context) { /* { allowed: true } or { allowed: false, reason } */ },
       async execute(input, context) { /* { content, truncated, meta? } */ },
     };
   }
   ```

2. Register it in [`src/tools/index.ts`](./src/tools/index.ts). That is the one line.
3. Take side effects and I/O from `ToolContext` rather than importing them, so a test can supply
   them. Add the field to `ToolContext` if the tool needs something new.
4. Write unit tests with **hostile** inputs, not just correct ones: paths that climb out of the
   workspace, symbolic links, oversized data, arguments that would matter if a shell were involved.
   The existing tests in `src/test/unit/tools.unit.test.ts` and `readFileTool.unit.test.ts` show the
   shape.
5. Mention it in the README if a user has to configure anything for it.

Two rules the registry relies on. A refusal is **not** an exception: return
`{ allowed: false, reason }` and the reason is fed back to the model, which can then try something
else. And nothing a tool does may reach outside the workspace — that is not a guideline, it is the
property the deny list and the path resolution exist to guarantee.

## Adding a connector

1. Implement the port for the kind of source: `IssueTrackerConnector` or
   `RepositoryHostConnector`. Both are small on purpose.
2. Produce `SourceItem`s. Everything downstream — placeholders, the result front matter, the history
   — knows only that shape, which is what keeps a new source from touching every layer.
3. Map every failure to one of the four connector errors: `AuthError`, `NetworkError`,
   `RateLimitError`, `ConfigError`. They are split by what the user has to do about them, so a new
   failure mode belongs to whichever of those four answers "and now what?".
4. Go through `HttpClient`. It pins requests to the configured host and refuses redirects; a
   connector that calls `fetch` itself would quietly break the promise that the extension only talks
   to hosts the user configured.
5. Implement `ping()`: the setup check uses it to tell the user whether the host answers.
6. Add fixture-based tests. Recorded payloads only — the unit test runner replaces the global `fetch`
   with one that throws, so a test that forgets to inject one fails.
7. Register it in [`src/connectors/factory.ts`](./src/connectors/factory.ts) and offer it in the
   wizard's source step.

## Rules that will fail your build

`npm run check` enforces these, and CI runs it on Linux and Windows:

| Guard | Rule |
| --- | --- |
| `check-language.mjs` | Everything in the repository is written in English. Letters outside ASCII fail. |
| `check-dependencies.mjs` | No language model SDK may be declared. Models are reached only through the editor. |
| `check-unit-tests.mjs` | A unit test may not reach the `vscode` module, directly or through an import chain. |
| `check-consent-gate.mjs` | `selectChatModels` is called in one file only, and only commands, wizard steps and setup code may create a user action token. |

Also enforced by tests: no product name may appear in the extension name, a command title, a view
title or a setting key; the declared commands and settings must match the lists in the code; and the
tree's context values must match the menu `when` clauses.

## Runtime dependencies

Currently `cron-parser`, `cronstrue` and `proper-lockfile`. Adding another needs a reason recorded
here, because every dependency ends up inside the shipped bundle.

## Tests

- Pure logic goes in a unit test. Inject the clock (`FixedClock`), the file system, the process
  runner, the model — never wait for wall time and never touch a real network.
- Anything that genuinely needs `TreeItem`, `Uri` or `workspace` goes in an integration test.
- Build path expectations from `node:path` or assert on shape. Never hardcode POSIX separators, and
  inject a failure rather than provoking one through the operating system: CI runs on Windows and
  Linux, and both have caught tests that only held on a Mac.
- A test whose assertion cannot fail is worse than no test. If a value is compared against a
  re-implementation of the code under test, assert on the behaviour instead.

## Commits and pull requests

- English, imperative subject, and a body explaining *why* when it is not obvious.
- No `Co-Authored-By` trailers and no generated-by footers.
- Work on a branch; do not commit to `main`.
- When reality departs from the plan, update the relevant file in `docs/phases/` in the same commit.
  The phase documents record decisions, including the ones that turned out to be wrong.
