(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(150); } return false; };
  const out = { secure: window.isSecureContext, proto: location.protocol };
  out.ready = await waitFor(() => document.getElementById('byteCap').textContent !== '—', 12000);
  out.cap = document.getElementById('byteCap').textContent;
  document.querySelector('#tabs .tab[data-tab="recv"]').click();
  await sleep(400);
  const p = document.getElementById('passRx'); p.value = 'harbor-lights'; p.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('micBtn').click();
  const got = await waitFor(() => document.querySelectorAll('#log li:not(.empty)').length > 0, 34000);
  await sleep(500);
  const li = document.querySelector('#log li');
  const mt = li ? li.querySelector('.msgText') : null;
  out.got = got;
  out.status = document.getElementById('statusText').textContent;
  out.chips = [...document.querySelectorAll('#chips span')].map(e => e.textContent);
  out.len = mt ? mt.textContent.length : 0;
  out.head = mt ? mt.textContent.slice(0, 48) : null;
  const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  out.sw = regs.length ? regs[0].active ? 'active' : 'installing' : 'none';
  return JSON.stringify(out, null, 1);
})()
