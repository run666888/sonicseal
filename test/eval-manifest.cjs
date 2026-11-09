// Minimal CDP probe: report the parsed web app manifest + installability errors.
// Usage: node test/eval-manifest.cjs https://example.com/
'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET = process.argv[2];
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + path.join(os.tmpdir(), 'dsh-cdp-manifest'),
  'about:blank',
], { stdio: 'ignore' });

(async () => {
  let list = [];
  for (let i = 0; i < 40 && !list.length; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      list = await res.json();
    } catch (_) { /* not up yet */ }
    if (!list.length) await sleep(250);
  }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Page.navigate', { url: TARGET });
  await sleep(4000);

  const man = await send('Page.getAppManifest');
  const parsed = man.parsed || {};
  console.log(JSON.stringify({
    manifestUrl: man.url,
    errors: man.errors,
    name: parsed.name,
    short_name: parsed.short_name,
    start_url: parsed.start_url,
    display: parsed.display,
    theme_color: parsed.theme_color,
    icons: (parsed.icons || []).map((i) => `${i.sizes} ${i.purpose || 'any'}`),
    installability: (man.installabilityErrors || []).map((e) => e.errorId),
  }, null, 1));

  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  chrome.kill();
  process.exit(1);
});
