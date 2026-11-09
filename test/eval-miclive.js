(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
  await waitFor(() => document.getElementById('byteCap').textContent !== '—', 8000);
  const p = document.getElementById('passRx'); p.value = 'harbor-lights'; p.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('micBtn').click();
  await waitFor(() => document.querySelectorAll('#log li:not(.empty)').length > 0, 22000);
  await sleep(400);
  return JSON.stringify({
    status: document.getElementById('statusText').textContent,
    micLabel: document.getElementById('micLabel').textContent,
    sonar: document.getElementById('sonarTag').textContent,
    level: document.getElementById('levelBar').style.width,
    log: [...document.querySelectorAll('#log li')].map(li => li.textContent).join(' || '),
  }, null, 1);
})()
