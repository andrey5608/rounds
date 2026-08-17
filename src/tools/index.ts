import { createListFilesTool } from './listFiles.js';
import { createReadFileTool } from './readFile.js';
import { ToolRegistry } from './registry.js';
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

export { ToolRegistry };
