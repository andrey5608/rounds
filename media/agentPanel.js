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

    const skills = [];
    for (const box of form.querySelectorAll('input[type="checkbox"][id^="skill:"]')) {
      if (box.checked) {
        skills.push(box.id.slice('skill:'.length));
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
      skills: skills,
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
  let announced = false;
  function scheduleValidation() {
    // The extension holds the rules, so this waits for a pause in typing rather than sending a
    // message per keystroke.
    clearTimeout(timer);
    timer = setTimeout(() => {
      vscode.postMessage({ type: 'change', draft: readDraft() });
    }, 250);
  }

  /**
   * Shows the entries of one group that match what was typed.
   *
   * In the page, never through the extension: filtering is not an edit, so it must not mark the
   * agent changed and must not rebuild the form under the cursor.
   */
  function applyFilter(group, query) {
    const list = document.querySelector('.tools[data-group="' + group + '"]');
    if (!list) {
      return;
    }
    const needle = query.trim().toLowerCase();
    let shown = 0;
    for (const entry of list.querySelectorAll('.tool')) {
      const haystack = entry.getAttribute('data-search') || '';
      const matches = needle.length === 0 || haystack.indexOf(needle) !== -1;
      entry.classList.toggle('hidden', !matches);
      if (matches) {
        shown += 1;
      }
    }

    let empty = list.querySelector('.empty-filter');
    if (shown === 0) {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'empty-filter';
        list.appendChild(empty);
      }
      empty.textContent = 'Nothing matches "' + query.trim() + '".';
    } else if (empty) {
      empty.remove();
    }
    syncSelectAll(group);
  }

  document.addEventListener('input', (event) => {
    const filtered = event.target && event.target.getAttribute
      ? event.target.getAttribute('data-filter')
      : null;
    if (filtered) {
      applyFilter(filtered, event.target.value);
      return;
    }
    if (event.target && event.target.closest('#agent-form')) {
      if (!announced) {
        // Says "somebody is typing" straight away, so a repaint from elsewhere cannot land in the
        // gap before the debounced draft arrives.
        announced = true;
        vscode.postMessage({ type: 'touched' });
      }
      scheduleValidation();
    }
  });

  /**
   * Draws where the form stands, without rebuilding it.
   *
   * Rebuilding is what replaces the element being typed into, and a field that loses focus after
   * one character is worse than no validation at all. So the errors are applied in place.
   */
  function applyState(state) {
    const errors = (state && state.errors) || {};

    for (const wrapper of document.querySelectorAll('.field[data-error-key]')) {
      const key = wrapper.getAttribute('data-error-key');
      const message = errors[key];
      const control = wrapper.querySelector('input, select, textarea');
      let paragraph = wrapper.querySelector('p.error');

      wrapper.classList.toggle('invalid', Boolean(message));
      if (message) {
        if (!paragraph) {
          paragraph = document.createElement('p');
          paragraph.className = 'error';
          paragraph.id = key + '-error';
          paragraph.setAttribute('role', 'alert');
          wrapper.appendChild(paragraph);
        }
        paragraph.textContent = message;
        if (control) {
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', key + '-error');
        }
      } else {
        if (paragraph) {
          paragraph.remove();
        }
        if (control) {
          control.removeAttribute('aria-invalid');
          control.removeAttribute('aria-describedby');
        }
      }
    }

    const preview = document.getElementById('schedule-preview');
    if (preview) {
      preview.textContent = state && state.schedulePreview ? state.schedulePreview : '';
    }
    const save = document.getElementById('save');
    if (save) {
      save.disabled = !(state && state.canSave);
    }
  }

  for (const group of document.querySelectorAll('.tools[data-group]')) {
    syncSelectAll(group.getAttribute('data-group'));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'state') {
      applyState(message.state);
    }
  });

  /** Keeps a group's "Select all" honest: ticked, empty, or somewhere in between. */
  function syncSelectAll(group) {
    const box = document.getElementById('select-all-' + group);
    // Only what is on screen: with a filter applied, "select all" means the ones being shown, and
    // a box claiming otherwise would tick a hundred things somebody cannot see.
    const tools = document.querySelectorAll(
      '.tools[data-group="' + group + '"] .tool:not(.hidden) input[type="checkbox"]',
    );
    if (!box || tools.length === 0) {
      return;
    }
    let ticked = 0;
    for (const tool of tools) {
      if (tool.checked) {
        ticked += 1;
      }
    }
    box.checked = ticked === tools.length;
    box.indeterminate = ticked > 0 && ticked < tools.length;
  }

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.closest('#agent-form')) {
      return;
    }
    // The search box lives inside the form and fires `change` when it loses focus. Filtering is
    // not an edit, so treating it as one would mark the agent changed for looking at a list.
    if (target.getAttribute && target.getAttribute('data-filter')) {
      return;
    }

    // "Select all" is not a tool, so it never reaches the draft; it ticks the ones that are.
    const group = target.getAttribute('data-group');
    if (group) {
      for (const tool of document.querySelectorAll(
        '.tools[data-group="' + group + '"] .tool:not(.hidden) input[type="checkbox"]',
      )) {
        tool.checked = target.checked;
      }
      target.indeterminate = false;
      vscode.postMessage({ type: 'change', draft: readDraft() });
      return;
    }

    if (target.id && (target.id.indexOf('tool:') === 0 || target.id.indexOf('skill:') === 0)) {
      const owner = target.closest('.tools');
      if (owner) {
        syncSelectAll(owner.getAttribute('data-group'));
      }
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
