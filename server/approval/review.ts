// GET only renders a page; inspection and decisions require the fragment credential in a POST body.
export const reviewPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review lesson 65 refund</title>
<style>body{font:18px system-ui;max-width:680px;margin:3rem auto;padding:1rem;background:#f8fafc;color:#172033}pre{white-space:pre-wrap;background:white;padding:1rem}button{font:inherit;padding:.7rem;margin:.5rem}p{line-height:1.6}</style></head><body>
<h1>Review fictional refund</h1><p>This link authorizes one exact request. Opening it does not approve anything. Anyone holding it can decide; this sample does not verify the reviewer's identity.</p>
<pre id="request">Loading request…</pre><button id="approve" disabled>Approve refund</button><button id="reject" disabled>Reject refund</button><p id="status" role="status"></p>
<script>
const params = new URLSearchParams(location.hash.slice(1));
const credential = {id: params.get('id'), token: params.get('token')};
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');
const approve = document.getElementById('approve'), reject = document.getElementById('reject');
async function post(path, body) {
 const response = await fetch('/api/c65/' + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result = await response.json(); if (!response.ok) throw new Error(result.message); return result;
}
post('inspect', credential).then(request => {
 document.getElementById('request').textContent = JSON.stringify(request, null, 2); approve.disabled = reject.disabled = false;
}).catch(error => {status.textContent = error.message;});
async function decide(value) {
 approve.disabled = reject.disabled = true;
 try {const result = await post('decision', {...credential, approve:value}); status.textContent = 'Decision recorded: ' + result.state + '. You may close this page.';}
 catch(error) {status.textContent = error.message;}
}
approve.onclick = () => decide(true); reject.onclick = () => decide(false);
</script></body></html>`;
