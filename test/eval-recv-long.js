(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(150); } return false; };
  await waitFor(() => document.getElementById('byteCap').textContent !== '—', 8000);
  const p = document.getElementById('passRx'); p.value = 'harbor-lights'; p.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('micBtn').click();
  await sleep(1200);
  const got = await waitFor(() => document.querySelectorAll('#log li:not(.empty)').length > 0, 30000);
  const text = document.querySelector('#log li .msgText') ? document.querySelector('#log li .msgText').textContent : '';
  return JSON.stringify({ got, status: document.getElementById('statusText').textContent,
    chips: [...document.querySelectorAll('#chips span')].map(e => e.textContent + '|' + e.className).join(', '),
    len: text.length, text }, null, 1);
})()
