import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where result files go.
 *
 * Resolution order: the agent's own folder, then the `rounds.defaultOutputFolder` setting,
 * then a `results` folder inside the extension's global storage. The last one always works,
 * so a user who never configures anything still gets their results.
 */
export function resolveOutputFolder(options: {
  agentFolder?: string;
  settingFolder?: string;
  globalStorage: string;
}): string {
  return options.agentFolder ?? options.settingFolder ?? join(options.globalStorage, 'results');
}

export interface FolderProbe {
  ok: boolean;
  path: string;
  message: string;
}

/**
 * Checks that the folder exists and can be written to.
 *
 * Creating it is part of the check on purpose: "the folder does not exist" is not a problem
 * worth reporting when creating it is what the extension would do anyway. A folder that
 * cannot be written to is a real problem, and it is better found now than in the middle of
 * a run whose output is then lost.
 */
export async function probeOutputFolder(path: string): Promise<FolderProbe> {
  const probeFile = join(path, `.rounds-write-probe-${process.pid}`);
  try {
    await mkdir(path, { recursive: true });
    await writeFile(probeFile, 'probe', 'utf8');
    await rm(probeFile, { force: true });
    return { ok: true, path, message: `Results are written to ${path}.` };
  } catch (error) {
    await rm(probeFile, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path,
      message: `The result folder ${path} cannot be written to: ${String(error)}`,
    };
  }
}
