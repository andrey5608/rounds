import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { localDate, localTime } from '../state/time.js';
import type { RunRecord } from '../state/types.js';

/** Longest slug taken from an agent name. */
const MAX_SLUG_LENGTH = 60;

/**
 * Turns an agent name into something safe for a file name.
 *
 * Only ASCII letters, digits and dashes survive: the file lands in whatever folder the user
 * configured, on whatever file system they have, and a name with a slash or a colon in it fails
 * differently on every platform.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^ -~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'agent';
}

/** `YYYYMMDD-HHmmss` in the effective time zone, which is how the files sort. */
export function timestampFor(date: Date, timeZone?: string): string {
  const day = localDate(date, timeZone).replace(/-/g, '');
  const time = localTime(date, timeZone).replace(':', '');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${day}-${time}${seconds}`;
}

export interface ResultFileRequest {
  folder: string;
  agentName: string;
  startedAt: Date;
  timeZone?: string;
  /** Front matter values. */
  record: RunRecord;
  sourceItemIds: string[];
  truncated: boolean;
  /** The model output, or whatever text the run produced. */
  body: string;
}

export interface ResultWriterDependencies {
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  renameImpl?: (from: string, to: string) => Promise<void>;
  mkdirImpl?: (path: string) => Promise<void>;
  existsImpl?: (path: string) => Promise<boolean>;
}

function yamlValue(value: string | number | boolean | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  // Quote only what YAML would actually read as structure. A dash inside a value is
  // harmless — quoting every identifier that contains one turns the block into noise.
  const needsQuotes =
    value.length === 0 ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    value.includes(': ') ||
    value.includes(' #') ||
    /^\s|\s$/.test(value);
  return needsQuotes ? JSON.stringify(value) : value;
}

/** Builds the front matter block from a run record. */
export function renderFrontMatter(request: ResultFileRequest): string {
  const { record } = request;
  const lines = [
    '---',
    `agent: ${yamlValue(request.agentName)}`,
    `agentId: ${yamlValue(record.agentId)}`,
    `runId: ${yamlValue(record.id)}`,
    `model: ${yamlValue(record.modelId)}`,
    `mode: ${yamlValue(record.executionMode)}`,
    `trigger: ${yamlValue(record.trigger)}`,
    `startedAt: ${yamlValue(record.startedAt)}`,
    `finishedAt: ${yamlValue(record.finishedAt)}`,
    `status: ${yamlValue(record.status)}`,
    `sourceItems: [${request.sourceItemIds.map((id) => yamlValue(id)).join(', ')}]`,
    `toolCalls: [${record.toolCalls
      .map((call) => `{ name: ${yamlValue(call.name)}, allowed: ${call.allowed}, durationMs: ${call.durationMs} }`)
      .join(', ')}]`,
    `promptSource: ${yamlValue(record.promptResolution.source)}`,
  ];
  if (record.promptResolution.path !== undefined) {
    lines.push(`promptFile: ${yamlValue(record.promptResolution.path)}`);
  }
  lines.push(
    `usedPromptSnapshot: ${record.promptResolution.usedSnapshot}`,
    `truncated: ${request.truncated}`,
  );
  if (record.error) {
    lines.push(`errorCode: ${yamlValue(record.error.code)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Writes the result of a run.
 *
 * The file is the product of the whole run, so it is written the same way the state is: into a
 * temporary file in the same folder, then renamed into place. A half-written result that looks
 * complete is worse than no result at all.
 */
export class ResultWriter {
  constructor(private readonly dependencies: ResultWriterDependencies = {}) {}

  /** The path a result would take, avoiding names that already exist. */
  async resolvePath(request: ResultFileRequest): Promise<string> {
    const base = `${slugify(request.agentName)}-${timestampFor(request.startedAt, request.timeZone)}`;
    const exists = this.dependencies.existsImpl ?? defaultExists;

    let candidate = join(request.folder, `${base}.md`);
    let suffix = 2;
    while (await exists(candidate)) {
      candidate = join(request.folder, `${base}-${suffix}.md`);
      suffix += 1;
    }
    return candidate;
  }

  async write(request: ResultFileRequest): Promise<string> {
    const mkdirImpl = this.dependencies.mkdirImpl ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
    const writeFileImpl =
      this.dependencies.writeFileImpl ?? ((path, content) => writeFile(path, content, 'utf8'));
    const renameImpl = this.dependencies.renameImpl ?? ((from, to) => rename(from, to));

    await mkdirImpl(request.folder);
    const target = await this.resolvePath(request);
    const temporary = `${target}.tmp-${process.pid}`;
    const content = `${renderFrontMatter(request)}\n\n${request.body.trimEnd()}\n`;

    await writeFileImpl(temporary, content);
    await renameImpl(temporary, target);
    return target;
  }
}

async function defaultExists(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** First non-empty line of the output, which is what the history and the tree show. */
export function summarize(text: string, limit = 120): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.replace(/^#+\s*/, '').trim())
    .find((candidate) => candidate.length > 0);
  if (!line) {
    return 'The model returned no text.';
  }
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
