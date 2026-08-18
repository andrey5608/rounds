// The agent panel's only script.
//
// It holds the draft — which is what the form controls already are — and posts it. It decides
// nothing: every rule is applied on the extension side by the same functions the unit tests call,
// and the errors come back to be drawn.
(function () {
  const vscode = acquireVsCodeApi();

  /** Reads the form into the shape the extension side expects. */
  function readDraft() {
    const form = document.getElementById('agent-form');
    if (!form) {
      return undefined;
    }
    const value = (id) => {
      const element = form.querySelector('#' + CSS.escape(id));
      return element ? element.value : undefined;
    };
    const checked = (id) => {
      const element = form.querySelector('#' + CSS.escape(id));
      return element ? element.checked : false;
    };

    const tools = [];
    for (const box of form.querySelectorAll('input[type="checkbox"][id^="tool:"]')) {
      if (box.checked) {
        tools.push(box.id.slice('tool:'.length));
      }
    }

    return {
      name: value('name'),
      enabled: checked('enabled'),
      executionMode: value('executionMode'),
      sourceKind: value('sourceKind'),
      endpointName: value('endpointName'),
      project: value('project'),
      repo: value('repo'),
      gitMode: value('gitMode'),
      jql: value('jql'),
      maxResults: value('maxResults'),
      promptSource: value('promptSource'),
      promptText: value('promptText'),
      promptFile: value('promptFile'),
      modelId: value('modelId'),
      tools: tools,
      schedule: value('schedule'),
      timezone: value('timezone'),
      runOnStartup: checked('runOnStartup'),
      missedRunPolicy: value('missedRunPolicy'),
      allowedTimeStart: value('allowedTimeStart'),
      allowedTimeEnd: value('allowedTimeEnd'),
      outputFolder: value('outputFolder'),
      maxExecutionsPerDay: value('maxExecutionsPerDay'),
    };
  }

  let timer;
  function scheduleValidation() {
    // The extension holds the rules, so this waits for a pause in typing rather than sending a
    // message per keystroke.
    clearTimeout(timer);
    timer = setTimeout(() => {
      vscode.postMessage({ type: 'change', draft: readDraft() });
    }, 250);
  }

  document.addEventListener('input', (event) => {
    if (event.target && event.target.closest('#agent-form')) {
      scheduleValidation();
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.closest('#agent-form')) {
      return;
    }
    // A select changes which fields exist, so it is worth a repaint rather than a validation.
    if (target.id === 'sourceKind' || target.id === 'promptSource' || target.id === 'executionMode') {
      vscode.postMessage({ type: 'reshape', draft: readDraft() });
      return;
    }
    scheduleValidation();
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-command]');
    if (button) {
      vscode.postMessage({ type: button.getAttribute('data-command'), draft: readDraft() });
      return;
    }

    const link = target.closest('a[data-target]');
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: 'open', target: link.getAttribute('data-target') });
    }
  });

  // Ctrl/Cmd+S saves, because a form in an editor tab is where that reflex lives.
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      vscode.postMessage({ type: 'save', draft: readDraft() });
    }
  });
})();
