#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol driver (no puppeteer needed).
 *
 *   node test/cdp.cjs <url> [waitMs] [screenshotPath] [evalAfterWait]
 *
 * Prints console messages, page errors and failed requests, then optionally
 * runs an expression and writes a screenshot. Used to verify the site.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_ = process.argv[2];
const WAIT = Number(process.argv[3] || 6000);
const SHOT = process.argv[4];
const EVAL = process.argv[5];
const PORT = 9333 + Math.floor(Math.random() * 200);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));

const WIDTH = Number(process.env.W || 1440);
const HEIGHT = Number(process.env.H || 1300);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    ...(process.env.EXTRA_FLAGS ? process.env.EXTRA_FLAGS.split('|').filter(Boolean) : []),
    'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
      if (list.length) { targets = list; break; }
    } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  if (!targets) throw new Error('chrome did not expose a debugging target');

  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  function send(method, params) {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
    return new Promise((resolve) => pending.set(msgId, resolve));
  }

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result || msg.error);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      logs.push(`[console.${msg.params.type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`[pageerror] ${d.text} ${d.exception && d.exception.description ? d.exception.description.split('\n')[0] : ''}`);
    } else if (msg.method === 'Log.entryAdded') {
      logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
    } else if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.status >= 400) logs.push(`[http ${r.status}] ${r.url}`);
    } else if (msg.method === 'Network.loadingFailed') {
      logs.push(`[netfail] ${msg.params.errorText} ${msg.params.type}`);
    }
  });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  if (EVAL) {
    const res = await send('Runtime.evaluate', {
      expression: EVAL, awaitPromise: true, returnByValue: true,
    });
    const out = res && res.result ? res.result.value : res;
    console.log('[eval]', typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    await sleep(700);
  }

  if (SHOT) {
    const viewportOnly = process.env.VIEWPORT_ONLY === '1';
    const shot = await send('Page.captureScreenshot', viewportOnly
      ? { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } }
      : { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`[shot] ${SHOT}`);
  }

  if (logs.length) console.log(logs.join('\n'));
  else console.log('[clean] no console output or page errors');

  ws.close();
  chrome.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
  process.exit(0);
})().catch((err) => { console.error('CDP FAILED', err); process.exit(1); });
