const vscode = require('vscode');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const hosts = new Set();

exports.activate = function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('lesson69.openPanel', async () => {
    if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('Trust the workspace first.');
    const [{ EmbeddingHost }, { createLiveRunner }, { applyProposal }] = await Promise.all([
      import('./runtime/host.js'), import('./runtime/agent.js'), import('./runtime/protocol.js'),
    ]);
    const host = new EmbeddingHost(createLiveRunner(path.join(context.globalStorageUri.fsPath, 'agent')));
    hosts.add(host);
    let sourceEditor = vscode.window.activeTextEditor;
    const panel = vscode.window.createWebviewPanel('lesson69', 'Lesson 69 Agent', vscode.ViewColumn.Beside, {
      enableScripts: true, localResourceRoots: [context.extensionUri],
    });
    let proposal, reviewed = false, active = false, disposed = false, editing = false;
    // Webview focus can make activeTextEditor undefined. Keep the last real editor.
    const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') sourceEditor = editor;
    });
    const previews = new Map();
    const scheme = `lesson69-${randomUUID()}`;
    const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: (uri) => previews.get(uri.toString()) || '',
    });
    const nonce = randomBytes(24).toString('base64');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview.js'));
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);padding:16px}button,select{margin:4px;padding:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}button:disabled{opacity:.5}</style></head><body><h2>Embedded agent</h2><p>Select text in the editor. With no selection, the host captures the whole file (up to 24,000 characters).</p><label for="mode">Mode</label><select id="mode"><option value="guided">Guided · no API</option><option value="live">Live Haiku · billed</option></select><p>Live: selected text leaves this machine; two turns, $0.03 SDK threshold, 60-second deadline.</p><button id="explain">Explain</button><button id="rewrite">Propose rewrite</button><button id="cancel" disabled>Cancel</button><button id="preview" disabled>Review diff</button><button id="apply" disabled>Apply reviewed edit</button><button id="discard" disabled>Discard</button><p id="status" role="status" aria-live="polite">Ready</p><pre id="output"></pre><h3>Proposed replacement</h3><pre id="replacement"></pre><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const post = (message) => { if (!disposed) void panel.webview.postMessage(message); };
    const receiver = panel.webview.onDidReceiveMessage(async (message) => {
      try {
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid command.');
        if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
        if (message.type === 'cancel' && Object.keys(message).length === 1) { host.cancel(); return; }
        if (editing) throw new Error('An editor operation is already in progress.');
        if (message.type === 'discard' && Object.keys(message).length === 1 && !active) {
          proposal = undefined; reviewed = false; post({ type: 'cleared', message: 'Proposal discarded.' }); return;
        }
        if (['preview', 'apply'].includes(message.type) && Object.keys(message).length === 1) {
          if (active || !proposal) throw new Error('No completed proposal to review.');
          editing = true;
          try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(proposal.snapshot.uri));
            if (disposed) return;
            if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
            const current = { ...proposal.snapshot, version: document.version, text: document.getText() };
            const after = applyProposal(current, proposal);
            if (message.type === 'preview') {
              previews.clear();
              const beforeUri = vscode.Uri.from({ scheme, path: '/before.js', query: randomUUID() });
              const afterUri = vscode.Uri.from({ scheme, path: '/after.js', query: randomUUID() });
              previews.set(beforeUri.toString(), current.text); previews.set(afterUri.toString(), after);
              await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, 'Lesson 69: Review proposed edit');
              reviewed = true; post({ type: 'reviewed' }); return;
            }
            if (!reviewed) throw new Error('Open Review diff before applying.');
            // Recheck after the asynchronous document open. No await between this check and applyEdit.
            applyProposal({ ...current, version: document.version, text: document.getText() }, proposal);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(proposal.snapshot.start), document.positionAt(proposal.snapshot.end)), proposal.replacement);
            const applied = await vscode.workspace.applyEdit(edit);
            proposal = undefined; reviewed = false;
            post({ type: 'cleared', message: applied ? 'Applied. Use editor Undo to revert; save when ready.' : 'Editor rejected the edit. Run again.' }); return;
          } finally { editing = false; }
        }
        if (message.type !== 'start') throw new Error('Unknown command.');
        if (active) throw new Error('A run is already active.');
        const editor = sourceEditor;
        if (!editor || editor.document.uri.scheme !== 'file') throw new Error('Focus a local file editor before starting.');
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!folder) throw new Error('The document must belong to the trusted workspace.');
        const document = editor.document, text = document.getText();
        const start = editor.selection.isEmpty ? 0 : document.offsetAt(editor.selection.start);
        const end = editor.selection.isEmpty ? text.length : document.offsetAt(editor.selection.end);
        active = true; proposal = undefined; reviewed = false;
        try {
          await host.start(message, { uri: document.uri.toString(), version: document.version, text, start, end }, vscode.workspace.isTrusted, (event) => {
            if (event.type === 'proposal') proposal = event.proposal;
            post(event);
          });
        } finally { active = false; }
      } catch (error) { post({ type: 'hostError', message: error instanceof Error ? error.message : 'Host command failed.' }); }
    });
    panel.onDidDispose(() => { disposed = true; host.dispose(); hosts.delete(host); receiver.dispose(); provider.dispose(); editorListener.dispose(); previews.clear(); });
    context.subscriptions.push(panel, receiver, provider, editorListener);
  }));
};
exports.deactivate = function deactivate() { for (const host of hosts) host.dispose(); hosts.clear(); };
