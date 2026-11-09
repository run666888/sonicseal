(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); } return false; };
  await waitFor(() => document.getElementById('byteCap').textContent !== '—', 8000);
  const pass = document.getElementById('passRx');
  pass.value = 'harbor-lights';
  pass.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('micBtn').click();
  await sleep(1500);
  const started = document.getElementById('statusText').textContent;
  const got = await waitFor(() => document.querySelectorAll('#log li:not(.empty)').length > 0, 26000);
  const out = {
    started,
    status: document.getElementById('statusText').textContent,
    got,
    chips: [...document.querySelectorAll('#chips span')].map(e => e.textContent),
    sonar: document.getElementById('sonarTag').textContent,
    log: [...document.querySelectorAll('#log li')].map(li => li.textContent).join(' || '),
    contextRate: (window.AudioContext ? 'ok' : 'none'),
  };
  return JSON.stringify(out, null, 1);
})()
