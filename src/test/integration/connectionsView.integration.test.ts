import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
  ConnectionsTreeDataProvider,
  connectionTooltip,
  describeConnection,
} from '../../ui/connectionsView.js';
import type { ConnectionsViewData } from '../../ui/connectionsView.js';
import type { EndpointConfig } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

const tracker: EndpointConfig = {
  name: 'tracker',
  kind: 'jira',
  baseUrl: 'https://tracker.invalid',
  authScheme: 'basic',
  username: 'alex@example.invalid',
  secretRef: 'ref-1',
};

const github: EndpointConfig = {
  name: 'github',
  kind: 'git',
  baseUrl: 'https://github.com',
  authScheme: 'bearer',
  secretRef: 'ref-2',
};

function data(endpoints: EndpointConfig[], withToken: string[] = []): ConnectionsViewData {
  return {
    state: {
      ...emptyState('2026-08-18'),
      endpoints: Object.fromEntries(endpoints.map((endpoint) => [endpoint.name, endpoint])),
    },
    withToken,
  };
}

describe('connections view', () => {
  it('lists connections by name', () => {
    const provider = new ConnectionsTreeDataProvider();
    provider.setData(data([github, tracker], ['tracker', 'github']));

    assert.deepEqual(
      provider.getChildren().map((node) => provider.getTreeItem(node).label),
      ['github', 'tracker'],
    );
  });

  it('says which host and which API without being opened', () => {
    assert.equal(describeConnection(github, true), 'github.com · GitHub');
    assert.equal(
      describeConnection({ ...github, baseUrl: 'https://bitbucket.org' }, true),
      'bitbucket.org · Bitbucket Cloud',
    );
    assert.equal(describeConnection(tracker, true), 'tracker.invalid · Jira');
  });

  it('marks a connection with no token, because it cannot work', () => {
    assert.match(describeConnection(github, false), /no token$/);
  });

  it('names the resolved API root in the tooltip, not only the base URL', () => {
    // The base URL is what somebody typed; the API root is what a request uses, and a wrong base
    // URL shows up there first.
    const tooltip = connectionTooltip(github, true);
    assert.match(tooltip.value, /https:\/\/api\.github\.com\//);
  });

  it('never shows the token, not even masked', () => {
    // Yes or no is the whole answer. A masked token still leaks its length, and there is no
    // question anybody answers by looking at one. (The asterisks below are markdown emphasis.)
    const tooltip = connectionTooltip(tracker, true);

    assert.match(tooltip.value, /Token stored: yes/);
    assert.ok(!/\*{3,}/.test(tooltip.value), 'nothing that looks like a masked secret');
    assert.ok(!/•{3,}/.test(tooltip.value));
  });

  it('keys its context values on the kind, so a menu cannot land on the wrong row', () => {
    const provider = new ConnectionsTreeDataProvider();
    provider.setData(data([tracker, github], ['tracker', 'github']));
    const [first, second] = provider.getChildren();

    assert.ok(first && second);
    assert.equal(provider.getTreeItem(first).contextValue, 'rounds.connection.git');
    assert.equal(provider.getTreeItem(second).contextValue, 'rounds.connection.jira');
  });

  it('shows a warning icon while a connection cannot authenticate', () => {
    const provider = new ConnectionsTreeDataProvider();
    provider.setData(data([github]));
    const [node] = provider.getChildren();

    assert.ok(node);
    const icon = provider.getTreeItem(node).iconPath as vscode.ThemeIcon;
    assert.equal(icon.id, 'warning');
  });

  it('reports the last check in the tooltip', () => {
    const tooltip = connectionTooltip(
      { ...github, lastCheck: { ok: false, message: 'the host refused the token', at: '2026-08-18T09:00:00.000Z' } },
      true,
    );
    assert.match(tooltip.value, /failed — the host refused the token/);
  });
});
