import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.integration.test.js',
  version: 'stable',
  workspaceFolder: './src/test/fixtures/workspace',
  mocha: {
    ui: 'bdd',
    timeout: 30000,
  },
});
