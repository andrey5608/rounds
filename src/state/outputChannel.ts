import * as vscode from 'vscode';

import type { LogSink } from './logger.js';

/** Name of the output channel, exactly as specified in plan.md. */
export const OUTPUT_CHANNEL_NAME = 'Rounds';

export interface OutputChannelSink extends LogSink {
  show(): void;
  dispose(): void;
}

/**
 * Creates the one output channel this extension owns.
 *
 * The channel is the only place log lines go: no `console`, which would end up in the
 * editor's own developer tools where users never look.
 */
export function createOutputChannelSink(): OutputChannelSink {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return {
    append: (line: string) => channel.appendLine(line),
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}
