(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
  const out = {};
  out.ready = await waitFor(() => document.getElementById('byteCap').textContent !== '—', 10000);
  const cs = (id, prop) => getComputedStyle(document.getElementById(id))[prop];
  out.layout = { tabs: cs('tabs','display'), send: cs('panelSend','display'), recv: cs('panelRecv','display'),
                 dock: cs('sendDock','position'), scopeCss: cs('scope','height') };
  out.scopePx = [document.getElementById('scope').width, document.getElementById('scope').height];

  // type a key + play, waiting for the real audio to be built
  const p = document.getElementById('pass'); p.value = 'harbor-lights'; p.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('playBtn').click();
  out.playing = await waitFor(() => /发送|播放|秒/.test(document.getElementById('statusText').textContent), 12000);
  out.status = document.getElementById('statusText').textContent;
  out.frameChips = document.querySelectorAll('#frameStrip i').length;
  out.meta = document.getElementById('sendMeta').textContent;
  document.getElementById('playBtn').click();
  await sleep(300);

  // tab switch must re-measure the hidden canvas
  document.querySelector('#tabs .tab[data-tab="recv"]').click();
  await sleep(450);
  out.afterSwitch = { send: cs('panelSend','display'), recv: cs('panelRecv','display'),
                      scopePx: [document.getElementById('scope').width, document.getElementById('scope').height],
                      scopeCss: cs('scope','height') };
  const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  out.sw = { supported: 'serviceWorker' in navigator, registered: regs.length };
  const man = document.querySelector('link[rel=manifest]');
  out.manifest = man ? man.href.split('/').pop() : null;
  return JSON.stringify(out, null, 1);
})()
