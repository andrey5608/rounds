import { createListFilesTool } from './listFiles.js';
import { createReadFileTool } from './readFile.js';
import { ToolRegistry } from './registry.js';
import type { RoundsTool } from './registry.js';
import { createRunScriptTool } from './runScript.js';
import { createWriteFileTool } from './writeFile.js';

/**
 * The tools a new agent starts with.
 *
 * Reading, listing and writing: what it takes to look at the workspace and put the result
 * somewhere. A new agent with nothing ticked could only ever answer in one message, and the way
 * that shows up is a model saying it has no way to write a file — which is a worse first
 * experience than a checkbox somebody may untick.
 *
 * `runScript` is not here. It executes commands, it is gated by a whitelist the user fills in by
 * hand, and a default is not consent to that.
 */
export const DEFAULT_TOOLS = ['readFile', 'listFiles', 'writeFile'];

/**
 * Builds the registry.
 *
 * This is the one line a new tool has to be added to: write the tool, register it here, and it
 * appears in the wizard, in the model's tool list and in the audit trail without any other
 * change.
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createListFilesTool());
  registry.register(createWriteFileTool());
  registry.register(createRunScriptTool());
  return registry;
}

/**
 * The registry one run works with: the built-ins plus the tools other extensions report.
 *
 * Built per run rather than at activation, because extensions are installed, enabled and disabled
 * while a window is open. A list captured once offers the model a tool that may not be there any
 * more, and finding that out mid-run is worse than reading a short list again.
 */
export function createRunRegistry(external: readonly RoundsTool<unknown>[]): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of external) {
    // A collision is filtered out where the list is read; this keeps the invariant local anyway,
    // because "our permission checks win" is not a property to leave to a caller.
    if (!registry.get(tool.name)) {
      registry.register(tool);
    }
  }
  return registry;
}

export { ToolRegistry };
