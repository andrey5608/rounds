import { createListFilesTool } from './listFiles.js';
import { createReadFileTool } from './readFile.js';
import { ToolRegistry } from './registry.js';
import type { RoundsTool } from './registry.js';
import { createRunScriptTool } from './runScript.js';

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
