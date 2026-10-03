/* Runs in the webview, with no Node APIs, SDK or credentials. */
const api = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
let runId, seq = 0, busy = false, pending = false, reviewed = false;
function controls() {
  for (const id of ['explain', 'rewrite', 'mode']) byId(id).disabled = busy;
  byId('cancel').disabled = !busy;
  byId('preview').disabled = busy || !pending;
  byId('discard').disabled = busy || !pending;
  byId('apply').disabled = busy || !pending || !reviewed;
}
for (const action of ['explain', 'rewrite']) byId(action).addEventListener('click', () => {
  busy = true; pending = false; reviewed = false; runId = undefined; seq = 0;
  byId('output').textContent = ''; byId('replacement').textContent = ''; byId('status').textContent = 'Starting…'; controls();
  api.postMessage({ type: 'start', action, mode: byId('mode').value });
});
for (const type of ['cancel', 'preview', 'apply', 'discard']) byId(type).addEventListener('click', () => api.postMessage({ type }));
window.addEventListener('message', ({ data }) => {
  if (data.type === 'hostError') { busy = false; byId('status').textContent = data.message; controls(); return; }
  if (data.type === 'reviewed') { reviewed = true; controls(); return; }
  if (data.type === 'cleared') { pending = false; reviewed = false; byId('replacement').textContent = ''; byId('status').textContent = data.message; controls(); return; }
  if (data.type === 'started') runId = data.runId;
  if (data.runId !== runId || data.seq <= seq) return;
  seq = data.seq;
  if (data.type === 'delta') byId('output').textContent += data.text;
  if (data.type === 'proposal') { pending = true; byId('replacement').textContent = data.proposal.replacement; }
  if (data.type === 'error') byId('status').textContent = data.message;
  if (data.type === 'done') { busy = false; byId('status').textContent += ` ${data.status}; reported cost $${data.costUsd.toFixed(5)}.`; }
  controls();
});
