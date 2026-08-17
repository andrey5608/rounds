# Phase 5 — Connectors

**Goal:** Jira and Git data sources behind provider-agnostic interfaces, returning
normalized items, with typed auth/network/config errors and a `ping()` used by setup.

**Depends on:** phase 2. Parallel with phases 3, 4, 7.

## Steps

### 5.1 HTTP client (`src/connectors/http.ts`) ✅
- Thin wrapper over `fetch` with: per-request timeout (default 20 s, `AbortController`),
  JSON helpers, `User-Agent: rounds/<version>`.
- **Host allowlist:** the request URL host must equal the configured Jira or Git base URL
  host. Redirects to a different host are rejected with `ConfigError`. This is how the
  "network calls limited to configured hosts" constraint is enforced mechanically.
- Retries: only on `429` and `5xx`, max 3 attempts, exponential backoff honouring
  `Retry-After`. `4xx` other than 429 never retries.
- Redirects are refused outright (`redirect: 'error'`) rather than followed and checked: a
  redirect is precisely how a request to an allowed host ends up somewhere else carrying the
  token.
- All request/response logging goes through the redacting logger, bodies truncated.

### 5.2 Error types (`src/connectors/errors.ts`) ✅
Implemented before the client, which depends on them.
- `AuthError` (401/403 → "token missing, expired or lacking scope"),
  `NetworkError` (DNS, timeout, connection reset, 5xx after retries),
  `RateLimitError` (429 with `retryAfter`),
  `ConfigError` (bad base URL, missing repo, invalid JQL, unexpected payload shape).
- Each carries `code`, English `message`, and optional `fixCommand`.

### 5.3 Normalized item model (`src/connectors/items.ts`) ✅
```ts
interface SourceItem {
  id: string;            // issue key or PR number
  title: string;
  url: string;
  updatedAt: string;
  body?: string;         // description / PR body
  extra: Record<string, string | number | undefined>;
}
interface FetchResult { items: SourceItem[]; truncated: boolean; cursor?: string; }
```
Both connectors produce this shape; placeholders (phase 6) and the result front matter
(phase 8) only know about `SourceItem`.

### 5.4 `JiraConnector` (`src/connectors/jira.ts`) ✅
- Interface: `ping()`, `search(jql, maxResults)`, `getIssue(key)`.
- REST search by JQL → normalized issues: key, summary, status, description, comments,
  links. Request only the fields that are used (`fields=` parameter) to keep payloads
  small.
- Support both cloud and self-hosted base URLs: build paths from the configured base URL
  without assuming a hostname; auth via `Authorization: Basic <email:token>` for cloud
  and `Bearer <token>` for self-hosted personal access tokens — decided by an explicit
  per-source `authScheme` field rather than by sniffing the URL.
- Pagination up to `maxResults`, `truncated: true` when more exist.
- Comments and links are fetched only when the agent's prompt actually references them
  (decided by the placeholder scan from phase 6) to avoid needless requests.

### 5.5 `GitConnector` (`src/connectors/git.ts`)
- Interface: `ping()`, `listPullRequests(repo, mode, cursor)`, `getDiff(repo, id)`.
- `mode`: `newPullRequests` (created after the cursor) and `updatedPullRequests`
  (updated after the cursor).
- Cursor is an ISO timestamp (plus a last-seen id for tie-breaking), persisted back into
  `agent.source.sinceCursor` **only after a successful run** so a failed run reprocesses
  the same window instead of skipping items.
- Diff fetching is lazy and capped (see phase 6 truncation rules); the connector returns
  raw unified diff text plus a `truncated` flag.
- Keep the implementation provider-agnostic: one `GitProvider` interface, one concrete
  REST implementation for v1, selected by a `provider` field on the source so a second
  provider is an added file, not a rewrite.

### 5.6 Connector factory and credential wiring (`src/connectors/factory.ts`)
- `createConnector(source, secrets, settings, logger)` resolves the base URL and the
  token, throwing `ConfigError` with a Fix action when either is missing.
- Base URLs live in settings-adjacent state (`baseUrlRef` on the source points at a named
  entry) so multiple agents can share one endpoint definition; tokens always come from
  `context.secrets`.

### 5.7 Tests
- Unit with recorded fixtures for: cloud and self-hosted Jira search payloads, PR list
  and diff payloads, `401`, `429` with `Retry-After`, `5xx` retry then success, malformed
  JSON, redirect to a foreign host (must be rejected).
- No test performs a real network call; CI blocks outbound requests in the test runner.

## Exit criteria

- [ ] `ping()` for both connectors is used by `rounds.checkSetup` and reports a typed
      error the user can act on.
- [ ] A JQL search returns normalized `SourceItem[]` with `truncated` handling.
- [ ] PR listing respects the cursor and only advances it after a successful run.
- [ ] Any request to a host other than the configured one fails closed.
- [ ] Tokens never appear in logs, errors or result files.
