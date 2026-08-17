# Phase 7 — Tool registry and v1 tools

**Goal:** a registry where adding a tool means registering one object, plus the three v1
tools with JSON schemas, permission checks and audit records.

**Depends on:** phase 2. Parallel with phases 3, 4, 5.

## Steps

### 7.1 Registry (`src/tools/registry.ts`) ✅
```ts
interface RoundsTool<TInput> {
  name: string;                       // stable id, used in agent.tools
  description: string;                // English, shown to the model and in the wizard
  inputSchema: object;                // JSON schema
  parseInput(raw: unknown): TInput;   // validation, throws ToolInputError
  checkPermission(input: TInput, ctx: ToolContext): PermissionResult;
  execute(input: TInput, ctx: ToolContext): Promise<ToolOutput>;
}
```
- `registry.register(tool)`, `registry.get(name)`, `registry.list()`,
  `registry.toChatTools(enabledNames)` → `vscode.LanguageModelChatTool[]`.
- `ToolContext`: workspace folders, settings snapshot, logger scope, cancellation token,
  run id.
- `ToolOutput`: `{ content: string; truncated: boolean; meta?: Record<string, unknown> }`.
- Registration happens in one file (`src/tools/index.ts`) so the CONTRIBUTING recipe is
  literally "add a file, add one line here".

### 7.2 `readFile(path)` (`src/tools/readFile.ts`) ✅
- Resolve `path` against workspace folders only. Reject: absolute paths outside every
  workspace folder, `..` traversal after normalization, symlinks whose real path leaves
  the workspace (`fs.realpath` check), and paths matching a deny list
  (`.env*`, `*.pem`, `*.key`, `.git/**`, `**/node_modules/**` by default).
- Reject binary content (null-byte sniff) and files above the size cap; return a clear
  message instead of partial garbage. The size is checked before the file is read, so an
  enormous file never enters memory.
- Workspace folders are resolved through `realpath` as well before comparing. A test caught
  the alternative: on macOS `/var` is a link to `/private/var`, so comparing a real candidate
  path against an unresolved root refused every perfectly ordinary file under a temporary
  directory.
- A relative path is tried against every workspace folder and an existing file wins over one
  that merely could exist, which is what makes a second folder usable at all.

### 7.3 `listFiles(globPattern)` (`src/tools/listFiles.ts`) ✅
- Implemented with `vscode.workspace.findFiles(pattern, excludePattern, limit)`, reached
  through a `findFiles` function on the tool context. The editor's own search brings the user's
  exclude settings along, and the indirection keeps the tool unit testable without a host.
- Applies the same deny list, caps the result count (default 200) and reports truncation.
- Returns workspace-relative paths only, never absolute host paths.

### 7.4 `runScript(command, args, cwd)` (`src/tools/runScript.ts`) ✅
- Whitelist from `rounds.scriptWhitelist`. An entry declares the allowed command and,
  optionally, an argument pattern: `{ "command": "npm", "args": ["test", "run *"] }`.
  Nothing unlisted runs — an empty whitelist means the tool always denies.
- Execute with `child_process.spawn`, **`shell: false`**, arguments passed as an array so
  no shell interpolation is possible.
- `cwd` must resolve inside a workspace folder; default is the first workspace folder.
- Timeout (default 120 s) with process-tree kill; stdout/stderr captured and capped
  (default 100 000 characters, truncation marker appended); exit code returned.
- Environment is a copy of the parent env minus variables matching
  `token|secret|password|passwd|key|credential`.
- Arguments are matched **pairwise against the whitelist entry**, so a listed `npm test` does
  not also allow `npm test --something`. The setting carries worked examples in its description and in
  `examples`, and the README explains the matching rule — a whitelist nobody can write is a whitelist
  that stays empty. Shell metacharacters need no special handling as a
  result: `test; rm -rf /` is simply an argument that matches no pattern, and there is no shell
  to interpret it even if it did.

### 7.5 Permission results and denials ✅
- `PermissionResult` is `{ allowed: true }` or `{ allowed: false; reason: string }`.
- A denial is **not** an exception: it is fed back to the model as a tool result stating
  the denial reason in English, so the model can adapt. It is also recorded in the run
  record and logged at `info`.

### 7.6 Audit trail ✅
- Every call appends a `ToolCallRecord`: `{ name, inputSummary, allowed, durationMs,
  outputBytes, truncated, error? }`. `inputSummary` is redacted and length-capped.
- The result file front matter lists tool calls (phase 8) from these records.

### 7.7 Tests ✅
- Unit: path traversal attempts (`../`, symlink escape, absolute outside workspace),
  deny-list hits, binary and oversized files.
- Unit: whitelist matching — exact command, argument pattern match and mismatch, empty
  whitelist denies everything, attempted shell metacharacters are inert.
- Unit: timeout kill, output truncation, non-zero exit reporting.
- Unit: `toChatTools` shape matches `vscode.LanguageModelChatTool` expectations for the
  enabled subset only.
- 46 tests cover this phase, hostile inputs included: traversal, symlink escape, absolute paths
  outside the workspace, every deny-list pattern, binary and oversized files, shell
  metacharacters, an empty whitelist, extra arguments, and a working directory that climbs out.

## Exit criteria

- [x] Adding a new tool requires exactly one new file and one line in `src/tools/index.ts`,
      which is where the three v1 tools are registered.
- [x] No tool can read outside the workspace and no command outside the whitelist can run,
      proven by tests including hostile inputs. A denied command is never spawned: permission
      is checked before execution, and a test asserts the process runner was not called.
- [x] Denials are returned to the model as results, not thrown — as are bad inputs, unknown
      tool names and crashes inside a tool, so the model can always react.
- [x] Every call produces a `ToolCallRecord` with name, redacted input summary, whether it was
      allowed, duration, output size, truncation and any error. The run record collects them in
      phase 8.
