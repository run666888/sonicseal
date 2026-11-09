(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(150); } return false; };
  await waitFor(() => document.getElementById('byteCap').textContent !== '—', 10000);
  document.querySelector('#tabs .tab[data-tab="recv"]').click();
  await sleep(400);
  const p = document.getElementById('passRx'); p.value = 'harbor-lights'; p.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('micBtn').click();
  const got = await waitFor(() => document.querySelectorAll('#log li:not(.empty)').length > 0, 30000);
  await sleep(600);
  const li = document.querySelector('#log li');
  const mt = li ? li.querySelector('.msgText') : null;
  return JSON.stringify({ got, status: document.getElementById('statusText').textContent,
    mic: document.getElementById('micLabel').textContent,
    tag: document.getElementById('sonarTag').textContent,
    chips: [...document.querySelectorAll('#chips span')].map(e => e.textContent),
    len: mt ? mt.textContent.length : 0,
    text: mt ? mt.textContent.slice(0, 60) : null }, null, 1);
})()
