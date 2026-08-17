import * as vscode from 'vscode';

/** Identifier of the status bar item, exactly as specified in plan.md. */
export const STATUS_BAR_ITEM_ID = 'rounds.status';

export type StatusBarState =
  | { kind: 'disabled' }
  | { kind: 'needsSetup' }
  | { kind: 'idle'; nextRunAt?: Date; agentCount: number }
  | { kind: 'running'; agentName: string }
  | { kind: 'failed'; agentName: string };

function describe(state: StatusBarState): { text: string; tooltip: string } {
  switch (state.kind) {
    case 'disabled':
      return {
        text: '$(circle-slash) Rounds: off',
        tooltip: 'Scheduled runs are turned off. Agents can still be started manually.',
      };
    case 'needsSetup':
      return {
        text: '$(warning) Rounds: setup needed',
        tooltip: 'Run the Check Setup command to finish setting up Rounds.',
      };
    case 'running':
      return {
        text: `$(sync~spin) Rounds: running ${state.agentName}`,
        tooltip: `The agent "${state.agentName}" is running.`,
      };
    case 'failed':
      return {
        text: '$(error) Rounds: last run failed',
        tooltip: `The last run of "${state.agentName}" failed. Open the output for details.`,
      };
    case 'idle': {
      if (state.agentCount === 0) {
        return { text: '$(history) Rounds', tooltip: 'No agents yet.' };
      }
      if (!state.nextRunAt) {
        return {
          text: '$(history) Rounds',
          tooltip: `${state.agentCount} agent(s), none scheduled.`,
        };
      }
      const time = state.nextRunAt.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
      return {
        text: `$(history) Rounds: next ${time}`,
        tooltip: `${state.agentCount} agent(s). Next run at ${state.nextRunAt.toLocaleString()}.`,
      };
    }
  }
}

/**
 * The status bar entry.
 *
 * Runs are meant to be unobtrusive, so this is where their state is reported: no
 * notification for a successful run, just a quiet line in the status bar.
 */
export class RoundsStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      STATUS_BAR_ITEM_ID,
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = 'Rounds';
    this.item.command = 'rounds.showOutput';
    this.update({ kind: 'idle', agentCount: 0 });
    this.item.show();
  }

  update(state: StatusBarState): void {
    const { text, tooltip } = describe(state);
    this.item.text = text;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
