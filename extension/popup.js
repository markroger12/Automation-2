'use strict';

const $ = (id) => document.getElementById(id);

function render(s) {
  $('version').textContent = 'v' + s.version;
  $('server').value = s.serverOrigin || '';
  $('keyInfo').textContent = s.paired ? `Paired (key ${s.keyPrefix}…). Paste a new key only to re-pair.` : 'Not paired yet.';
  $('pause').textContent = s.paused ? 'Resume claims' : 'Pause new claims';
  const box = $('status');
  box.className = 'status';
  const lines = [];
  if (!s.paired) {
    box.classList.add('warn');
    lines.push('Paste the connection key from the dashboard (Settings → ChatGPT extension).');
  } else if (s.versionMessage) {
    box.classList.add('bad');
    lines.push(s.versionMessage);
  } else if (s.lastError) {
    box.classList.add('bad');
    lines.push('Problem: ' + s.lastError);
  } else {
    lines.push(s.lastHelloAt ? 'Connected to the dashboard.' : 'Connecting…');
  }
  if (s.loggedIn === false) lines.push('ChatGPT asks you to sign in — please sign in in a ChatGPT tab.');
  if (s.humanCheck) lines.push('ChatGPT shows a verification check — please complete it yourself.');
  if (s.paused || s.serverPaused) lines.push('New claims are paused' + (s.serverPaused ? ' from the dashboard.' : '.'));
  if (s.backoffUntil && new Date(s.backoffUntil) > new Date()) lines.push('Rate-limit backoff until ' + new Date(s.backoffUntil).toLocaleTimeString() + '.');
  if (s.outbox) lines.push(s.outbox + ' result(s) waiting to reach the dashboard.');
  if (s.warning) lines.push(s.warning);
  box.innerHTML = '';
  for (const l of lines) {
    const p = document.createElement('div');
    p.textContent = l;
    box.appendChild(p);
  }
  const tabs = $('tabs');
  tabs.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `Managed ChatGPT tabs: ${s.tabs.length}`;
  tabs.appendChild(title);
  const ul = document.createElement('ul');
  for (const t of s.tabs) {
    const li = document.createElement('li');
    li.textContent = `#${t.id} ${t.busy ? 'working' : t.ready ? 'idle' : 'loading'} — ${(t.url || '').replace('https://chatgpt.com', '') || '/'}`;
    ul.appendChild(li);
  }
  tabs.appendChild(ul);
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'popup-state' });
  if (s) render(s);
}

$('save').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'popup-save', serverOrigin: $('server').value, key: $('key').value.trim() || null });
  $('key').value = '';
  if (!res.ok) alert(res.error);
  await refresh();
});
$('test').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'popup-test' });
  alert(res.ok ? (res.versionOk ? 'Connected. Version OK.' : res.message) : 'Not connected: ' + res.error);
  await refresh();
});
$('pause').addEventListener('click', async () => {
  const s = await chrome.runtime.sendMessage({ type: 'popup-state' });
  await chrome.runtime.sendMessage({ type: 'popup-pause', paused: !s.paused });
  await refresh();
});
$('open').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'popup-open-tab' });
  await refresh();
});

void refresh();
setInterval(refresh, 3000);
