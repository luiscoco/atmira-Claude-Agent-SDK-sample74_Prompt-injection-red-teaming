import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire, Module } from 'node:module';

// Exercise the actual adapter against a minimal editor API; the runtime is compiled by the test script.
test('VS Code adapter captures unsaved selection, requires review and rejects changed documents', async () => {
  const disposable = () => ({ dispose() {} });
  const uri = (value) => ({ scheme: value.split(':')[0], fsPath: '/workspace', toString: () => value });
  let text = 'hello world', version = 1, openPanel, receiver, disposePanel, diffCount = 0, applyCount = 0;
  const events = [];
  const document = { uri: uri('file:///workspace/greeting.js'), get version() { return version; }, getText: () => text, offsetAt: (offset) => offset, positionAt: (offset) => offset };
  const editor = { document, selection: { isEmpty: false, start: 6, end: 11 } };
  const panel = {
    webview: { asWebviewUri: (value) => value, postMessage: async (event) => events.push(event), onDidReceiveMessage: (callback) => { receiver = callback; return disposable(); } },
    onDidDispose: (callback) => { disposePanel = callback; }, dispose() { disposePanel?.(); },
  };
  const vscode = {
    Uri: { parse: uri, joinPath: (_base, name) => uri(`file:///extension/${name}`), from: ({ scheme, path, query }) => uri(`${scheme}:${path}?${query}`) },
    ViewColumn: { Beside: 2 },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { replace(target, range, replacement) { this.edit = { target, range, replacement }; } },
    commands: {
      registerCommand: (_name, callback) => { openPanel = callback; return disposable(); },
      executeCommand: async (name) => { assert.equal(name, 'vscode.diff'); diffCount++; },
    },
    window: { activeTextEditor: editor, onDidChangeActiveTextEditor: () => disposable(), createWebviewPanel() { this.activeTextEditor = undefined; return panel; }, showWarningMessage() {} },
    workspace: {
      isTrusted: true, getWorkspaceFolder: () => ({}), registerTextDocumentContentProvider: () => disposable(), openTextDocument: async () => document,
      applyEdit: async ({ edit }) => { applyCount++; text = text.slice(0, edit.range.start) + edit.replacement + text.slice(edit.range.end); version++; return true; },
    },
  };
  const require = createRequire(import.meta.url), originalLoad = Module._load;
  let extension;
  try {
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    extension = require('../ide-extension/extension.cjs');
  } finally { Module._load = originalLoad; }
  try {
    extension.activate({ subscriptions: [], extensionUri: uri('file:///extension'), globalStorageUri: uri('file:///storage') });
    await openPanel();
    assert.match(panel.webview.html, /default-src 'none'/);
    const start = () => receiver({ type: 'start', action: 'rewrite', mode: 'guided' });
    await start();
    const proposal = events.find((event) => event.type === 'proposal');
    assert.equal(proposal.proposal.snapshot.text, 'hello world');
    assert.equal(proposal.proposal.snapshot.start, 6);
    await receiver({ type: 'apply' }); assert.equal(applyCount, 0);
    assert.match(events.at(-1).message, /Review diff/);
    await receiver({ type: 'preview' }); assert.equal(diffCount, 1);
    await receiver({ type: 'apply' }); assert.equal(applyCount, 1);
    assert.equal(text, 'hello // Reviewed in Lesson 69.\nworld');
    await start(); await receiver({ type: 'preview' });
    text += '!'; version++;
    await receiver({ type: 'apply' }); assert.equal(applyCount, 1);
    assert.match(events.at(-1).message, /Document changed/);
    await receiver({ type: 'start', action: 'rewrite', mode: 'guided', cwd: '/forged' });
    assert.equal(events.at(-1).type, 'hostError');
    vscode.workspace.isTrusted = false;
    await receiver({ type: 'start', action: 'explain', mode: 'guided' });
    assert.match(events.at(-1).message, /trust/);
    vscode.workspace.isTrusted = true;
    const running = start(); panel.dispose(); const count = events.length;
    await running; assert.equal(events.length, count);
  } finally { panel.dispose(); extension.deactivate(); }
});
