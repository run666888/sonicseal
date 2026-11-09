(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
  const ready = await waitFor(() => document.getElementById('byteCap').textContent !== '—');
  const out = { ready };
  const ta = document.getElementById('plain');
  ta.value = 'The eagle lands at midnight. Bring the brass key.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pass').value = 'harbor-lights';
  document.getElementById('pass').dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  out.metaBefore = document.getElementById('sendMeta').textContent;
  document.getElementById('playBtn').click();
  await waitFor(() => document.querySelectorAll('#frameStrip i').length > 0, 15000);
  await sleep(600);
  out.status = document.getElementById('statusText').textContent;
  out.statusClass = document.getElementById('status').className;
  out.meta = document.getElementById('sendMeta').textContent;
  out.frames = [...document.querySelectorAll('#frameStrip i')].map(e => e.textContent);
  out.waveDrawn = (() => { const c = document.getElementById('wave'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, 40).data; let nz = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) nz++; return nz; })();
  return JSON.stringify(out, null, 1);
})()
