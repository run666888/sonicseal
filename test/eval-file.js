(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); } return false; };
  const setPass = (v) => { const p = document.getElementById('passRx'); p.value = v; p.dispatchEvent(new Event('input', { bubbles: true })); };
  const feed = async () => {
    const res = await fetch('/shots/fake-mic.wav');
    const bytes = await res.arrayBuffer();
    const file = new File([bytes], 'fake-mic.wav', { type: 'audio/wav' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  await waitFor(() => document.getElementById('byteCap').textContent !== '—', 8000);

  const out = {};
  setPass('harbor-lights');
  await feed();
  out.okWait = await waitFor(() => document.querySelectorAll('#log li:not(.empty)').length > 0, 12000);
  out.okStatus = document.getElementById('statusText').textContent;
  out.okLog = [...document.querySelectorAll('#log li')].map(li => li.className + ':' + li.textContent).join(' || ');

  document.getElementById('clearLog').click();
  await sleep(150);
  setPass('wrong-key');
  await sleep(500);
  await feed();
  out.badWait = await waitFor(() => document.querySelectorAll('#log li.err').length > 0, 12000);
  out.badStatus = document.getElementById('statusText').textContent;
  out.badLog = [...document.querySelectorAll('#log li')].map(li => li.className + ':' + li.textContent).join(' || ');
  out.chips = [...document.querySelectorAll('#chips span')].map(e => e.className + ':' + e.textContent);
  return JSON.stringify(out, null, 1);
})()
