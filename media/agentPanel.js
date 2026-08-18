// The agent panel's only script. It posts what the user clicked and does nothing else:
// every action is an existing rounds.* command, executed on the extension side.
(function () {
  const vscode = acquireVsCodeApi();

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-command]');
    if (button) {
      vscode.postMessage({ type: button.getAttribute('data-command') });
      return;
    }

    const link = target.closest('a[data-target]');
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: 'open', target: link.getAttribute('data-target') });
    }
  });
})();
