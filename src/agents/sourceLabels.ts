import type { GitProvider } from '../state/types.js';

export interface SourceVocabulary {
  /** What the host calls the half in front of the repository. */
  project: string;
  /** An example in that host's shape, for a placeholder. */
  example: string;
  /** One sentence for a validation message or a prompt line. */
  hint: string;
}

/**
 * Each host's own word for the same field.
 *
 * "Owner" is right for one provider out of three: Bitbucket Cloud calls it a workspace, a
 * self-hosted Bitbucket calls it a project key, and a personal Bitbucket project is written
 * `~user`. Somebody typing the right value for their host should not also have to guess the
 * shape Rounds wants, so the label is the one the host's own documentation uses.
 */
export function sourceVocabulary(provider: GitProvider): SourceVocabulary {
  switch (provider) {
    case 'bitbucketCloud':
      return {
        project: 'Workspace',
        example: 'my-workspace',
        hint: 'The workspace the repository belongs to.',
      };
    case 'bitbucketServer':
      return {
        project: 'Project key',
        example: 'ROUNDS',
        hint: 'The project key, in capitals. A personal project is written ~username.',
      };
    default:
      return {
        project: 'Owner',
        example: 'octo',
        hint: 'The user or organization the repository belongs to.',
      };
  }
}

/** How a repository is written when both halves appear in one line of text. */
export function formatRepository(project: string, repo: string): string {
  return `${project}/${repo}`;
}
